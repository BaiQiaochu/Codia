/**
 * Sub-agent tool (non-blocking).
 *
 * Delegates an isolated task to an agent session. Results are persisted through
 * DeferredResultStore and delivered back into the parent conversation later.
 *
 * agent="?" or agent="list" lists available agents synchronously.
 */

import { Type } from "../pi-sdk/index.ts";

import path from "node:path";

import { t } from "../i18n.ts";

import { createModuleLogger } from "../debug-log.ts";

import { getToolSessionCwd, getToolSessionPath } from "./tool-session.ts";

import { resolveAgentParam } from "./agent-id-resolver.ts";

import {
  SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY,
  SubagentAccessDeniedError,
  resolveSubagentToolAccess,
} from "./subagent-tool-policy.ts";

import {

  mergeExecutorMetadata,

  normalizeExecutorMetadata,

} from "../subagent-executor-metadata.ts";

type StringMap = Record<string, any>;

type SubagentOutcome = {
  ok: boolean;
  reason?: string;
  text?: string;
  sessionFiles?: any[];
  aborted?: boolean;
};

const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

const log = createModuleLogger("subagent-tool");

const EXPLICIT_ONLY_DESCRIPTION =

  "Only use this tool when the user explicitly asks you to involve another agent, delegate a task, or get cross-session assistance. " +

  "Do not use this tool by default. " +

  "The task parameter must include all necessary context because the sub-agent cannot see the current conversation history.";

// Concurrency limits live inside createSubagentTool, scoped per agent instance.

function directPersistDir(deps) {

  return path.join(deps.agentDir, "subagent-sessions", "direct");

}

function warnControllerHookFailure(action, taskId, err) {

  log.warn(`controller ${action} failed for ${taskId}: ${err?.message || err}`);

}

function setSubagentControllerSafely(deps, taskId, controller) {

  try {

    deps.setSubagentController?.(taskId, controller);

  } catch (err) {

    warnControllerHookFailure("set", taskId, err);

  }

}

function removeSubagentControllerSafely(deps, taskId) {

  try {

    deps.removeSubagentController?.(taskId);

  } catch (err) {

    warnControllerHookFailure("remove", taskId, err);

  }

}

function pickLabel(params: StringMap = {}) {

  if (typeof params.label === "string" && params.label.trim()) return params.label.trim();

  // Legacy compatibility: old callers may still pass instance. It is now display-only.

  if (typeof params.instance === "string" && params.instance.trim()) return params.instance.trim();

  return null;

}

function directThreadSnapshot(thread) {

  if (!thread) return null;

  return {

    threadId: thread.threadId || null,

    threadKind: thread.kind || null,

    label: thread.label || null,

    access: thread.access || null,

    agentId: thread.agentId || null,

    agentName: thread.agentName || null,

    childSessionId: thread.childSessionId || null,

    childSessionPath: thread.childSessionPath || null,

    summary: thread.summary || null,

  };

}

function textOrNull(value) {

  return typeof value === "string" && value.trim() ? value.trim() : null;

}

function sessionIdForPath(deps, sessionPath) {

  const sessionId = deps.getSessionIdForPath?.(sessionPath);

  return textOrNull(sessionId);

}

function childSessionRefFromReady(deps, sessionPath, ready = null) {

  const readyObj = ready && typeof ready === "object" ? ready : null;

  const readyPath = textOrNull(readyObj?.sessionPath) || textOrNull(sessionPath);

  return {

    sessionId: textOrNull(readyObj?.sessionId) || sessionIdForPath(deps, readyPath),

    sessionPath: readyPath,

  };

}

function parentSessionRefForPath(deps, sessionPath) {

  const sessionId = sessionIdForPath(deps, sessionPath);

  return sessionId ? { sessionId, sessionPath } : null;

}

function parentSessionInputForPath(deps, sessionPath) {

  return parentSessionRefForPath(deps, sessionPath) || sessionPath;

}

function sameParentSession(deps, thread, parentSessionPath) {

  if (!thread || !parentSessionPath) return false;

  const parentSessionId = sessionIdForPath(deps, parentSessionPath);

  const threadSessionId = textOrNull(thread.parentSessionId) || sessionIdForPath(deps, thread.parentSessionPath);

  if (parentSessionId && threadSessionId) return parentSessionId === threadSessionId;

  return thread.parentSessionPath === parentSessionPath;

}

function taskIdForSubagentRun() {

  return `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

}

function errorResult(text, details = {}) {

  return { content: [{ type: "text", text }], details };

}

function subagentAccessDeniedResult(error) {

  const message = error instanceof SubagentAccessDeniedError
    ? error.message
    : "Cannot grant subagent write access from a read-only parent session.";

  return errorResult(message, {
    errorCode: SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY,
  });

}

function extractTaskTitle(task) {

  return String(task || "")

    .split(/\r?\n/)

    .map(line => line.trim())

    .find(Boolean) || "";

}

function formatAgentEntry(a) {

  const label = a.name && a.name !== a.id ? `${a.id} (${a.name})` : a.id;

  const parts = [label];

  if (a.model) parts.push(`[${a.model}]`);

  if (a.summary) parts.push(a.summary);

  return parts.join(" - ");

}

function resolveAgentIdentity(listAgents, currentAgentId, agentId) {

  const actualAgentId = agentId || currentAgentId || null;

  if (!actualAgentId) {

    return normalizeExecutorMetadata({});

  }

  const agents = listAgents ? listAgents() : [];

  const target = agents.find(a => a.id === actualAgentId);

  return normalizeExecutorMetadata({

    agentId: actualAgentId,

    agentName: target?.name || target?.agentName || actualAgentId,

  });

}

function applyRequestedAgentMetadata(target, requestedIdentity) {

  if (!target || !requestedIdentity) return target;

  target.requestedAgentId = requestedIdentity.executorAgentId;

  target.requestedAgentNameSnapshot = requestedIdentity.executorAgentNameSnapshot;

  return target;

}

function collectSessionFiles(result) {

  const files = [];

  const push = (item) => {

    if (item && typeof item === "object") files.push(item);

  };

  if (Array.isArray(result?.sessionFiles)) {

    for (const item of result.sessionFiles) push(item);

  }

  if (Array.isArray(result?.files)) {

    for (const item of result.files) push(item);

  }

  return files;

}

function describeSessionFile(file) {

  const label = file?.label || file?.displayName || file?.filename || file?.name || null;
//

  const filePath = file?.filePath || file?.path || file?.realPath || null;

  if (label && filePath && label !== filePath) return `${label}: ${filePath}`;

  return filePath || label || null;

}

function formatProducedFiles(files) {

  const lines = files.map(describeSessionFile).filter(Boolean);

  if (!lines.length) return "";

  return t("error.subagentProducedFiles", {

    files: lines.map(line => `- ${line}`).join("\n"),

  });

}

function completionErrorForStopReason(stopReason, errorMessage) {

  if (!stopReason || stopReason === "stop") return null;

  if (stopReason === "error") {

    return errorMessage || t("error.subagentStopError");

  }

  if (stopReason === "length") {
//

    return t("error.subagentStopLength");

  }

  return t("error.subagentStopReason", { reason: stopReason });

}

function normalizeSubagentOutcome(result): SubagentOutcome {

  const stopError = completionErrorForStopReason(result?.stopReason, result?.errorMessage);

  if (result?.error) {

    return { ok: false, reason: stopError || String(result.error) };

  }

  if (stopError) return { ok: false, reason: stopError };

  const text = typeof result?.replyText === "string" && result.replyText.trim()

    ? result.replyText

    : "";

  const sessionFiles = collectSessionFiles(result);

  if (text) {

    return { ok: true, text, sessionFiles };

  }

  const fileSummary = formatProducedFiles(sessionFiles);

  if (fileSummary) {

    return { ok: true, text: fileSummary, sessionFiles };

  }

  if (Array.isArray(result?.toolErrors) && result.toolErrors.length) {

    return { ok: false, reason: t("error.subagentToolFailed", { msg: result.toolErrors.filter(Boolean).join("; ") }) };

  }

  return { ok: false, reason: t("error.subagentNoOutput") };

}

/**

 * @param {object} deps

 * @param {(opts: object) => Promise<{ sessionPath: string|null, run: (prompt: string) => Promise }>} deps.prepareIsolatedSession

 * @param {() => string|null} deps.resolveUtilityModel

 * @param {() => import("../deferred-result-store.ts").DeferredResultStore|null} deps.getDeferredStore

 * @param {() => import("../subagent-run-store.ts").SubagentRunStore|null} [deps.getSubagentRunStore]

 * @param {() => import("../subagent-thread-store.ts").SubagentThreadStore|null} [deps.getSubagentThreadStore]

 * @param {() => string|null} deps.getSessionPath

 * @param {(sessionPath: string) => string|null} [deps.getSessionPermissionMode] parent permission mode inherited when access is omitted

 * @param {() => string|null} [deps.getParentCwd] parent session cwd inherited by subagents
 * @param {() => Array} [deps.listAgents]

 * @param {string} [deps.currentAgentId]

  *

 */

export function createSubagentTool(deps) {

  const activeBySession = new Map(); // sessionId || legacy sessionPath -> count

  const MAX_PER_SESSION = 10; // Max 10 parallel subagents per parent session.

  const MAX_GLOBAL = 20;

  function sessionIdentityKey(sessionPath) {

    if (!sessionPath) return null;

    return sessionIdForPath(deps, sessionPath) || sessionPath;

  }

  function getActive(sp) { return activeBySession.get(sp) || 0; }

  function incActive(sp) { activeBySession.set(sp, getActive(sp) + 1); }

  function decActive(sp) {

    const n = getActive(sp) - 1;

    if (n <= 0) activeBySession.delete(sp);

    else activeBySession.set(sp, n);

  }

  function totalActive() {

    let sum = 0;

    for (const v of activeBySession.values()) sum += v;

    return sum;

  }

  return {

    name: "subagent",

    label: t("toolDef.subagent.label"),

    description: `${EXPLICIT_ONLY_DESCRIPTION}\n\n${t("toolDef.subagent.description")}`,

    parameters: Type.Object({

      task: Type.String({ description: t("toolDef.subagent.taskDesc") }),

      model: Type.Optional(Type.String({ description: t("toolDef.subagent.modelDesc") })),

      agent: Type.Optional(Type.String({ description: t("toolDef.subagent.agentDesc") })),

      label: Type.Optional(Type.String({ description: t("toolDef.subagent.labelDesc") })),

      // Legacy compatibility only. New callers should use label; thread identity is the returned threadId.

      instance: Type.Optional(Type.String({ description: t("toolDef.subagent.instanceDesc") })),

      access: Type.Optional(Type.Union(

        [Type.Literal("read"), Type.Literal("write")],

        { description: t("toolDef.subagent.accessDesc") },

      )),

      includeSessionFiles: Type.Optional(Type.Boolean({ description: t("toolDef.subagent.includeSessionFilesDesc") })),

    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {

      // Discovery mode.

      if (params.agent === "?" || params.agent === "list") {

        const listAgents = deps.listAgents;

        if (!listAgents) {

          return { content: [{ type: "text", text: t("error.noOtherAgents") }] };

        }

        const agents = listAgents().filter(a => a.id !== deps.currentAgentId);

        if (!agents.length) {

          return { content: [{ type: "text", text: t("error.noOtherAgents") }] };

        }

        return { content: [{ type: "text", text: agents.map(a => "- " + formatAgentEntry(a)).join("\n") }] };

      }
      // Resolve agent by strict id first, then by unique display name.

      const allAgents = deps.listAgents ? deps.listAgents() : [];

      const resolved = resolveAgentParam(allAgents, params.agent);

      if (!resolved.ok) {

        const candidates = resolved.ambiguous

          ? resolved.byName

          : allAgents.filter(a => a.id !== deps.currentAgentId);

        return {

          content: [{

            type: "text",

            text: t("error.agentNotFoundAvailable", {

              id: params.agent,

              ids: candidates.map(formatAgentEntry).join("\n") || "(none)",

            }),

          }],

        };

      }

 // self-check：解析后是自己，视为未指-

      const targetAgentId = (resolved.agentId && resolved.agentId !== deps.currentAgentId)

        ? resolved.agentId

        : undefined;

      const requestedIdentity = resolveAgentIdentity(deps.listAgents, deps.currentAgentId, targetAgentId);

      const parentSessionPath = getToolSessionPath(ctx);

      const parentSessionKey = sessionIdentityKey(parentSessionPath);

      const parentSessionRef = parentSessionRefForPath(deps, parentSessionPath);

      const parentSessionId = parentSessionRef?.sessionId || null;

      const parentCwd = getToolSessionCwd(ctx) || deps.getParentCwd?.() || null;

 // Direct subagent：每次创建都会生成一个系统身-threadId。label/legacy instance

 // 只做展示，不再作为复用开关；续接必须使用 subagent_reply(threadId)-

      const label = pickLabel(params);

      const realAgentId = targetAgentId || deps.currentAgentId || null;
      // Tool access policy is centralized in resolveSubagentToolAccess.

      const access = params.access === "read" || params.access === "write" ? params.access : undefined;

      const parentPermissionMode = parentSessionPath

        ? (deps.getSessionPermissionMode?.(parentSessionPath) || null)

        : null;

      let toolAccess;

      try {
        toolAccess = resolveSubagentToolAccess({ access, parentPermissionMode });
      } catch (error) {
        if (error instanceof SubagentAccessDeniedError) {
          return subagentAccessDeniedResult(error);
        }
        throw error;
      }
      // Enforce per-session and global concurrency limits.

      if (parentSessionKey && getActive(parentSessionKey) >= MAX_PER_SESSION) {

        return {

          content: [{ type: "text", text: t("error.subagentMaxConcurrent", { max: MAX_PER_SESSION }) }],

        };

      }

      if (totalActive() >= MAX_GLOBAL) {

        return {

          content: [{ type: "text", text: t("error.subagentMaxConcurrent", { max: MAX_GLOBAL }) }],

        };

      }

      const store = deps.getDeferredStore?.();

      const runStore = deps.getSubagentRunStore?.();

      const threadStore = deps.getSubagentThreadStore?.();

      if (!store || !threadStore || !parentSessionPath) {

        return errorResult(t("error.subagentParentSessionRequired"), {

          errorCode: "SUBAGENT_PARENT_SESSION_REQUIRED",

        });

      }

      const taskId = taskIdForSubagentRun();

      const threadKind = "direct";

      const threadId = taskId;

      const taskTitle = extractTaskTitle(params.task);

      const taskSummary = taskTitle.length > 80

        ? `${taskTitle.slice(0, 80)}...`

        : taskTitle;

      store.defer(

        taskId,

        parentSessionInputForPath(deps, parentSessionPath),

        applyRequestedAgentMetadata(

          mergeExecutorMetadata({

            type: "subagent",

            threadId,

            threadKind,

            label,

            access,

            summary: taskSummary,

          }, requestedIdentity),

          requestedIdentity,

        ),

      );

      runStore?.register?.(taskId, {

        parentSessionId,

        parentSessionPath,

        threadId,

        threadKind,

        label,

        access,

        summary: taskSummary,

        requestedAgentId: requestedIdentity?.executorAgentId || null,

        requestedAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,

        executorAgentId: requestedIdentity?.executorAgentId || null,

        executorAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,

        executorMetaVersion: requestedIdentity?.executorMetaVersion || null,

      });

      const hub = deps.getActivityHub?.();

      hub?.upsert({

        id: taskId, kind: "subagent", status: "running",

        sessionId: parentSessionId,

        sessionPath: parentSessionPath,

        threadId,

        threadKind,

        agentId: requestedIdentity?.executorAgentId || null,

        agentName: requestedIdentity?.executorAgentNameSnapshot || null,

        label,

        access,

        summary: taskSummary, startedAt: Date.now(),

      });

      const controller = new AbortController();

 // 超时计时移到 executeForAgent 真正弢跑时再起：复用实例可能排队，

 // 排队期间不该计入 30 分钟超时（否则队尾任务没弢跑就被误超时）-

      let timeoutTimer = null;

      const registry = deps.getTaskRegistry?.();

      registry?.register(taskId, {

        type: "subagent",

        parentSessionId,

        parentSessionPath,

        parentSessionRef,

        meta: applyRequestedAgentMetadata(

          mergeExecutorMetadata({ summary: taskSummary }, requestedIdentity),

          requestedIdentity,

        ),

      });

      setSubagentControllerSafely(deps, taskId, controller);

      const initialExecutorIdentity = resolveAgentIdentity(deps.listAgents, deps.currentAgentId, targetAgentId);

      threadStore?.beginRun?.(threadId, {

        kind: threadKind,

        parentSessionId,

        parentSessionPath,

        agentId: initialExecutorIdentity?.executorAgentId || targetAgentId || realAgentId || null,

        agentName: initialExecutorIdentity?.executorAgentNameSnapshot || null,

        label,

        access,

        summary: taskSummary,

      });

      incActive(parentSessionKey);

 // 原子执行，fire-and-forget。sessionPath 通过 onSessionReady 回调后补到前端-

      const executeForAgent = (agentId) => {

        const executorIdentity = agentId === targetAgentId
          ? initialExecutorIdentity
          : resolveAgentIdentity(deps.listAgents, deps.currentAgentId, agentId);

        timeoutTimer = setTimeout(() => controller.abort(), SUBAGENT_TIMEOUT_MS);

        if (timeoutTimer.unref) timeoutTimer.unref();
        // Snapshot the parent cwd when the subagent is dispatched.

        const inheritedCwd = parentCwd || undefined;

        return deps.executeIsolated(

          params.task,

          {

            agentId,

            cwd: inheritedCwd,

            parentSessionPath,

            emitEvents: true,

            persist: directPersistDir(deps),

            model: params.model,

            ...(toolAccess.customToolFilter ? { toolFilter: toolAccess.customToolFilter } : {}),

            ...(toolAccess.builtinToolFilter ? { builtinFilter: toolAccess.builtinToolFilter } : {}),

            permissionMode: toolAccess.permissionMode,

            subagentContext: true,

            subagentTaskId: taskId,

            fileReadSessionPaths: params.includeSessionFiles === true && parentSessionPath ? [parentSessionPath] : [],

            signal: controller.signal,

            onSessionReady: (sp, ready = null) => {

              const childSessionRef = childSessionRefFromReady(deps, sp, ready);

              const childSessionPath = childSessionRef.sessionPath || sp;

              deps.emitEvent?.({

                type: "block_update",

                taskId,

                patch: {

                  ...(childSessionRef.sessionId ? { sessionId: childSessionRef.sessionId } : {}),

                  streamKey: childSessionPath,

                  threadId,

                  threadKind,

                  agentId: executorIdentity?.executorAgentId || null,

                  agentName: executorIdentity?.executorAgentNameSnapshot || null,

                  executorAgentId: executorIdentity?.executorAgentId || null,

                  executorAgentNameSnapshot: executorIdentity?.executorAgentNameSnapshot || null,

                  requestedAgentId: requestedIdentity?.executorAgentId || null,

                  requestedAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,

                },

              }, parentSessionPath);

 // 持久化子代理 sessionPath + 实际执行者身份到 deferred store meta（历史加载用-

              const task = store.query(taskId);

              if (task?.meta) {

                if (childSessionRef.sessionId) task.meta.sessionId = childSessionRef.sessionId;

                task.meta.sessionPath = childSessionPath;

                task.meta.threadId = threadId;

                task.meta.threadKind = threadKind;

                task.meta.label = label;

                task.meta.access = access;

                mergeExecutorMetadata(task.meta, executorIdentity);

                applyRequestedAgentMetadata(task.meta, requestedIdentity);

              }

              store._save?.();

              runStore?.attachSession?.(taskId, childSessionPath, {

                childSessionId: childSessionRef.sessionId,

                threadId,

                threadKind,

                label,

                access,

                requestedAgentId: requestedIdentity?.executorAgentId || null,

                requestedAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,

                executorAgentId: executorIdentity?.executorAgentId || null,

                executorAgentNameSnapshot: executorIdentity?.executorAgentNameSnapshot || null,

                executorMetaVersion: executorIdentity?.executorMetaVersion || null,

              });

              hub?.upsert({

                id: taskId, childSessionId: childSessionRef.sessionId, childSessionPath, threadId, threadKind,

                agentId: executorIdentity?.executorAgentId || null,

                agentName: executorIdentity?.executorAgentNameSnapshot || null,

                label,

                access,

              });

              threadStore?.attachSession?.(threadId, childSessionPath, {

                parentSessionId,

                parentSessionPath,

                childSessionId: childSessionRef.sessionId,

                agentId: executorIdentity?.executorAgentId || agentId || realAgentId || null,

                agentName: executorIdentity?.executorAgentNameSnapshot || null,

                label,

                access,

                summary: taskSummary,

              });

              void deps.persistSubagentSessionMeta?.(childSessionPath, executorIdentity)?.catch?.(() => {});

            },

          },

        );

      };

      const runPromise = threadStore?.runSerialized

        ? threadStore.runSerialized(threadId, () => executeForAgent(targetAgentId))

        : executeForAgent(targetAgentId);

      runPromise.then(result => {

        const wasUserAborted = registry?.query(taskId)?.aborted;

        if (wasUserAborted) {

          store.abort(taskId, t("error.subagentAborted"));

          runStore?.abort?.(taskId, t("error.subagentAborted"));

          threadStore?.finishRun?.(threadId, {

            status: "aborted",

            summary: t("error.subagentAborted"),

            close: false,

          });

          hub?.upsert({ id: taskId, status: "aborted", finishedAt: Date.now() });

          deps.emitEvent?.({

            type: "block_update", taskId,

            patch: { streamStatus: "aborted", summary: t("error.subagentAborted") },

          }, parentSessionPath);

          return;

        }

        const outcome = normalizeSubagentOutcome(result);

        if (!outcome.ok) {

          store.fail(taskId, outcome.reason);

          runStore?.fail?.(taskId, outcome.reason);

          threadStore?.finishRun?.(threadId, {

            status: "failed",

            summary: outcome.reason,

            close: false,

          });

        } else {

          store.resolve(taskId, outcome.text);

          runStore?.resolve?.(taskId, outcome.text);

          threadStore?.finishRun?.(threadId, {

            status: "resolved",

            summary: outcome.text,

            close: false,

          });

        }

        hub?.upsert({ id: taskId, status: outcome.ok ? "done" : "failed", finishedAt: Date.now() });

        const summary = outcome.ok ? outcome.text : outcome.reason;

        deps.emitEvent?.({

          type: "block_update", taskId,

          patch: {

            streamStatus: outcome.ok ? "done" : "failed",

            summary: (summary || "").slice(0, 200),

          },

        }, parentSessionPath);

      }).catch(err => {

        const wasUserAborted = registry?.query(taskId)?.aborted;

        const isTimeout = err.name === "AbortError" || err.name === "TimeoutError";

        const reason = wasUserAborted

          ? t("error.subagentAborted")

          : isTimeout

            ? t("error.subagentTimeout", { minutes: SUBAGENT_TIMEOUT_MS / 60000 })

            : err.message || String(err);

        if (wasUserAborted) {

          store.abort(taskId, reason);

          runStore?.abort?.(taskId, reason);

          threadStore?.finishRun?.(threadId, {

            status: "aborted",

            summary: reason,

            close: false,

          });

        } else {

          store.fail(taskId, reason);

          runStore?.fail?.(taskId, reason);

          threadStore?.finishRun?.(threadId, {

            status: "failed",

            summary: reason,

            close: false,

          });

        }

        hub?.upsert({ id: taskId, status: wasUserAborted ? "aborted" : "failed", finishedAt: Date.now() });

        deps.emitEvent?.({

          type: "block_update", taskId,

          patch: { streamStatus: wasUserAborted ? "aborted" : "failed", summary: reason },

        }, parentSessionPath);

      }).finally(() => {

        clearTimeout(timeoutTimer);

        removeSubagentControllerSafely(deps, taskId);

        registry?.remove(taskId);

        decActive(parentSessionKey);

      });

      return {

        content: [{ type: "text", text: t("error.subagentDispatched", { taskId }) }],

        details: {

          taskId,

          threadId,

          threadKind,

          task: params.task,

          taskTitle,

          ...(label ? { label } : {}),

          ...(access ? { access } : {}),

          agentId: requestedIdentity?.executorAgentId || null,

          agentName: requestedIdentity?.executorAgentNameSnapshot || null,

          requestedAgentId: requestedIdentity?.executorAgentId || null,

          requestedAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,

          executorAgentId: requestedIdentity?.executorAgentId || null,

          executorAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,

          executorMetaVersion: requestedIdentity?.executorMetaVersion || null,

          sessionPath: null,  // 通过 block_update 后补 streamKey

          streamStatus: "running",

        },

      };

    },

  };

}

export function createSubagentReplyTool(deps) {

  return {

    name: "subagent_reply",

    label: t("toolDef.subagentReply.label"),

    description: t("toolDef.subagentReply.description"),

    parameters: Type.Object({

      threadId: Type.String({ description: t("toolDef.subagentReply.threadIdDesc") }),

      task: Type.String({ description: t("toolDef.subagentReply.taskDesc") }),

      access: Type.Optional(Type.Union(

        [Type.Literal("read"), Type.Literal("write")],

        { description: t("toolDef.subagentReply.accessDesc") },

      )),

      includeSessionFiles: Type.Optional(Type.Boolean({ description: t("toolDef.subagent.includeSessionFilesDesc") })),

    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {

      const parentSessionPath = getToolSessionPath(ctx);

      const parentSessionRef = parentSessionRefForPath(deps, parentSessionPath);

      const parentSessionId = parentSessionRef?.sessionId || null;

      const parentCwd = getToolSessionCwd(ctx) || deps.getParentCwd?.() || null;

      const threadStore = deps.getSubagentThreadStore?.() || null;

      if (!threadStore) {

        return errorResult("subagent thread store unavailable", { errorCode: "SUBAGENT_THREAD_STORE_UNAVAILABLE" });

      }

      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";

      const initialThread = threadStore.get(threadId);

      const validation = validateDirectThreadForReply(initialThread, parentSessionPath, (thread, sessionPath) => sameParentSession(deps, thread, sessionPath));

      if (validation) return validation;

      const store = deps.getDeferredStore?.();

      if (!store || !parentSessionPath) {

        return errorResult("subagent_reply requires an active parent session", { errorCode: "SUBAGENT_PARENT_SESSION_REQUIRED" });

      }

      const explicitAccess = params.access === "read" || params.access === "write" ? params.access : undefined;

      const access = explicitAccess || initialThread.access || undefined;

      const parentPermissionMode = deps.getSessionPermissionMode?.(parentSessionPath) || null;

      let toolAccess;

      try {
        toolAccess = resolveSubagentToolAccess({ access, parentPermissionMode });
      } catch (error) {
        if (error instanceof SubagentAccessDeniedError) {
          return subagentAccessDeniedResult(error);
        }
        throw error;
      }

      const runStore = deps.getSubagentRunStore?.();

      const hub = deps.getActivityHub?.();

      const registry = deps.getTaskRegistry?.();

      const taskId = taskIdForSubagentRun();

      const threadKind = "direct";

      const taskTitle = extractTaskTitle(params.task);

      const taskSummary = taskTitle.length > 80 ? `${taskTitle.slice(0, 80)}...` : taskTitle;

      const executorIdentity = resolveAgentIdentity(deps.listAgents, deps.currentAgentId, initialThread.agentId || undefined);

      const queued = threadStore.isBusy?.(threadId) === true;

      store.defer(taskId, parentSessionInputForPath(deps, parentSessionPath), mergeExecutorMetadata({

        type: "subagent",

        threadId,

        threadKind,

        label: initialThread.label || null,

        access: access || null,

        summary: taskSummary,

      }, executorIdentity));

      runStore?.register?.(taskId, {

        parentSessionId,

        parentSessionPath,

        threadId,

        threadKind,

        label: initialThread.label || null,

        access: access || null,

        summary: taskSummary,

        executorAgentId: executorIdentity?.executorAgentId || null,

        executorAgentNameSnapshot: executorIdentity?.executorAgentNameSnapshot || null,

        executorMetaVersion: executorIdentity?.executorMetaVersion || null,

      });

      hub?.upsert({

        id: taskId, kind: "subagent", status: "running",

        sessionId: parentSessionId,

        sessionPath: parentSessionPath,

        threadId,

        threadKind,

        agentId: executorIdentity?.executorAgentId || null,

        agentName: executorIdentity?.executorAgentNameSnapshot || null,

        label: initialThread.label || null,

        access: access || null,

        summary: taskSummary,

        startedAt: Date.now(),

      });

      const controller = new AbortController();

      let timeoutTimer = null;

      registry?.register(taskId, {

        type: "subagent",

        parentSessionId,

        parentSessionPath,

        parentSessionRef,

        meta: mergeExecutorMetadata({ summary: taskSummary }, executorIdentity),

      });

      setSubagentControllerSafely(deps, taskId, controller);

      const executeExistingThread = () => {

        const latest = threadStore.get(threadId);

        if (!latest || latest.kind !== "direct" || latest.status !== "open") {

          throw new Error("subagent thread is no longer open");

        }

        if (!latest.childSessionPath) {

          throw new Error("subagent thread has no child session to resume");

        }

        threadStore.beginRun(threadId, {

          kind: "direct",

          parentSessionId,

          parentSessionPath,

          agentId: latest.agentId || null,

          agentName: latest.agentName || null,

          label: latest.label || null,

          access: access || latest.access || null,

          summary: taskSummary,

        });

        timeoutTimer = setTimeout(() => controller.abort(), SUBAGENT_TIMEOUT_MS);

        if (timeoutTimer.unref) timeoutTimer.unref();

        return deps.executeIsolated(params.task, {

          agentId: latest.agentId || undefined,

          cwd: parentCwd || undefined,

          parentSessionPath,

          emitEvents: true,

          persist: directPersistDir(deps),

          resumeSessionPath: latest.childSessionPath,

          ...(toolAccess.customToolFilter ? { toolFilter: toolAccess.customToolFilter } : {}),

          ...(toolAccess.builtinToolFilter ? { builtinFilter: toolAccess.builtinToolFilter } : {}),

          permissionMode: toolAccess.permissionMode,

          subagentContext: true,

          subagentTaskId: taskId,

          subagentThreadId: threadId,

          subagentThreadKind: threadKind,

          fileReadSessionPaths: params.includeSessionFiles === true && parentSessionPath ? [parentSessionPath] : [],

          signal: controller.signal,

          onSessionReady: (sp, ready = null) => {

            const childSessionRef = childSessionRefFromReady(deps, sp, ready);

            const childSessionPath = childSessionRef.sessionPath || sp;

            const task = store.query(taskId);

            if (task?.meta) {

              if (childSessionRef.sessionId) task.meta.sessionId = childSessionRef.sessionId;

              task.meta.sessionPath = childSessionPath;

              task.meta.threadId = threadId;

              task.meta.threadKind = threadKind;

              task.meta.label = latest.label || null;

              task.meta.access = access || latest.access || null;

              mergeExecutorMetadata(task.meta, executorIdentity);

            }

            store._save?.();

            runStore?.attachSession?.(taskId, childSessionPath, {

              childSessionId: childSessionRef.sessionId,

              threadId,

              threadKind,

              label: latest.label || null,

              access: access || latest.access || null,

              executorAgentId: executorIdentity?.executorAgentId || null,

              executorAgentNameSnapshot: executorIdentity?.executorAgentNameSnapshot || null,

              executorMetaVersion: executorIdentity?.executorMetaVersion || null,

            });

            hub?.upsert({

              id: taskId, childSessionId: childSessionRef.sessionId, childSessionPath, threadId, threadKind,

              agentId: executorIdentity?.executorAgentId || null,

              agentName: executorIdentity?.executorAgentNameSnapshot || null,

              label: latest.label || null,

              access: access || latest.access || null,

            });

            threadStore.attachSession(threadId, childSessionPath, {

              parentSessionId,

              parentSessionPath,

              childSessionId: childSessionRef.sessionId,

              agentId: latest.agentId || null,

              agentName: latest.agentName || null,

              label: latest.label || null,

              access: access || latest.access || null,

              summary: taskSummary,

            });

          },

        });

      };

      const runPromise = threadStore.runSerialized(threadId, executeExistingThread);

      runPromise.then(result => {

        const wasUserAborted = registry?.query(taskId)?.aborted;

        const outcome: SubagentOutcome = wasUserAborted

          ? { ok: false, reason: t("error.subagentAborted"), aborted: true }

          : normalizeSubagentOutcome(result);

        if (outcome.aborted) {

          store.abort(taskId, outcome.reason);

          runStore?.abort?.(taskId, outcome.reason);

          threadStore.finishRun(threadId, { status: "aborted", summary: outcome.reason, close: false });

        } else if (!outcome.ok) {

          store.fail(taskId, outcome.reason);

          runStore?.fail?.(taskId, outcome.reason);

          threadStore.finishRun(threadId, { status: "failed", summary: outcome.reason, close: false });

        } else {

          store.resolve(taskId, outcome.text);

          runStore?.resolve?.(taskId, outcome.text);

          threadStore.finishRun(threadId, { status: "resolved", summary: outcome.text, close: false });

        }

        const finalStatus = outcome.aborted ? "aborted" : outcome.ok ? "done" : "failed";

        const summary = outcome.ok ? outcome.text : outcome.reason;

        hub?.upsert({ id: taskId, status: finalStatus, finishedAt: Date.now() });

        deps.emitEvent?.({

          type: "block_update", taskId,

          patch: { streamStatus: finalStatus, summary: (summary || "").slice(0, 200) },

        }, parentSessionPath);

      }).catch(err => {

        const wasUserAborted = registry?.query(taskId)?.aborted;

        const isTimeout = err.name === "AbortError" || err.name === "TimeoutError";

        const reason = wasUserAborted

          ? t("error.subagentAborted")

          : isTimeout

            ? t("error.subagentTimeout", { minutes: SUBAGENT_TIMEOUT_MS / 60000 })

            : err.message || String(err);

        if (wasUserAborted) {

          store.abort(taskId, reason);

          runStore?.abort?.(taskId, reason);

          threadStore.finishRun(threadId, { status: "aborted", summary: reason, close: false });

        } else {

          store.fail(taskId, reason);

          runStore?.fail?.(taskId, reason);

          threadStore.finishRun(threadId, { status: "failed", summary: reason, close: false });

        }

        hub?.upsert({ id: taskId, status: wasUserAborted ? "aborted" : "failed", finishedAt: Date.now() });

        deps.emitEvent?.({

          type: "block_update", taskId,

          patch: { streamStatus: wasUserAborted ? "aborted" : "failed", summary: reason },

        }, parentSessionPath);

      }).finally(() => {

        clearTimeout(timeoutTimer);

        removeSubagentControllerSafely(deps, taskId);

        registry?.remove(taskId);

      });

      return {

        content: [{ type: "text", text: queued

          ? t("error.subagentThreadQueued", { taskId, threadId })

          : t("error.subagentDispatched", { taskId }) }],

        details: {

          taskId,

          threadId,

          threadKind,

          task: params.task,

          taskTitle,

          ...directThreadSnapshot(initialThread),

          sessionId: initialThread.childSessionId || sessionIdForPath(deps, initialThread.childSessionPath) || null,

          sessionPath: initialThread.childSessionPath || null,

          streamStatus: "running",

        },

      };

    },

  };

}

export function createSubagentCloseTool(deps) {

  return {

    name: "subagent_close",

    label: t("toolDef.subagentClose.label"),

    description: t("toolDef.subagentClose.description"),

    parameters: Type.Object({

      threadId: Type.String({ description: t("toolDef.subagentClose.threadIdDesc") }),

      reason: Type.Optional(Type.String({ description: t("toolDef.subagentClose.reasonDesc") })),

    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {

      const parentSessionPath = getToolSessionPath(ctx);

      const threadStore = deps.getSubagentThreadStore?.() || null;

      if (!threadStore) {

        return errorResult("subagent thread store unavailable", { errorCode: "SUBAGENT_THREAD_STORE_UNAVAILABLE" });

      }

      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";

      const thread = threadStore.get(threadId);

      if (!thread) return errorResult(`Unknown subagent thread: ${threadId}`, { errorCode: "SUBAGENT_THREAD_NOT_FOUND", threadId });

      if (thread.kind !== "direct") return errorResult(`Subagent thread is not a direct instance: ${threadId}`, { errorCode: "SUBAGENT_THREAD_NOT_DIRECT", threadId });

      if (!sameParentSession(deps, thread, parentSessionPath)) {

        return errorResult(`Subagent thread does not belong to this session: ${threadId}`, { errorCode: "SUBAGENT_THREAD_NOT_IN_SESSION", threadId });

      }

      if (thread.status !== "open") {

        return errorResult(`Subagent thread is not open: ${threadId}`, { errorCode: "SUBAGENT_THREAD_NOT_OPEN", threadId });

      }

      if (threadStore.isBusy?.(threadId)) {

        return errorResult(`Subagent thread is busy: ${threadId}`, { errorCode: "SUBAGENT_THREAD_BUSY", threadId });

      }

      const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : null;

      const closed = threadStore.closeDirectThread(threadId, {

        summary: reason || thread.summary || null,

        lastRunStatus: thread.lastRunStatus || "resolved",

      });

      return {

        content: [{ type: "text", text: t("error.subagentThreadClosed", { threadId }) }],

        details: {

          threadId,

          streamStatus: "closed",

          ...directThreadSnapshot(closed),

        },

      };

    },

  };

}

function validateDirectThreadForReply(thread, parentSessionPath, matchesParent = null) {

  if (!thread) {

    return errorResult("Unknown subagent thread", { errorCode: "SUBAGENT_THREAD_NOT_FOUND" });

  }

  if (thread.kind !== "direct") {

    return errorResult(`Subagent thread is not a direct instance: ${thread.threadId}`, {

      errorCode: "SUBAGENT_THREAD_NOT_DIRECT",

      threadId: thread.threadId,

    });

  }

  if (matchesParent ? !matchesParent(thread, parentSessionPath) : thread.parentSessionPath !== parentSessionPath) {

    return errorResult(`Subagent thread does not belong to this session: ${thread.threadId}`, {

      errorCode: "SUBAGENT_THREAD_NOT_IN_SESSION",

      threadId: thread.threadId,

    });

  }

  if (thread.status !== "open") {

    return errorResult(`Subagent thread is not open: ${thread.threadId}`, {

      errorCode: "SUBAGENT_THREAD_NOT_OPEN",

      threadId: thread.threadId,

    });

  }

  return null;

}
