// @ts-nocheck
/**
 * AgentExecutor runs temporary multi-turn sessions through the long-lived agent
 * instance owned by the engine. ChannelRouter and DmRouter share this executor.
 */

import fs from "fs";
import path from "path";
import { createAgentSession, SessionManager } from "../lib/pi-sdk/index.ts";
import { debugLog } from "../lib/debug-log.ts";
import { t } from "../lib/i18n.ts";
import { createDefaultSettings } from "../core/session-defaults.ts";
import { teardownSessionResources } from "../core/session-teardown.ts";
import {
  filterAgentPhoneTools,
  getAgentPhoneActiveToolNames,
  getAgentPhonePermissionMode,
  getAgentPhoneSessionDir,
  shouldCompactAgentPhoneSession,
  shouldReuseAgentPhoneSession,
} from "../lib/conversations/agent-phone-session.ts";
import {
  ensureAgentPhoneProjection,
  updateAgentPhoneProjectionMeta,
} from "../lib/conversations/agent-phone-projection.ts";
import {
  readAgentPhoneRuntime,
  resolveAgentPhoneRuntimeSessionPath,
  updateAgentPhoneRuntime,
} from "../lib/conversations/agent-phone-runtime.ts";
import { findModel, requireModelRef } from "../shared/model-ref.ts";
import {
  buildFreshCompactMetaPatch,
  buildFreshCompactSnapshot,
  shouldRunFreshCompact,
} from "../lib/fresh-compact/policy.ts";
import {
  buildSessionPromptSnapshot,
  createPromptSnapshotResourceLoader,
  normalizeSessionPromptSnapshot,
} from "../core/session-prompt-snapshot.ts";
import { stripClosedInternalNarrationBlocks } from "../lib/text/internal-narration.ts";

function resolveAgentPhoneModel(engine, ctx, agentConfig, modelOverride) {
  if (!modelOverride) return ctx.resolveModel(agentConfig);
  const ref = requireModelRef(modelOverride);
  const found = findModel(engine.availableModels || [], ref.id, ref.provider);
  if (!found) {
    throw new Error(`Agent phone model override not available: ${ref.provider}/${ref.id}`);
  }
  return found;
}

function isAgentPhoneEnabled(engine) {
  return engine?.isChannelsEnabled?.() !== false;
}

function buildAgentPhonePromptSnapshot(agent, ctx, systemPrompt) {
  return buildSessionPromptSnapshot({
    systemPrompt,
    appendSystemPrompt: ctx.resourceLoader?.getAppendSystemPrompt?.() || [],
    skillsResult: ctx.getSkillsForAgent?.(agent),
    agentsFilesResult: ctx.resourceLoader?.getAgentsFiles?.(),
  });
}

function mergeToolNames(...groups) {
  return [...new Set(
    groups
      .flat()
      .filter((name) => typeof name === "string" && name.length > 0),
  )];
}

export function mergeCustomToolsWithOverrides(baseTools = [], overrideTools = []) {
  const byName = new Map();
  const unnamed = [];
  for (const tool of Array.isArray(baseTools) ? baseTools : []) {
    if (!tool?.name) {
      unnamed.push(tool);
      continue;
    }
    byName.set(tool.name, tool);
  }
  for (const tool of Array.isArray(overrideTools) ? overrideTools : []) {
    if (!tool?.name) {
      unnamed.push(tool);
      continue;
    }
    byName.set(tool.name, tool);
  }
  return [...byName.values(), ...unnamed];
}

function assertAgentPhoneEnabled(engine) {
  if (!isAgentPhoneEnabled(engine)) {
    throw new Error("Agent phone is disabled");
  }
}

/**
 * Runs an isolated session as the specified agent.
 *
 * @param {string} agentId
  *
 * @param {object} opts
 * @param {import('../core/engine.ts').CodiaEngine} opts.engine
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.sessionSuffix="temp"]
 * @param {string} [opts.systemAppend] text appended to the system prompt
 * @param {boolean} [opts.keepSession=false] whether to keep the session file
 * @param {boolean} [opts.noMemory=false] use only personality, without memory
 * @param {boolean} [opts.noTools=false] disable tools
 * @param {boolean} [opts.readOnly=false] allow only read-oriented tools
 * @returns {Promise<string>} captured response text with transient mood blocks removed
 */
export async function runAgentSession(agentId, rounds, { engine, signal, sessionSuffix = "temp", ephemeralDir, systemAppend, keepSession = false, noMemory = false, noTools = false, readOnly = false } = {}) {
  // Resolve the long-lived agent instance.
  const agent = engine.getAgent(agentId);
  if (!agent) {
    throw new Error(t("error.agentExecNotInit", { id: agentId }));
  }
  const agentDir = agent.agentDir;

  // Build a temporary resource loader for the isolated session.
  const ctx = engine.createSessionContext();
  const tempResourceLoader = Object.create(ctx.resourceLoader);

  // noMemory mode uses only the agent personality.
  const basePrompt = noMemory ? agent.personality : agent.systemPrompt;
  tempResourceLoader.getSystemPrompt = () =>
    systemAppend ? `${basePrompt}\n\n${systemAppend}` : basePrompt;
  tempResourceLoader.getSkills = () => ctx.getSkillsForAgent(agent);

  // Create the temporary session.
  const cwd = engine.getHomeCwd(agentId) || process.cwd();
  const sessionDir = ephemeralDir || path.join(agentDir, "sessions", sessionSuffix);
  fs.mkdirSync(sessionDir, { recursive: true });
  const tempSessionMgr = SessionManager.create(cwd, sessionDir);

  // Tool mode: noTools disables the schema entirely. Read-only keeps the full
  // schema and lets permission wrappers reject mutations at execution time.
  let tools, customTools;
  if (noTools) {
    tools = [];
    customTools = [];
  } else {
    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot({ forceMemoryEnabled: agent.memoryMasterEnabled !== false })
      : agent.tools;
    const built = ctx.buildTools(cwd, agentToolsSnapshot, {
      agentDir,
      workspace: engine.getHomeCwd(agentId),
      getSessionPath: () => tempSessionMgr?.getSessionFile?.() || null,
      getPermissionMode: () => readOnly ? "read_only" : "ask",
    });
    tools = built.tools;
    customTools = built.customTools;
  }
  const model = ctx.resolveModel(agent.config);
  const { session } = await createAgentSession({
    cwd,
    sessionManager: tempSessionMgr,
    settingsManager: createDefaultSettings(),
    modelRuntime: ctx.modelRuntime,
    model,
    thinkingLevel: "medium",
    resourceLoader: tempResourceLoader,
    tools,
    customTools,
  });

  // Attach AbortSignal to the Pi session.
  let onAbort;
  if (signal) {
    onAbort = () => { try { session.abort(); } catch {} };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  // Capture text deltas only for rounds marked capture=true.
  let capturedText = "";
  let isCapturing = false;
  const unsub = session.subscribe((event) => {
    if (!isCapturing) return;
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") capturedText += sub.delta || "";
    }
  });

  debugLog()?.log("agent-executor", `${agentId} session started (${rounds.length} rounds)`);

  try {
    for (const round of rounds) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      isCapturing = !!round.capture;
      if (round.capture) capturedText = "";
      await session.prompt(round.text);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    await teardownSessionResources({
      session,
      unsub,
      label: `hub.runAgentSession[${agentId}]`,
      warn: (msg) => debugLog()?.warn("agent-executor", msg),
    });
  }

  // Remove the temporary session file unless callers need it for persistence.
  if (!keepSession) {
    const sessionPath = session.sessionManager?.getSessionFile?.();
    if (sessionPath) {
      try { fs.unlinkSync(sessionPath); } catch {}
    }
  }

  // 7. Strip closed transient narration blocks from the captured response.
  const text = stripClosedInternalNarrationBlocks(capturedText);

  debugLog()?.log("agent-executor", `${agentId} done, ${text.length} chars captured`);
  return text;
}

function storedRelativePath(agentDir, filePath) {
  return path.relative(agentDir, filePath).split(path.sep).join("/");
}

async function maybeCompactPhoneSession(session, { isActive = false, onActivity } = {}) {
  if (typeof session.getContextUsage !== "function" || typeof session.compact !== "function") return null;
  const usage = session.getContextUsage?.() ?? null;
  const reason = shouldCompactAgentPhoneSession({
    tokens: usage?.tokens,
    isActive,
  });
  if (!reason) return null;
  if (session.isCompacting) return null;

  await onActivity?.(
    "compacting",
    reason === "hard" ? "正在压缩手机会话（180K 硬上限）" : "正在空闲压缩手机会话",
    {
      reason,
      tokensBefore: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
    },
  );
  await session.compact();
  const after = session.getContextUsage?.() ?? null;
  await onActivity?.(
    "idle",
    "手机会话压缩完成",
    {
      reason,
      tokensBefore: usage?.tokens ?? null,
      tokensAfter: after?.tokens ?? null,
      contextWindow: after?.contextWindow ?? usage?.contextWindow ?? null,
    },
  );
  return { reason, before: usage, after };
}

async function maybeFreshCompactPhoneSession(session, {
  agentDir,
  agentId,
  conversationId,
  conversationType,
  runtime = {},
  snapshot,
  now = new Date(),
  reason: explicitReason = null,
  onActivity,
} = {}) {
  const decision = shouldRunFreshCompact({
    meta: runtime,
    snapshot,
    now,
    force: explicitReason === "manual",
  });
  if (!decision.run) return null;
  if (session.isCompacting) return null;

  const reason = explicitReason || decision.reason;
  const before = session.getContextUsage?.() ?? null;
  await onActivity?.(
    "compacting",
    reason === "daily" ? "正在按日刷新压缩手机会话" : "正在刷新压缩手机会话",
    {
      reason,
      tokensBefore: before?.tokens ?? null,
      contextWindow: before?.contextWindow ?? null,
    },
  );
  await session.compact();
  const after = session.getContextUsage?.() ?? null;
  const usage = {
    tokensBefore: before?.tokens ?? null,
    tokensAfter: after?.tokens ?? null,
    contextWindow: after?.contextWindow ?? before?.contextWindow ?? null,
  };
  const patch = buildFreshCompactMetaPatch({
    snapshot,
    reason,
    now,
    usage,
  });
  await updateAgentPhoneRuntime({
    agentDir,
    agentId,
    conversationId,
    conversationType,
    patch,
  });
  await onActivity?.(
    "idle",
    "手机会话刷新压缩完成",
    {
      reason,
      ...usage,
    },
  );
  return { reason, ...usage };
}

export async function freshCompactAgentPhoneSession(agentId, {
  engine,
  conversationId,
  conversationType = "channel",
  toolMode = "read_only",
  modelOverride = null,
  now = new Date(),
  reason = "daily",
  onActivity,
} = {}) {
  if (!conversationId) throw new Error("conversationId is required for agent phone fresh compact");
  assertAgentPhoneEnabled(engine);

  const agent = engine.getAgent(agentId);
  if (!agent) {
    throw new Error(t("error.agentExecNotInit", { id: agentId }));
  }
  const agentDir = agent.agentDir;
  await ensureAgentPhoneProjection({
    agentDir,
    agentId,
    conversationId,
    conversationType,
  });
  const runtime = readAgentPhoneRuntime(agentDir, conversationId);
  const existingSessionPath = resolveAgentPhoneRuntimeSessionPath(agentDir, runtime);
  if (!existingSessionPath || !fs.existsSync(existingSessionPath)) {
    throw new Error(`agent phone fresh compact: session file missing for ${conversationId}`);
  }

  const ctx = engine.createSessionContext();
  const tempResourceLoader = Object.create(ctx.resourceLoader);
  const basePrompt = agent.systemPrompt;
  tempResourceLoader.getSystemPrompt = () => basePrompt;
  tempResourceLoader.getSkills = () => ctx.getSkillsForAgent(agent);

  const cwd = engine.getHomeCwd(agentId) || process.cwd();
  const sessionDir = getAgentPhoneSessionDir(agentDir, conversationId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.open(existingSessionPath, sessionDir);

  const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
    ? agent.getToolsSnapshot({
      forceMemoryEnabled: agent.memoryMasterEnabled !== false,
      ...(typeof agent.experienceEnabled === "boolean"
        ? { forceExperienceEnabled: agent.experienceEnabled === true }
        : {}),
    })
    : agent.tools;
  const phonePermissionMode = getAgentPhonePermissionMode(toolMode);
  const built = ctx.buildTools(cwd, agentToolsSnapshot, {
    agentDir,
    workspace: engine.getHomeCwd(agentId),
    getSessionPath: () => sessionManager?.getSessionFile?.() || null,
    getPermissionMode: () => phonePermissionMode,
  });
  const { tools, customTools } = filterAgentPhoneTools(built);
  const model = resolveAgentPhoneModel(engine, ctx, agent.config, modelOverride);
  const { session } = await createAgentSession({
    cwd,
    sessionManager,
    settingsManager: createDefaultSettings(),
    modelRuntime: ctx.modelRuntime,
    model,
    thinkingLevel: "medium",
    resourceLoader: tempResourceLoader,
    tools,
    customTools,
  });
  session.setActiveToolsByName?.(getAgentPhoneActiveToolNames({ tools, customTools }));
  const unregisterPhoneAbort = engine.registerAgentPhoneAbortHandler?.(
    () => {
      try { session.abort?.(); } catch {}
    },
    { agentId, conversationId, conversationType, reason },
  ) || (() => {});

  const snapshot = buildFreshCompactSnapshot({
    systemPrompt: basePrompt,
    state: {
      conversationType,
      memoryEnabled: agent.memoryMasterEnabled !== false,
      model: modelOverride || agent.config?.models?.chat || null,
      toolMode,
    },
  });

  try {
    return await maybeFreshCompactPhoneSession(session, {
      agentDir,
      agentId,
      conversationId,
      conversationType,
      runtime,
      snapshot,
      now,
      reason,
      onActivity,
    });
  } finally {
    try { unregisterPhoneAbort(); } catch {}
    await teardownSessionResources({
      session,
      label: `hub.freshCompactAgentPhoneSession[${agentId}:${conversationId}]`,
      warn: (msg) => debugLog()?.warn("agent-executor", msg),
    });
  }
}

export async function runAgentPhoneSession(agentId, rounds, {
  engine,
  signal,
  conversationId,
  conversationType = "channel",
  systemAppend,
  noMemory = false,
  toolMode = "read_only",
  modelOverride = null,
  onActivity,
  onSessionReady,
  onEvent,
  emitEvents = false,
  extraCustomTools = [],
  returnDiagnostics = false,
  now = new Date(),
} = {}) {
  if (!conversationId) throw new Error("conversationId is required for agent phone session");
  assertAgentPhoneEnabled(engine);

  const agent = engine.getAgent(agentId);
  if (!agent) {
    throw new Error(t("error.agentExecNotInit", { id: agentId }));
  }
  const agentDir = agent.agentDir;
  await ensureAgentPhoneProjection({
    agentDir,
    agentId,
    conversationId,
    conversationType,
  });

  const ctx = engine.createSessionContext();
  const basePrompt = noMemory ? agent.personality : agent.systemPrompt;
  const currentSystemPrompt = systemAppend ? `${basePrompt}\n\n${systemAppend}` : basePrompt;

  const cwd = engine.getHomeCwd(agentId) || process.cwd();
  const sessionDir = getAgentPhoneSessionDir(agentDir, conversationId);
  fs.mkdirSync(sessionDir, { recursive: true });

  await ensureAgentPhoneProjection({
    agentDir,
    agentId,
    conversationId,
    conversationType,
  });
  const runtime = readAgentPhoneRuntime(agentDir, conversationId);
  const existingSessionPath = resolveAgentPhoneRuntimeSessionPath(agentDir, runtime);
  const refreshNow = now instanceof Date ? now : new Date(now);
  const existingSessionExists = !!(existingSessionPath && fs.existsSync(existingSessionPath));
  const openedExistingSession = shouldReuseAgentPhoneSession({
    meta: runtime,
    sessionExists: existingSessionExists,
    now: refreshNow,
  });
  const promptSnapshot = openedExistingSession
    ? (normalizeSessionPromptSnapshot(runtime.promptSnapshot)
      || buildAgentPhonePromptSnapshot(agent, ctx, currentSystemPrompt))
    : buildAgentPhonePromptSnapshot(agent, ctx, currentSystemPrompt);
  const tempResourceLoader = createPromptSnapshotResourceLoader(ctx.resourceLoader, promptSnapshot);
  const sessionManager = openedExistingSession && existingSessionPath
    ? SessionManager.open(existingSessionPath, sessionDir)
    : SessionManager.create(cwd, sessionDir);

  const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
    ? agent.getToolsSnapshot({
      forceMemoryEnabled: agent.memoryMasterEnabled !== false,
      ...(typeof agent.experienceEnabled === "boolean"
        ? { forceExperienceEnabled: agent.experienceEnabled === true }
        : {}),
    })
    : agent.tools;
  const phonePermissionMode = getAgentPhonePermissionMode(toolMode);
  const built = ctx.buildTools(cwd, agentToolsSnapshot, {
    agentDir,
    workspace: engine.getHomeCwd(agentId),
    getSessionPath: () => sessionManager?.getSessionFile?.() || null,
    getPermissionMode: () => phonePermissionMode,
  });
  const { tools, customTools } = filterAgentPhoneTools(built, { toolMode });
  const sessionCustomTools = mergeCustomToolsWithOverrides(customTools, extraCustomTools);
  const invocationCustomToolNames = getAgentPhoneActiveToolNames({
    customTools: Array.isArray(extraCustomTools) ? extraCustomTools : [],
  });
  const activeToolNames = mergeToolNames(
    getAgentPhoneActiveToolNames({ tools, customTools: sessionCustomTools }),
    invocationCustomToolNames,
  );
  const model = resolveAgentPhoneModel(engine, ctx, agent.config, modelOverride);
  const effectiveModel = {
    id: model?.id || null,
    provider: model?.provider || null,
    name: model?.name || model?.id || null,
  };
  const { session } = await createAgentSession({
    cwd,
    sessionManager,
    settingsManager: createDefaultSettings(),
    modelRuntime: ctx.modelRuntime,
    model,
    thinkingLevel: "medium",
    resourceLoader: tempResourceLoader,
    tools,
    customTools: sessionCustomTools,
  });
  session.setActiveToolsByName?.(activeToolNames);

  const sessionPath = session.sessionManager?.getSessionFile?.();
  const unregisterPhoneAbort = engine.registerAgentPhoneAbortHandler?.(
    () => {
      try { session.abort?.(); } catch {}
    },
    { agentId, conversationId, conversationType, sessionPath: sessionPath || null },
  ) || (() => {});
  if (sessionPath) {
    await updateAgentPhoneRuntime({
      agentDir,
      agentId,
      conversationId,
      conversationType,
      patch: {
        phoneSessionFile: storedRelativePath(agentDir, sessionPath),
        lastPhoneSessionUsedAt: refreshNow.toISOString(),
        phoneSessionStartedAt: openedExistingSession
          ? (runtime.phoneSessionStartedAt || refreshNow.toISOString())
          : refreshNow.toISOString(),
        promptSnapshot,
        effectiveModel,
        modelOverrideApplied: !!modelOverride,
        modelOverrideRequested: modelOverride || null,
      },
      timestamp: refreshNow.toISOString(),
    });
    await updateAgentPhoneProjectionMeta({
      agentDir,
      agentId,
      conversationId,
      conversationType,
      patch: {
        toolMode,
        effectiveModel,
        modelOverrideApplied: !!modelOverride,
        modelOverrideRequested: modelOverride || null,
      },
      timestamp: refreshNow.toISOString(),
    });
    try { await onSessionReady?.(sessionPath); } catch {}
  }

  let onAbort;
  if (signal) {
    onAbort = () => { try { session.abort(); } catch {} };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let capturedText = "";
  let isCapturing = false;
  let toolCallCount = 0;
  const toolCallNames = [];
  let stopReason = null;
  let lastLiveActivity = null;
  const recordLiveActivity = (key, state, summary, details = {}) => {
    if (!isCapturing || lastLiveActivity === key) return;
    lastLiveActivity = key;
    Promise.resolve(onActivity?.(state, summary, details)).catch(() => {});
  };
  const unsub = session.subscribe((event) => {
    if (emitEvents && sessionPath && isCapturing) {
      engine.emitEvent?.({ ...event, isolated: true }, sessionPath);
    }
    try { onEvent?.(event, { sessionPath, isCapturing }); } catch {}
    if (!isCapturing) return;
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "thinking_delta") {
        recordLiveActivity("thinking", "thinking", "正在思考");
      }
      if (sub?.type === "text_delta") {
        recordLiveActivity("composing", "replying", "正在准备回复");
      }
      if (sub?.type === "text_delta") capturedText += sub.delta || "";
    } else if (event.type === "tool_execution_start") {
      toolCallCount += 1;
      if (event.toolName) toolCallNames.push(event.toolName);
      if (event.toolName === "channel_reply") {
        recordLiveActivity("channel_reply", "replying", "正在发送频道消息");
      } else if (event.toolName === "channel_pass") {
        recordLiveActivity("channel_pass", "no_reply", "正在选择本轮不发言");
      }
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      if (message.usage && engine.usageLedger?.record) {
        engine.usageLedger.record({
          model: {
            provider: message.provider || model?.provider,
            modelId: message.model || model?.id,
            api: model?.api,
          },
          usage: message.usage,
          costRates: model?.cost,
          usageContext: {
            source: {
              subsystem: "session",
              operation: "phone_reply",
              surface: conversationType,
              trigger: "delivery",
            },
            attribution: {
              kind: "phone",
              agentId,
              conversationId,
              conversationType,
              sessionPath,
            },
          },
        });
      }
    }
  });

  debugLog()?.log("agent-executor", `${agentId} phone session started (${conversationType}:${conversationId}, ${rounds.length} rounds)`);

  try {
    for (const round of rounds) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      isCapturing = !!round.capture;
      if (round.capture) {
        capturedText = "";
        lastLiveActivity = null;
      }
      const promptResult = await session.prompt(round.text);
      stopReason = promptResult?.stopReason || stopReason;
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    try { unregisterPhoneAbort(); } catch {}
    await teardownSessionResources({
      session,
      unsub,
      label: `hub.runAgentPhoneSession[${agentId}:${conversationId}]`,
      warn: (msg) => debugLog()?.warn("agent-executor", msg),
    });
  }

  const text = stripClosedInternalNarrationBlocks(capturedText);

  debugLog()?.log("agent-executor", `${agentId} phone done, ${text.length} chars captured`);
  if (!returnDiagnostics) return text;
  return {
    text,
    diagnostics: {
      activeToolNames,
      toolCallCount,
      toolCallNames,
      ordinaryTextLength: text.length,
      rawTextLength: capturedText.length,
      stopReason,
    },
  };
}
