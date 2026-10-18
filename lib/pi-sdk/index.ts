// @ts-nocheck
/**
  *
 *
  *
 * - 不拼 session options（compaction、thinkingLevel 等）
 * - 不做工具过滤 / plan mode 逻辑
  * */

// ── Session 管理 ──
import { createHash } from "node:crypto";
import {
  createAgentSession as rawCreateAgentSession,
  createCodemodeExtension as rawCreateCodemodeExtension,
  createToolSearchExtension as rawCreateToolSearchExtension,
  ModelRegistry,
  ModelRuntime,
  resizeImage as rawResizeImage,
  formatDimensionNote as rawFormatDimensionNote,
  convertToLlm as rawConvertToLlm,
} from "@earendil-works/pi-coding-agent";
import {
  getModel as rawGetPiModel,
  completeSimple as rawCompleteSimple,
} from "@earendil-works/pi-ai/compat";
import {
  normalizeCreateAgentSessionOptions,
  PI_BUILTIN_TOOL_NAMES,
} from "./session-options.ts";
import { installAssistantStreamGuard } from "./stream-guard.ts";
import {
  createFindTool,
  createGrepTool,
} from "./search-tools.ts";
// This helper remains internal to the v1.1.0 package. Keep the import isolated
// here so a future SDK export can replace it without leaking package internals.
import {
  prepareCompaction as rawPrepareCompaction,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";

export { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export async function createAgentSession(options) {
  const result = await rawCreateAgentSession(normalizeCreateAgentSessionOptions(options));
  installProviderRuntimeCompat(result.session);
  installAssistantStreamGuard(result.session);
  return result;
}

export function installProviderRuntimeCompat(session) {
  const agent = session?.agent;
  const streamSlot = typeof agent?.streamFunction === "function" ? "streamFunction" : "streamFn";
  const streamFn = agent?.[streamSlot];
  if (typeof streamFn !== "function" || streamFn.__codiaProviderRuntimeCompat) return;

  const wrapped = (model, context, options = {}) => {
    return streamFn.call(agent, model, context, buildProviderRuntimeOptions(session, options));
  };
  wrapped.__codiaProviderRuntimeCompat = true;
  agent[streamSlot] = wrapped;
}

const CACHE_RETENTION_VALUES = new Set(["none", "short", "long"]);
const DEFAULT_CACHE_RETENTION = "long";

function buildProviderRuntimeOptions(session, options = {}) {
  const next = options && typeof options === "object" ? { ...options } : {};
  const cacheRetention = normalizeCacheRetention(next.cacheRetention);
  next.cacheRetention = cacheRetention;

  if (cacheRetention !== "none" && !hasNonEmptyString(next.sessionId)) {
    const sessionId = readStableSessionId(session);
    if (sessionId) next.sessionId = sessionId;
  }

  return next;
}

function normalizeCacheRetention(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_CACHE_RETENTION;
  const normalized = String(value).trim().toLowerCase();
  return CACHE_RETENTION_VALUES.has(normalized) ? normalized : DEFAULT_CACHE_RETENTION;
}

function readStableSessionId(session) {
  const candidates = [
    session?.sessionId,
    session?.agent?.sessionId,
    session?.sessionManager?.getSessionId?.(),
  ];
  for (const candidate of candidates) {
    if (hasNonEmptyString(candidate)) return candidate.trim();
  }

  const sessionFile = session?.sessionManager?.getSessionFile?.();
  if (!hasNonEmptyString(sessionFile)) return null;
  return `codia-cache-${createHash("sha256")
    .update(normalizePathForCacheKey(sessionFile))
    .digest("hex")
    .slice(0, 32)}`;
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizePathForCacheKey(value) {
  return String(value).replace(/\\/g, "/").toLowerCase();
}

export { PI_BUILTIN_TOOL_NAMES };

/** SDK extensions that Codia enables for every coding session. */
export const createCodemodeExtension = rawCreateCodemodeExtension;
export const createToolSearchExtension = rawCreateToolSearchExtension;

// ── 内置工具常量 ──

//
export {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  createLsTool,
} from "@earendil-works/pi-coding-agent";
export { createGrepTool, createFindTool };

//
export { DefaultResourceLoader } from "./resource-loader.ts";

// ── Utilities ──
export { formatSkillsForPrompt, getLastAssistantUsage } from "@earendil-works/pi-coding-agent";
export { ModelRuntime, ModelRegistry };

//
export {
  estimateTokens, findCutPoint, generateSummary,
  serializeConversation, shouldCompact,
  parseSessionEntries, buildSessionContext,
} from "@earendil-works/pi-coding-agent";

export const completeSimple = rawCompleteSimple;
export const convertAgentMessagesToLlm = rawConvertToLlm;
export const prepareCompaction = rawPrepareCompaction;

//
export { StringEnum } from "@earendil-works/pi-ai";
export { Type } from "@sinclair/typebox";

export function getPiModel(provider, modelId) {
  return rawGetPiModel(provider, modelId);
}

//
/** @typedef {import('@earendil-works/pi-coding-agent').ToolDefinition} ToolDefinition */

// ── Lifecycle helpers ──

/**
 * Emit `session_shutdown` event to the session's extension runner.
 *
  *
 * SDK -emitSessionShutdownEvent 辅助函数只在 core/extensions/runner.js
  *
 * 契约: AgentSession.dispose() 本身-emit shutdown, 调用方必须在
  *
 * @param {object} session - AgentSession 实例
  *
 */
export async function emitSessionShutdown(session) {
  const runner = session?.extensionRunner;
  if (runner?.hasHandlers?.("session_shutdown")) {
    await runner.emit({ type: "session_shutdown" });
    return true;
  }
  return false;
}

//
/**
  *
 * @param {string} [modelsJsonPath]
 * @returns {import('@earendil-works/pi-coding-agent').ModelRegistry}
 */
export async function resizeModelImageInput(image, options) {
  return rawResizeImage(image, options);
}

export function formatModelImageDimensionNote(result) {
  return rawFormatDimensionNote(result);
}

export function createModelRegistry(modelRuntime) {
  return new ModelRegistry(modelRuntime);
}

/**
  *
 * session 持有的是创建时的对象引用。当 ModelRegistry.refresh() 重建模型
 * 表后，session 仍指向旧对象，导致改-base_url / api 等字段后 active
  *
 * SDK 内部-_refreshCurrentModelFromRegistry()，但只在 extension
  *
 * @param {object} session - AgentSession 实例
 */
export function refreshSessionModelFromRegistry(session) {
  session?._refreshCurrentModelFromRegistry?.();
}
