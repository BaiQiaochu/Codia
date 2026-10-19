// @ts-nocheck
import { USAGE_RESERVATION } from "../lib/llm/usage-budget-guard.ts";
import {
  completeSimple,
  convertAgentMessagesToLlm,
  estimateTokens,
  prepareCompaction,
} from "../lib/pi-sdk/index.ts";
import { computeHardTruncation } from "./compaction-utils.ts";
import { stripAllInlineMediaForHistory } from "./message-sanitizer.ts";
import { buildSessionCacheSnapshot } from "./session-cache-snapshot.ts";
import { runSessionSnapshotSideTask } from "../lib/llm/session-snapshot-side-task-runner.ts";
import { buildCacheStrategyMetadata } from "../lib/llm/cache-strategy-contract.ts";
import { normalizeProviderContextMessages } from "./provider-compat.ts";
import {
  assertMemoryEvidenceEpoch,
  captureMemoryEvidenceEpoch,
  guardMemoryContext,
  memoryAgentDirFromSessionPath,
  memoryEvidenceEpochMarker,
} from "../lib/memory/prompt-guard.ts";

const DEFAULT_HARD_TRUNCATE_THRESHOLD = 0.85;
const COMPACTION_REQUEST_BUFFER_TOKENS = 1024;
const directCompactionsInProgress = new WeakSet();

function throwIfCompactionCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Compaction cancelled");
  error.name = "AbortError";
  throw error;
}

const PI_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const PI_UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const PI_TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the kept suffix]

Be concise. Focus on what's needed to understand the kept suffix.`;

function textBlock(text) {
  return { type: "text", text };
}

function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export function getCachePreservingCompactionMaxTokens(preparation) {
  return Math.max(512, Math.floor((preparation?.settings?.reserveTokens ?? 4096) * 0.8));
}

function getCachePreservingTurnPrefixMaxTokens(preparation) {
  return Math.max(256, Math.floor((preparation?.settings?.reserveTokens ?? 4096) * 0.5));
}

function buildPiSummaryPrompt({ preparation, customInstructions } = {}) {
  let basePrompt = preparation?.previousSummary
    ? PI_UPDATE_SUMMARIZATION_PROMPT
    : PI_SUMMARIZATION_PROMPT;
  basePrompt = `Codia cache-preserving compaction\n\n${basePrompt}`;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }
  if (!preparation?.previousSummary) return basePrompt;
  return `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n${basePrompt}`;
}

export function buildCachePreservingCompactionInstruction({ preparation, customInstructions } = {}) {
  return {
    role: "user",
    content: [textBlock(buildPiSummaryPrompt({ preparation, customInstructions }))],
    timestamp: Date.now(),
  };
}

function buildCachePreservingTurnPrefixInstruction() {
  return {
    role: "user",
    content: [textBlock(PI_TURN_PREFIX_SUMMARIZATION_PROMPT)],
    timestamp: Date.now(),
  };
}

export function stripInlineMediaFromCompactionPreparation(preparation) {
  if (!preparation || typeof preparation !== "object") return preparation;

  const messagesToSummarize = Array.isArray(preparation.messagesToSummarize)
    ? stripAllInlineMediaForHistory(preparation.messagesToSummarize)
    : null;
  const turnPrefixMessages = Array.isArray(preparation.turnPrefixMessages)
    ? stripAllInlineMediaForHistory(preparation.turnPrefixMessages)
    : null;

  const next = {};
  let changed = false;
  if (messagesToSummarize && messagesToSummarize.messages !== preparation.messagesToSummarize) {
    next.messagesToSummarize = messagesToSummarize.messages;
    changed = true;
  }
  if (turnPrefixMessages && turnPrefixMessages.messages !== preparation.turnPrefixMessages) {
    next.turnPrefixMessages = turnPrefixMessages.messages;
    changed = true;
  }

  return changed ? { ...preparation, ...next } : preparation;
}

function buildCachePreservingCompactionRequests({ preparation, customInstructions } = {}) {
  preparation = stripInlineMediaFromCompactionPreparation(preparation);
  const messagesToSummarize = Array.isArray(preparation?.messagesToSummarize)
    ? preparation.messagesToSummarize
    : [];
  const turnPrefixMessages = Array.isArray(preparation?.turnPrefixMessages)
    ? preparation.turnPrefixMessages
    : [];

  if (preparation?.isSplitTurn && turnPrefixMessages.length > 0) {
    const requests = [];
    if (messagesToSummarize.length > 0) {
      requests.push({
        kind: "history",
        messages: [
          ...messagesToSummarize,
          buildCachePreservingCompactionInstruction({ preparation, customInstructions }),
        ],
        maxTokens: getCachePreservingCompactionMaxTokens(preparation),
      });
    }
    requests.push({
      kind: "turn-prefix",
      messages: [
        ...turnPrefixMessages,
        buildCachePreservingTurnPrefixInstruction(),
      ],
      maxTokens: getCachePreservingTurnPrefixMaxTokens(preparation),
    });
    return requests;
  }

  return [{
    kind: "history",
    messages: [
      ...messagesToSummarize,
      buildCachePreservingCompactionInstruction({ preparation, customInstructions }),
    ],
    maxTokens: getCachePreservingCompactionMaxTokens(preparation),
  }];
}

function computeFileDetails(fileOps) {
  const read = fileOps?.read instanceof Set ? fileOps.read : new Set(fileOps?.read || []);
  const written = fileOps?.written instanceof Set ? fileOps.written : new Set(fileOps?.written || []);
  const edited = fileOps?.edited instanceof Set ? fileOps.edited : new Set(fileOps?.edited || []);
  const modified = new Set([...edited, ...written]);
  return {
    readFiles: [...read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function appendFileOperationContext(summary, details) {
  const sections = [];
  if (details.readFiles.length > 0) {
    sections.push(`<read-files>\n${details.readFiles.join("\n")}\n</read-files>`);
  }
  if (details.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${details.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return summary;
  return `${summary.trimEnd()}\n\n${sections.join("\n\n")}`;
}

function extractSummaryText(response) {
  return response?.content
    ?.filter((block) => block?.type === "text" && typeof block.text === "string")
    ?.map((block) => block.text)
    ?.join("\n")
    ?.trim();
}

function isErrorResponse(response) {
  return response?.stopReason === "error" || response?.stopReason === "aborted";
}

function cacheKeyParamsFromSnapshot(snapshot) {
  if (snapshot?.cacheKeyParams && typeof snapshot.cacheKeyParams === "object" && !Array.isArray(snapshot.cacheKeyParams)) {
    return snapshot.cacheKeyParams;
  }
  return null;
}

export function isStaleExtensionContextError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("This extension ctx is stale after session replacement or reload");
}

export const CACHE_PRESERVING_COMPACTION_EXTENSION_MISSING_MESSAGE =
  "Cache-preserving compaction extension is not installed for this session";

export function isMissingCachePreservingCompactionExtensionError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes(CACHE_PRESERVING_COMPACTION_EXTENSION_MISSING_MESSAGE);
}

function isRecoverableCachePreservingCompactionRuntimeError(error) {
  return isStaleExtensionContextError(error)
    || isMissingCachePreservingCompactionExtensionError(error);
}

export function estimateCachePreservingCompactionRequest({
  preparation,
  systemPrompt = "",
  customInstructions,
} = {}) {
  preparation = stripInlineMediaFromCompactionPreparation(preparation);
  const systemPromptTokens = estimateTextTokens(systemPrompt);
  const requests = buildCachePreservingCompactionRequests({ preparation, customInstructions })
    .map((request) => {
      const messageTokens = request.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
      const promptTokens = messageTokens + systemPromptTokens + COMPACTION_REQUEST_BUFFER_TOKENS;
      return {
        kind: request.kind,
        promptTokens,
        maxTokens: request.maxTokens,
        totalTokens: promptTokens + request.maxTokens,
        messageTokens,
        instructionTokens: 0,
        systemPromptTokens,
        bufferTokens: COMPACTION_REQUEST_BUFFER_TOKENS,
      };
    });
  const fallbackMaxTokens = getCachePreservingCompactionMaxTokens(preparation);
  const fallbackBudget = {
    kind: "history",
    promptTokens: systemPromptTokens + COMPACTION_REQUEST_BUFFER_TOKENS,
    maxTokens: fallbackMaxTokens,
    totalTokens: systemPromptTokens + COMPACTION_REQUEST_BUFFER_TOKENS + fallbackMaxTokens,
    messageTokens: 0,
    instructionTokens: 0,
    systemPromptTokens,
    bufferTokens: COMPACTION_REQUEST_BUFFER_TOKENS,
  };
  const budget = requests.reduce((max, current) => (
    current.totalTokens > max.totalTokens ? current : max
  ), fallbackBudget);
  return { ...budget, requests };
}

export function shouldHardTruncateCachePreservingCompaction({
  preparation,
  model,
  systemPrompt,
  customInstructions,
  hardTruncateThreshold = DEFAULT_HARD_TRUNCATE_THRESHOLD,
} = {}) {
  const contextWindow = model?.contextWindow ?? 0;
  const budget = estimateCachePreservingCompactionRequest({
    preparation,
    systemPrompt,
    customInstructions,
  });
  if (contextWindow <= 0) {
    return { shouldHardTruncate: true, budget, threshold: 0, contextWindow };
  }
  const threshold = Math.floor(contextWindow * hardTruncateThreshold);
  return {
    shouldHardTruncate: budget.totalTokens > threshold,
    budget,
    threshold,
    contextWindow,
  };
}

function hardTruncateCachePreservingCompaction(branchEntries, preparation, {
  reason = "cache-preserving-compaction-hard-truncate",
  summary = "由于对话过长且保留缓存的压缩请求本身会超出模型上下文窗口，早期对话历史已被硬截断。",
} = {}) {
  const keepRecentTokens = preparation?.settings?.keepRecentTokens ?? 20_000;
  return computeHardTruncation(branchEntries, keepRecentTokens, {
    summary,
    reason,
  });
}

function emitCompactionProgress(session, event) {
  session?._emit?.(event);
}

async function emitSessionCompactEvent(session, compactionEntryId, fromExtension) {
  const runner = session?.extensionRunner;
  if (!runner?.hasHandlers?.("session_compact")) return;
  const compactionEntry = session.sessionManager?.getEntry?.(compactionEntryId)
    || session.sessionManager?.getEntries?.()?.find((entry) => entry?.id === compactionEntryId);
  if (!compactionEntry) return;
  await runner.emit({
    type: "session_compact",
    compactionEntry,
    fromExtension,
  });
}

/** Stamp the source epoch, never the completion time: SDK projection drops details. */
export function withCompactionEvidenceEpoch(result, agentDir, memoryEvidenceEpoch) {
  if (!agentDir) return result;
  assertMemoryEvidenceEpoch(agentDir, memoryEvidenceEpoch);
  const existingEpoch = result.details?.memoryEvidenceEpoch;
  if (existingEpoch) {
    assertMemoryEvidenceEpoch(agentDir, existingEpoch);
    // A caller may have captured the revocation epoch before transformContext
    // added retrieved evidence. Never widen that result's expiry on return.
    memoryEvidenceEpoch = { ...memoryEvidenceEpoch,
      expiresAt: [memoryEvidenceEpoch.expiresAt, existingEpoch.expiresAt].filter(Boolean).sort()[0] || null };
  }
  const marker = memoryEvidenceEpochMarker(memoryEvidenceEpoch);
  return {
    ...result,
    summary: result.summary.startsWith(marker) ? result.summary : `${marker}\n${result.summary}`,
    details: { ...result.details, memoryEvidenceEpoch },
  };
}

export async function appendCompactionResultToSession(session, result, { fromExtension = true, agentDir = null } = {}) {
  const memoryAgentDir = session.sessionManager?.__memoryAgentDir || agentDir || memoryAgentDirFromSessionPath(session.sessionManager?.getSessionFile?.());
  if (memoryAgentDir) {
    // The coordinator's hard-truncate placeholder is built synchronously and
    // contains no derived evidence. Other unversioned summaries fail closed.
    if (!result.details?.memoryEvidenceEpoch && result.details?.reason === "model-switch-truncation") {
      result = withCompactionEvidenceEpoch(result, memoryAgentDir, captureMemoryEvidenceEpoch(memoryAgentDir));
    }
    assertMemoryEvidenceEpoch(memoryAgentDir, result.details?.memoryEvidenceEpoch);
  }
  const compactionEntryId = session.sessionManager.appendCompaction(
    result.summary,
    result.firstKeptEntryId,
    result.tokensBefore,
    result.details,
    fromExtension,
  );
  replaceSessionMessages(session);
  await emitSessionCompactEvent(session, compactionEntryId, fromExtension);
  return result;
}

export async function createCachePreservingCompactionResult({
  preparation,
  model,
  systemPrompt,
  messages,
  tools = [],
  sessionSnapshot = null,
  sessionPath = null,
  agentDir = null,
  memoryEvidenceEpoch = null,
  cacheKeyParams = {},
  cacheMetadataOverride = null,
  customInstructions,
  signal,
  thinkingLevel,
  streamFn,
  streamOptions = {},
  convertToLlm = convertAgentMessagesToLlm,
  usageLedger,
  usageContext,
}) {
  if (!preparation) throw new Error("Cache-preserving compaction requires preparation");
  if (!model) throw new Error("Cache-preserving compaction requires a model");
  const sourceSessionPath = sessionPath || sessionSnapshot?.sessionPath || usageContext?.attribution?.sessionPath || "";
  const memoryAgentDir = agentDir || memoryAgentDirFromSessionPath(sourceSessionPath);
  // Capture before any await, including conversion and provider authentication.
  let sourceEpoch = null;
  if (memoryAgentDir) {
    if (memoryEvidenceEpoch) assertMemoryEvidenceEpoch(memoryAgentDir, memoryEvidenceEpoch);
    const observedEpoch = captureMemoryEvidenceEpoch(memoryAgentDir, {
      messages: [
        ...(preparation.messagesToSummarize || []), ...(preparation.turnPrefixMessages || []), ...(messages || []),
        ...(preparation.previousSummary ? [{ role: "compactionSummary", summary: preparation.previousSummary }] : []),
      ],
    });
    sourceEpoch = memoryEvidenceEpoch ? { ...memoryEvidenceEpoch,
      expiresAt: [memoryEvidenceEpoch.expiresAt, observedEpoch.expiresAt].filter(Boolean).sort()[0] || null } : observedEpoch;
    assertMemoryEvidenceEpoch(memoryAgentDir, sourceEpoch);
  }
  preparation = stripInlineMediaFromCompactionPreparation(preparation);
  const rawMessagesToSummarize = Array.isArray(preparation.messagesToSummarize)
    ? preparation.messagesToSummarize
    : [];
  let effectivePreparation = Array.isArray(messages)
    && (rawMessagesToSummarize.length === 0 || messages.length === rawMessagesToSummarize.length)
    ? { ...preparation, messagesToSummarize: messages }
    : preparation;
  if (memoryAgentDir) {
    const history = effectivePreparation.messagesToSummarize || [];
    const prefix = effectivePreparation.turnPrefixMessages || [];
    const previous = effectivePreparation.previousSummary
      ? [{ role: "compactionSummary", summary: effectivePreparation.previousSummary }]
      : [];
    const guarded = guardMemoryContext({ systemPrompt, messages: [...history, ...prefix, ...previous] }, memoryAgentDir);
    systemPrompt = guarded.systemPrompt;
    effectivePreparation = {
      ...effectivePreparation,
      messagesToSummarize: guarded.messages.slice(0, history.length),
      turnPrefixMessages: guarded.messages.slice(history.length, history.length + prefix.length),
      ...(previous.length ? { previousSummary: guarded.messages.at(-1).summary } : {}),
    };
  }
  const seedCacheKeyParams = !cacheMetadataOverride
    ? (cacheKeyParamsFromSnapshot(sessionSnapshot) || cacheKeyParams)
    : cacheKeyParams;
  const effectiveCacheKeyParams = {
    ...seedCacheKeyParams,
    thinkingLevel: seedCacheKeyParams.thinkingLevel ?? thinkingLevel ?? "off",
  };
  const effectiveThinkingLevel = !cacheMetadataOverride && typeof effectiveCacheKeyParams.thinkingLevel === "string"
    ? effectiveCacheKeyParams.thinkingLevel
    : thinkingLevel;
  const requests = buildCachePreservingCompactionRequests({ preparation: effectivePreparation, customInstructions });

  async function runRequest(request) {
    const rawLlmMessages = await convertToLlm(request.messages);
    throwIfCompactionCancelled(signal);
    if (memoryAgentDir) assertMemoryEvidenceEpoch(memoryAgentDir, sourceEpoch);
    const llmMessages = normalizeProviderContextMessages(rawLlmMessages, model, {
      mode: "chat",
      reasoningLevel: effectiveThinkingLevel,
    });
    const suffixMessage = llmMessages[llmMessages.length - 1];
    const prefixMessages = llmMessages.slice(0, -1);
    const options = {
      ...streamOptions,
      maxTokens: request.maxTokens,
      signal,
      toolChoice: "none",
      ...(model.reasoning && effectiveThinkingLevel && effectiveThinkingLevel !== "off" ? { reasoning: effectiveThinkingLevel } : {}),
    };

    if (cacheMetadataOverride) {
      const context = {
        systemPrompt,
        messages: llmMessages,
      };
      const metadata = buildCacheStrategyMetadata(cacheMetadataOverride);
      const usageRequest = usageLedger?.start?.({
        model: { ...model, modelId: model?.id ?? null },
        maxOutputTokens: request.maxTokens,
        usageContext,
        metadata,
        costRates: model?.cost,
      }) || null;
      if (usageRequest) options[USAGE_RESERVATION] = { ledger: usageLedger, requestId: usageRequest.requestId };
      let response;
      try {
        response = streamFn
          ? await (await streamFn(model, context, options)).result()
          : await completeSimple(model, context, options);
      } catch (error) {
        if (usageRequest?.requestId) usageLedger?.recordError?.(usageRequest.requestId, error);
        throw error;
      }
      if (isErrorResponse(response)) {
        const error = new Error(`Cache-preserving compaction failed: ${response.errorMessage || response.stopReason || "unknown error"}`);
        if (usageRequest?.requestId) usageLedger?.recordError?.(usageRequest.requestId, error, "error", { usage: response?.usage });
        throw error;
      }
      usageLedger?.finish?.(usageRequest?.requestId, {
        usage: response?.usage,
        model: { provider: model?.provider ?? null, modelId: model?.id ?? null, api: model?.api ?? null },
        costRates: model?.cost,
      });
      return extractSummaryText(response);
    }

    const snapshotForRequest = buildSessionCacheSnapshot({
      sessionPath: sourceSessionPath,
      reason: request.kind === "turn-prefix" ? "compaction.turn_prefix" : "compaction.history",
      model,
      cacheKeyParams: effectiveCacheKeyParams,
      systemPrompt,
      // Compaction side-tasks intentionally run with toolChoice=none and no tools.
      // Reusing a parent session snapshot that contains tools breaks strict cache hashes.
      tools: [],
      messages: prefixMessages,
    });
    const sideTask = await runSessionSnapshotSideTask({
      snapshot: snapshotForRequest,
      model,
      cacheKeyParams: effectiveCacheKeyParams,
      suffixMessage,
      streamFn,
      options,
      cacheGroup: request.kind === "turn-prefix" ? "compaction.turn_prefix" : "compaction.history",
      templateVersion: "v1",
      usageLedger,
      usageContext,
      includeTools: false,
    });

    const text = sideTask.text;
    if (!text) {
      throw new Error("Cache-preserving compaction failed: empty summary");
    }
    return text;
  }

  let text;
  if (preparation.isSplitTurn && Array.isArray(preparation.turnPrefixMessages) && preparation.turnPrefixMessages.length > 0) {
    const historyRequest = requests.find((request) => request.kind === "history");
    const turnPrefixRequest = requests.find((request) => request.kind === "turn-prefix");
    const [historyText, turnPrefixText] = await Promise.all([
      historyRequest ? runRequest(historyRequest) : Promise.resolve("No prior history."),
      turnPrefixRequest ? runRequest(turnPrefixRequest) : Promise.resolve(""),
    ]);
    text = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixText}`;
  } else {
    text = await runRequest(requests[0]);
  }

  throwIfCompactionCancelled(signal);
  const details = computeFileDetails(preparation.fileOps);
  return withCompactionEvidenceEpoch({
    summary: appendFileOperationContext(text, details),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details,
  }, memoryAgentDir, sourceEpoch);
}

function replaceSessionMessages(session) {
  session.refreshContext();
}

export async function runCachePreservingCompactionForSession(session, {
  settings,
  model = session?.model,
  customInstructions,
  signal,
  hardTruncateThreshold = DEFAULT_HARD_TRUNCATE_THRESHOLD,
  emitLifecycle = false,
  lifecycleReason = "manual",
  usageLedger,
  usageContext,
} = {}) {
  if (!session?.sessionManager) throw new Error("runCachePreservingCompactionForSession: missing session manager");
  if (!session?.agent) throw new Error("runCachePreservingCompactionForSession: missing agent");
  if (!model) throw new Error("runCachePreservingCompactionForSession: missing model");

  const compactionSettings = settings || session.settingsManager?.getCompactionSettings?.();
  if (!compactionSettings) throw new Error("runCachePreservingCompactionForSession: missing compaction settings");

  if (session.isCompacting === true || directCompactionsInProgress.has(session)) {
    throw new Error("runCachePreservingCompactionForSession: compaction already in progress for this session");
  }
  directCompactionsInProgress.add(session);

  try {
    const sessionPath = session.sessionManager.getSessionFile?.() || usageContext?.attribution?.sessionPath || "";
    const memoryAgentDir = session.sessionManager?.__memoryAgentDir || memoryAgentDirFromSessionPath(sessionPath);
    const branchEntries = session.sessionManager.getBranch();
    if (emitLifecycle) {
      emitCompactionProgress(session, { type: "compaction_start", reason: lifecycleReason });
    }
    throwIfCompactionCancelled(signal);
    const preparation = prepareCompaction(branchEntries, compactionSettings);
    if (!preparation) {
      const lastEntry = branchEntries[branchEntries.length - 1];
      if (lastEntry?.type === "compaction") throw new Error("Already compacted");
      throw new Error("Nothing to compact (session too small)");
    }

    const sourceEpoch = memoryAgentDir ? captureMemoryEvidenceEpoch(memoryAgentDir, {
      messages: [
        ...(session.agent.state?.messages || []),
        ...(preparation.messagesToSummarize || []), ...(preparation.turnPrefixMessages || []),
        ...(preparation.previousSummary ? [{ role: "compactionSummary", summary: preparation.previousSummary }] : []),
      ],
    }) : null;
    const systemPrompt = session.agent.state?.systemPrompt ?? session.systemPrompt;
    const fit = shouldHardTruncateCachePreservingCompaction({
      preparation,
      model,
      systemPrompt,
      customInstructions,
      hardTruncateThreshold,
    });
    if (fit.shouldHardTruncate) {
      const truncation = hardTruncateCachePreservingCompaction(branchEntries, preparation);
      if (!truncation) {
        throw new Error(
          `Cache-preserving compaction request exceeds model window ` +
          `(${fit.budget.totalTokens} > ${fit.threshold}) and hard truncation is unavailable`
        );
      }
      const guardedTruncation = withCompactionEvidenceEpoch(truncation, memoryAgentDir, sourceEpoch);
      const result = await appendCompactionResultToSession(session, guardedTruncation, { fromExtension: true, agentDir: memoryAgentDir });
      if (emitLifecycle) {
        emitCompactionProgress(session, {
          type: "compaction_end",
          reason: lifecycleReason,
          result,
          aborted: false,
          willRetry: false,
        });
      }
      return result;
    }

    const sourceMessages = Array.isArray(session.agent.state?.messages)
      ? session.agent.state.messages
      : [];
    const transformedMessages = typeof session.agent.transformContext === "function"
      ? await session.agent.transformContext(sourceMessages, signal)
      : sourceMessages;
    throwIfCompactionCancelled(signal);

    const result = await createCachePreservingCompactionResult({
      sessionPath,
      agentDir: memoryAgentDir,
      memoryEvidenceEpoch: sourceEpoch,
      preparation,
      model,
      systemPrompt,
      messages: transformedMessages,
      customInstructions,
      signal,
      thinkingLevel: session.thinkingLevel ?? session.agent.state?.thinkingLevel,
      tools: session.agent.state?.tools || [],
      cacheKeyParams: {
        thinkingLevel: session.thinkingLevel ?? session.agent.state?.thinkingLevel ?? "off",
      },
      streamFn: session.agent.streamFunction ?? session.agent.streamFn,
      streamOptions: {
        sessionId: session.agent.sessionId,
        onPayload: session.agent.onPayload,
        onResponse: session.agent.onResponse,
        transport: session.agent.transport,
        thinkingBudgets: session.agent.thinkingBudgets,
        maxRetryDelayMs: session.agent.maxRetryDelayMs,
      },
      convertToLlm: session.agent.convertToLlm,
      usageLedger,
      usageContext,
    });

    throwIfCompactionCancelled(signal);
    const saved = await appendCompactionResultToSession(session, result, { fromExtension: true, agentDir: memoryAgentDir });
    if (emitLifecycle) {
      emitCompactionProgress(session, {
        type: "compaction_end",
        reason: lifecycleReason,
        result: saved,
        aborted: false,
        willRetry: false,
      });
    }
    return saved;
  } catch (error) {
    if (emitLifecycle) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = signal?.aborted || message === "Compaction cancelled" || error?.name === "AbortError";
      emitCompactionProgress(session, {
        type: "compaction_end",
        reason: lifecycleReason,
        result: undefined,
        aborted,
        willRetry: false,
        errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
      });
    }
    throw error;
  } finally {
    directCompactionsInProgress.delete(session);
  }
}

export async function compactSessionWithCachePreservation(session, customInstructions) {
  if (session && directCompactionsInProgress.has(session)) {
    throw new Error("compactSessionWithCachePreservation: compaction already in progress for this session");
  }
  session?.extensionRunner?.assertActive?.();
  if (!session?.extensionRunner?.hasHandlers?.("session_before_compact")) {
    throw new Error(CACHE_PRESERVING_COMPACTION_EXTENSION_MISSING_MESSAGE);
  }
  return await session.compact(customInstructions);
}

export async function compactSessionWithCachePreservationRecoveringRuntime({
  session,
  sessionPath,
  customInstructions,
  reloadSessionRuntime,
  onRuntimeReload,
}: any) {
  try {
    const result = await compactSessionWithCachePreservation(session, customInstructions);
    return { result, session, recovered: false };
  } catch (error) {
    if (!isRecoverableCachePreservingCompactionRuntimeError(error) || typeof reloadSessionRuntime !== "function") {
      throw error;
    }
    const reloadedSession = await reloadSessionRuntime(sessionPath);
    if (!reloadedSession) throw error;
    await onRuntimeReload?.({ error, session: reloadedSession });
    const result = await compactSessionWithCachePreservation(reloadedSession, customInstructions);
    return { result, session: reloadedSession, recovered: true };
  }
}
