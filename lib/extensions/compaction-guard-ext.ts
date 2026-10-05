// @ts-nocheck
/**
 * G-SAP cache-preserving compaction Pi SDK Extension
 *
 * 三层防护，防 session 因上下文超限而死锁，同时避免 Pi SDK 原生
 * summarizer 走冷启动请求破坏 prompt cache- *
  *
  *
  *
  *
 * L2（非 hook，由 session-defaults.js 调大 reserveTokens 实现）：
  *
  *
 * - 不调用任何私有方法（不碰 _overflowRecoveryAttempted / _runAutoCompaction- * - 失败路径：hook 内部任何异常-cancel，本项目不回落到 Pi 原生 summarizer
 */

import { computeHardTruncation, estimatePreparationTokens, truncateTextHeadTail } from "../../core/compaction-utils.ts";
import {
  createCachePreservingCompactionResult,
  shouldHardTruncateCachePreservingCompaction,
  stripInlineMediaFromCompactionPreparation,
} from "../../core/session-compactor.ts";
import {
  normalizeProviderContextMessages,
  normalizeProviderPayload,
} from "../../core/provider-compat.ts";
import {
  ensureReasoningContentForToolCalls,
  isReasoningReplayUnavailable,
} from "../../core/provider-compat/reasoning-content-replay.ts";
import {
  CACHE_STRATEGIES,
  buildCacheStrategyMetadata,
} from "../llm/cache-strategy-contract.ts";
import {
  COMPACTION_MODES,
  normalizeCompactionMode,
} from "../../shared/compaction-mode.ts";
import { convertAgentMessagesToLlm } from "../pi-sdk/index.ts";
import { createModuleLogger } from "../debug-log.ts";
import { normalizeRequestThinkingLevel } from "../../core/session-thinking-level.ts";

const log = createModuleLogger("compaction-guard");

const DEFAULT_MAX_TOOL_RESULT_BYTES = 32 * 1024; // 32KB 鈮?8K token
const DEFAULT_HARD_TRUNCATE_THRESHOLD = 0.85;    // messagesToSummarize 超过 85% 窗口 -> 硬截断
function needsToolCallReasoningReplay(model) {
  const provider = typeof model?.provider === "string" ? model.provider.toLowerCase() : "";
  const baseUrl = typeof model?.baseUrl === "string"
    ? model.baseUrl.toLowerCase()
    : (typeof model?.base_url === "string" ? model.base_url.toLowerCase() : "");
  return provider === "zhipu" || baseUrl.includes("open.bigmodel.cn");
}

function hardTruncateFromPreparation(event, ctx, preparation) {
  const sm = ctx.sessionManager;
  const pathEntries = event.branchEntries || sm?.getBranch?.() || [];
  const keepRecentTokens = preparation.settings?.keepRecentTokens ?? 20_000;

  return {
    keepRecentTokens,
    pathEntries,
    truncation: computeHardTruncation(pathEntries, keepRecentTokens, {
      summary: "[由于对话过长且摘要请求本身会超限，早期对话历史已被硬截断（g-sap-cache-preserving-compaction）]",
      reason: "compaction-guard-hard-truncate",
    }),
  };
}

function readThinkingLevel(ctx) {
  try {
    const level = ctx?.getThinkingLevel?.();
    if (typeof level === "string") return level;
  } catch {
    // Older or stale extension contexts may not expose getThinkingLevel.
  }
  try {
    const level = ctx?.sessionManager?.buildSessionContext?.()?.thinkingLevel;
    return typeof level === "string" ? level : undefined;
  } catch {
    return undefined;
  }
}

function snapshotCacheKeyParams(snapshot, fallbackThinkingLevel) {
  const fallback = normalizeRequestThinkingLevel(fallbackThinkingLevel, "off");
  const normalizeParams = (params) => {
    const out = { ...(params || {}) };
    out.thinkingLevel = normalizeRequestThinkingLevel(out.thinkingLevel || fallback, "off");
    if (Object.prototype.hasOwnProperty.call(out, "reasoning")) {
      out.reasoning = normalizeRequestThinkingLevel(out.reasoning, "off");
    }
    return out;
  };
  if (snapshot?.cacheKeyParams && typeof snapshot.cacheKeyParams === "object" && !Array.isArray(snapshot.cacheKeyParams)) {
    return normalizeParams(snapshot.cacheKeyParams);
  }
  return normalizeParams({ thinkingLevel: fallback });
}

/**
  *
 * @param {number} [opts.maxToolResultBytes=32768] - L1 单条 tool_result text 字节上限
 * @param {number} [opts.hardTruncateThreshold=0.85] - L3 触发硬截断的窗口占比
 * @returns {(pi: object) => void}
 */
export function createCompactionGuardExtension(opts = {}) {
  const maxToolResultBytes = opts.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
  const hardTruncateThreshold = opts.hardTruncateThreshold ?? DEFAULT_HARD_TRUNCATE_THRESHOLD;
  const cacheCompactor = opts.cacheCompactor ?? createCachePreservingCompactionResult;
  const usageLedger = opts.usageLedger || null;
  const buildUsageContext = typeof opts.buildUsageContext === "function" ? opts.buildUsageContext : null;
  const buildSessionCacheSnapshot = typeof opts.buildSessionCacheSnapshot === "function"
    ? opts.buildSessionCacheSnapshot
    : null;
  const getCompactionMode = typeof opts.getCompactionMode === "function"
    ? opts.getCompactionMode
    : () => COMPACTION_MODES.AUTO;

  function readCompactionMode(event, ctx) {
    try {
      return normalizeCompactionMode(getCompactionMode({ event, ctx }));
    } catch (err) {
      log.warn(`[L3] compaction mode resolver failed, using auto: ${err?.message || err}`);
      return COMPACTION_MODES.AUTO;
    }
  }

  return function (pi) {
    //
    pi.on("tool_result", (event) => {
      try {
 // 错误返回保留完整，帮 debug
        if (event.isError) return undefined;
        if (!Array.isArray(event.content)) return undefined;

        let changed = false;
        const newContent = event.content.map((block) => {
          if (!block || block.type !== "text" || typeof block.text !== "string") return block;
          const res = truncateTextHeadTail(block.text, { maxBytes: maxToolResultBytes });
          if (!res.truncated) return block;
          changed = true;
          log.log(
            `[L1] tool_result text truncated: tool=${event.toolName || "?"} ` +
            `original=${res.originalBytes}B -> ${Buffer.byteLength(res.text, "utf8")}B`
          );
          return { ...block, text: res.text };
        });

        if (changed) return { content: newContent };
        return undefined;
      } catch (err) {
        log.warn(`[L1] tool_result hook error (passthrough): ${err?.message || err}`);
        return undefined;
      }
    });

 //
    pi.on("session_before_compact", async (event, ctx) => {
      try {
        const preparation = stripInlineMediaFromCompactionPreparation(event?.preparation);
        const model = ctx?.model;
        if (!preparation || !model) return { cancel: true };

        const compactionMode = readCompactionMode(event, ctx);
        if (compactionMode === COMPACTION_MODES.PI_COMPATIBLE) {
          log.log("[L3] pi-compatible compaction selected; falling through to Pi SDK native summarizer");
          return undefined;
        }

        const contextWindow = model.contextWindow ?? 0;
        if (contextWindow <= 0) return { cancel: true };

        const worstCaseLlmTokens = estimatePreparationTokens(preparation);
        const threshold = Math.floor(contextWindow * hardTruncateThreshold);

        if (worstCaseLlmTokens > threshold) {
          // The summary request is already over the window; hard-truncate instead.
          if (event.signal?.aborted) return { cancel: true };

          const { keepRecentTokens, truncation } = hardTruncateFromPreparation(event, ctx, preparation);

          if (!truncation) {
            log.warn(
              `[L3] hard-truncate unavailable: worstCaseLlmTokens=${worstCaseLlmTokens} ` +
              `threshold=${threshold} contextWindow=${contextWindow}`
            );
            return { cancel: true };
          }

          log.log(
            `[L3] preemptive hard-truncate: worstCaseLlmTokens=${worstCaseLlmTokens} ` +
            `> threshold=${threshold} (ctx=${contextWindow}), keep=${keepRecentTokens}`
          );

          return { compaction: truncation };
        }

        if (event.signal?.aborted) return { cancel: true };

        const thinkingLevel = normalizeRequestThinkingLevel(readThinkingLevel(ctx), "off");
        const reasoningLevel = typeof thinkingLevel === "string" && thinkingLevel !== "off" ? thinkingLevel : null;
        let reasoningReplay = "preserve";
        let cacheMetadataOverride = null;
        const builtContext = ctx.sessionManager?.buildSessionContext?.();
        const rawMessages = Array.isArray(preparation.messagesToSummarize)
          ? preparation.messagesToSummarize
          : [];
        let messages;
        try {
          messages = normalizeProviderContextMessages(rawMessages, model, {
            mode: "chat",
            reasoningLevel,
          });
          if (reasoningLevel && needsToolCallReasoningReplay(model)) {
            messages = ensureReasoningContentForToolCalls(messages, { providerLabel: "Zhipu" });
          }
        } catch (err) {
          if (!isReasoningReplayUnavailable(err)) throw err;
          reasoningReplay = "clear";
          cacheMetadataOverride = buildCacheStrategyMetadata({
            cacheStrategy: CACHE_STRATEGIES.CACHE_RECOVERY,
            cacheGroup: "compaction.history",
            templateVersion: "v1",
            strict: false,
            degradeReason: "reasoning_replay_unavailable",
          });
          messages = normalizeProviderContextMessages(rawMessages, model, {
            mode: "chat",
            reasoningLevel,
          });
          log.warn("[L3] cache recovery compaction: reasoning replay unavailable, historical thinking cleared for this compaction");
        }
        const systemPrompt = ctx.getSystemPrompt?.() || builtContext?.systemPrompt || "";
        const sessionPath = ctx.sessionManager?.getSessionFile?.() || null;
        const fit = shouldHardTruncateCachePreservingCompaction({
          preparation,
          model,
          systemPrompt,
          customInstructions: event.customInstructions,
          hardTruncateThreshold,
        });
        if (fit.shouldHardTruncate) {
          const { keepRecentTokens, truncation } = hardTruncateFromPreparation(event, ctx, preparation);
          if (!truncation) {
            log.warn(
              `[L3] hard-truncate unavailable for cache-preserving request: ` +
              `requestTokens=${fit.budget.totalTokens} threshold=${fit.threshold} contextWindow=${fit.contextWindow}`
            );
            return { cancel: true };
          }
          log.log(
            `[L3] cache-preserving request hard-truncate: requestTokens=${fit.budget.totalTokens} ` +
            `> threshold=${fit.threshold} (ctx=${fit.contextWindow}), keep=${keepRecentTokens}`
          );
          return { compaction: truncation };
        }

        // PI 1.x keeps configured providers, OAuth refresh, request headers and
        // endpoint overrides in ModelRuntime. The global compat completion path
        // does not carry that state. Use the session registry's runtime stream.
        const modelRegistry = ctx.modelRegistry;
        const streamFn = typeof modelRegistry?.streamSimple === "function"
          ? modelRegistry.streamSimple.bind(modelRegistry)
          : undefined;
        const auth = streamFn ? null : await modelRegistry?.getApiKeyAndHeaders?.(model);
        if (!streamFn && !auth?.ok) {
          log.warn(`[L3] model auth unavailable for cache-preserving compaction: ${auth?.error || model.id}`);
          return { cancel: true };
        }

        const sessionSnapshot = buildSessionCacheSnapshot
          ? buildSessionCacheSnapshot(sessionPath, {
            reason: "compaction.history",
            messages,
          })
          : null;

        const requestCacheKeyParams = cacheMetadataOverride
          ? {
            thinkingLevel: normalizeRequestThinkingLevel(thinkingLevel, "off"),
            reasoningReplay,
          }
          : snapshotCacheKeyParams(sessionSnapshot, thinkingLevel);
        const requestThinkingLevel = typeof requestCacheKeyParams.thinkingLevel === "string"
          ? normalizeRequestThinkingLevel(requestCacheKeyParams.thinkingLevel, "off")
          : normalizeRequestThinkingLevel(thinkingLevel, "off");
        const requestReasoningLevel = requestThinkingLevel !== "off" ? requestThinkingLevel : null;

        const buildCompactorRequest = ({
          requestMessages = messages,
          requestReplay = reasoningReplay,
          requestMetadataOverride = cacheMetadataOverride,
          requestKeyParams = requestCacheKeyParams,
          requestThinking = requestMetadataOverride ? thinkingLevel : requestThinkingLevel,
          requestReasoning = requestMetadataOverride ? reasoningLevel : requestReasoningLevel,
        } = {}) => ({
          preparation,
          model,
          systemPrompt,
          messages: requestMessages,
          tools: sessionSnapshot?.tools || [],
          sessionSnapshot,
          cacheKeyParams: requestKeyParams,
          cacheMetadataOverride: requestMetadataOverride,
          customInstructions: event.customInstructions,
          signal: event.signal,
          thinkingLevel: requestThinking,
          streamFn,
          streamOptions: {
            ...(auth ? { apiKey: auth.apiKey, headers: auth.headers } : {}),
            sessionId: ctx.sessionManager?.getSessionId?.(),
            onPayload: (payload, requestModel) => normalizeProviderPayload(payload, requestModel || model, {
              mode: "chat",
              reasoningLevel: requestReasoning,
              reasoningReplay: requestReplay,
            }),
          },
          convertToLlm: convertAgentMessagesToLlm,
          usageLedger,
          usageContext: buildUsageContext?.({ event, ctx, model }) || null,
        });

        async function retryWithClearedReasoningReplay(originalError) {
          if (!isReasoningReplayUnavailable(originalError) || reasoningReplay === "clear") {
            throw originalError;
          }
          const recoveryMetadata = buildCacheStrategyMetadata({
            cacheStrategy: CACHE_STRATEGIES.CACHE_RECOVERY,
            cacheGroup: "compaction.history",
            templateVersion: "v1",
            strict: false,
            degradeReason: "reasoning_replay_unavailable",
          });
          const recoveryMessages = normalizeProviderContextMessages(rawMessages, model, {
            mode: "chat",
            reasoningLevel,
          });
          const recoveryCacheKeyParams = {
            thinkingLevel: normalizeRequestThinkingLevel(thinkingLevel, "off"),
            reasoningReplay: "clear",
          };
          log.warn("[L3] cache recovery compaction: reasoning replay failed during request build, retrying with historical thinking cleared");
          return await cacheCompactor(buildCompactorRequest({
            requestMessages: recoveryMessages,
            requestReplay: "clear",
            requestMetadataOverride: recoveryMetadata,
            requestKeyParams: recoveryCacheKeyParams,
            requestThinking: thinkingLevel,
            requestReasoning: reasoningLevel,
          }));
        }

        let compaction;
        try {
          compaction = await cacheCompactor(buildCompactorRequest());
        } catch (err) {
          compaction = await retryWithClearedReasoningReplay(err);
        }

        log.log(
          `[L3] cache-preserving compaction: tokensBefore=${compaction.tokensBefore} ` +
          `firstKept=${compaction.firstKeptEntryId}`
        );
        return { compaction };
      } catch (err) {
        log.warn(`[L3] session_before_compact hook error (cancelled): ${err?.message || err}`);
        return { cancel: true };
      }
    });
  };
}
