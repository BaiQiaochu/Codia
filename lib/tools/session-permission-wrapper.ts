// @ts-nocheck
import { classifySessionPermission, normalizeSessionPermissionMode } from "../../core/session-permission-mode.ts";
import { actionScopeDigest, isRetrySafeRead, toolActionId, toolActionSessionRef } from "./tool-action-ledger.ts";
import { approvalDigest } from "../permission/approval-binding.ts";
import { redactLogValue, redactLogText } from "../log-redactor.ts";
import { getToolSessionPath, getToolSessionCwd } from "./tool-session.ts";
import { toolError, toolOk } from "./tool-result.ts";
import { evaluateToolSafetyPolicy } from "../permission/safety-policy.ts";

function findRuntimeCtx(args) {
  for (let i = args.length - 1; i >= 2; i--) {
    const value = args[i];
    if (value && typeof value === "object" && (
      value.sessionManager
      || value.sessionPath
      || value.agentId
      || value.model
      || value.traceId
      || value.toolTraceId
      || value.executionBoundary
    )) {
      return value;
    }
  }
  return null;
}

function buildToolApprovalRequest(confirmId, toolName, params, binding) {
  return {
    type: "session_confirmation",
    confirmId,
    kind: "tool_action_approval",
    surface: "input",
    status: "pending",
    title: "允许应用执行这次操作",
    body: "The current session is in ask-first mode. This operation may change local or external state.",
    subject: {
      label: toolName,
      detail: redactLogText(summarizeParams(params)),
    },
    severity: "elevated",
    actions: {
      confirmLabel: "同意",
      rejectLabel: "拒绝",
    },
    payload: { toolName, params: redactLogValue(params), ...binding },
  };
}

function buildToolApprovalGatewayRequest(tool, toolName, params, sessionPath, agentId = null) {
  const target = approvalTargetForTool(toolName, params);
  const sideEffect = approvalSideEffectForTool(tool, params);
  return {
    id: `${sessionPath || "session"}:${toolName}:${Date.now()}`,
    kind: "tool_action",
    sessionPath,
    agentId: agentId || null,
    toolName,
    actionName: typeof params?.action === "string" ? params.action : "execute",
    params: params && typeof params === "object" ? params : {},
    target,
    blastRadius: target.type === "url" || target.type === "domain" ? "external" : "workspace",
    reversibility: toolName === "bash" || toolName === "terminal" ? "unknown" : "moderate",
    ...(sideEffect ? { sideEffect } : {}),
  };
}

function approvalTargetForTool(toolName, params = {}) {
  const command = typeof params.command === "string" ? params.command : "";
  if (command) return { type: "command", label: command };
  const path = typeof params.path === "string" ? params.path : typeof params.file_path === "string" ? params.file_path : "";
  if (path) return { type: "file", label: path, path };
  const url = typeof params.url === "string" ? params.url : "";
  if (url) return { type: "url", label: url, url };
  const label = typeof params.label === "string" && params.label.trim()
    ? params.label.trim()
    : toolName;
  return { type: "tool", label };
}

function approvalSideEffectForTool(tool, params) {
  const describe = tool?.sessionPermission?.describeSideEffect;
  const sideEffect = typeof describe === "function"
    ? describe(params)
    : tool?.sessionPermission?.sideEffect;
  return sideEffect && typeof sideEffect === "object" ? sideEffect : null;
}

function permissionContextForTool(tool, deps = {}) {
  const base = deps.permissionContext && typeof deps.permissionContext === "object"
    ? deps.permissionContext
    : {};
  const toolSessionPermission = tool?.sessionPermission && typeof tool.sessionPermission === "object"
    ? tool.sessionPermission
    : null;
  return {
    ...base,
    ...(toolSessionPermission ? { toolSessionPermission } : {}),
    ...(tool?._pluginId ? { isPluginTool: true, pluginId: tool._pluginId } : {}),
  };
}

/** Capture all live permission inputs used by the wrapper/gateway. Only the digest
 * is persisted; folder paths and permission presentation are never ledger payloads.
 * Re-evaluate after every asynchronous approval, including automatic review. */
function currentPermissionState(tool, ctx, deps) {
  const sessionPath = getToolSessionPath(ctx) || ctx?.sessionPath || deps.getSessionPath?.() || null;
  const mode = normalizeSessionPermissionMode(
    deps.getPermissionMode?.(sessionPath) || deps.getPermissionMode?.() || "ask",
  );
  const context = permissionContextForTool(tool, deps);
  return {
    mode, context,
    digest: actionScopeDigest({
      sessionPath, mode, permissionContext: context,
      agentId: ctx?.agentId || null,
      cwd: ctx?.cwd || deps.cwd || null,
      runtimeCwd: getToolSessionCwd(ctx),
      sessionCwd: deps.getSessionCwd?.(sessionPath) ?? null,
      sessionWorkspaceFolders: deps.getSessionWorkspaceFolders?.(sessionPath) ?? null,
      sessionAuthorizedFolders: deps.getSessionAuthorizedFolders?.(sessionPath) ?? null,
      authorizedFolders: deps.getAuthorizedFolders?.() ?? deps.authorizedFolders ?? null,
      workspaceFolders: deps.workspaceFolders ?? null,
      contextWorkspaceFolders: ctx?.workspaceFolders ?? null,
      contextAuthorizedFolders: ctx?.authorizedFolders ?? null,
    }),
  };
}

function summarizeParams(params) {
  if (!params || typeof params !== "object") return "";
  const keys = ["action", "path", "file_path", "command", "url", "key", "label"];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return `${key}: ${value.trim().slice(0, 160)}`;
  }
  return "";
}

function summarizeSafeInput(params) {
  if (!params || typeof params !== "object") return null;
  const summary = { keys: Object.keys(params).slice(0, 40) };
  const action = params.action || params.kind || params.operation;
  if (typeof action === "string" && action.trim()) summary.action = action.trim().slice(0, 80);
  const pathValue = params.path || params.file_path || params.filePath;
  if (typeof pathValue === "string" && pathValue.trim()) {
    summary.pathBasename = basename(pathValue.trim());
  }
  const urlValue = params.url || params.href;
  if (typeof urlValue === "string" && urlValue.trim()) {
    try {
      summary.urlHost = new URL(urlValue).host;
    } catch {
      summary.urlHost = "";
    }
  }
  if (typeof params.command === "string" && params.command.trim()) {
    summary.commandKind = params.command.trim().split(/\s+/)[0].slice(0, 80);
  }
  return summary;
}

function basename(value) {
  return String(value).replace(/\\/g, "/").split("/").filter(Boolean).pop() || String(value);
}

function toStatus(action) {
  if (action === "confirmed") return "confirmed";
  if (action === "timeout") return "timeout";
  if (action === "aborted") return "aborted";
  return "rejected";
}

function resolveTraceContext(ctx, sessionPath, deps) {
  const fallback = deps.getTraceContext?.(sessionPath) || deps.getTraceContext?.() || null;
  return {
    ...(fallback || {}),
    ...(ctx || {}),
  };
}

function resolveToolSource(tool) {
  if (tool?._pluginId || tool?.pluginId) return "plugin";
  if (tool?._toolSource) return tool._toolSource;
  return "builtin";
}

function recordToolTrace(deps, tool, traceCtx, input = {}) {
  if (!traceCtx?.traceId || typeof deps.recordToolCall !== "function") return;
  try {
    deps.recordToolCall({
      traceId: traceCtx.traceId,
      toolTraceId: traceCtx.toolTraceId || input.toolTraceId,
      toolName: tool?.name || "unknown",
      source: resolveToolSource(tool),
      agentId: traceCtx.agentId || input.agentId || null,
      pluginId: tool?._pluginId || tool?.pluginId || null,
      input: summarizeSafeInput(input.params),
      permission: input.permission || null,
      result: input.result || null,
    });
  } catch {
    // Tracing must never affect tool execution.
  }
}

function inferResultStatus(result) {
  if (result?.details?.errorCode || result?.details?.error || result?.isError) return "tool_error";
  return "success";
}

async function askForToolApproval(toolName, params, sessionPath, deps, actionId, scopeDigest, signal) {
  const confirmStore = deps.getConfirmStore?.() || deps.confirmStore || null;
  if (!confirmStore || !sessionPath) {
    return { allowed: false, status: "rejected", confirmId: "", reason: "confirmation-unavailable" };
  }
  const binding = {
    actionId,
    scopeDigest,
    parameterDigest: approvalDigest(toolName, params, sessionPath),
    expiresAt: Date.now() + 5 * 60 * 1000,
    scope: 'single-action',
    target: redactLogValue(approvalTargetForTool(toolName, params)),
    expectedSideEffect: 'May change local or external state; approval applies only to these parameters.',
  };
  const { confirmId, promise } = confirmStore.create(
    "tool_action_approval",
    { toolName, params: redactLogValue(params), ...binding },
    sessionPath,
  );
  deps.emitEvent?.({
    type: "session_confirmation",
    request: buildToolApprovalRequest(confirmId, toolName, params, binding),
  }, sessionPath);
  const onAbort = () => confirmStore.resolve?.(confirmId, "aborted");
  signal?.addEventListener?.("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let decision;
  try { decision = await promise; } finally { signal?.removeEventListener?.("abort", onAbort); }
  const changed = approvalDigest(toolName, params, sessionPath) !== binding.parameterDigest;
  const expired = Date.now() >= binding.expiresAt;
  const status = expired ? 'timeout' : changed ? 'rejected' : toStatus(decision?.action);
  return {
    allowed: status === "confirmed",
    status,
    confirmId,
    reason: changed ? "approval-parameters-changed" : expired ? "approval-expired" : undefined,
  };
}

async function reviewToolApproval(tool, toolName, params, sessionPath, deps, runtimeCtx = null, actionId = null) {
  const gateway = deps.getApprovalGateway?.() || deps.approvalGateway || null;
  if (!gateway || typeof gateway.review !== "function") {
    return {
      allowed: false,
      status: "ask_user",
      reason: "approval-gateway-unavailable",
    };
  }
  const request = buildToolApprovalGatewayRequest(tool, toolName, params, sessionPath, runtimeCtx?.agentId || null);
  if (actionId) request.id = actionId;
  const decision = await gateway.review(request, {
    sessionPath,
    agentId: runtimeCtx?.agentId || null,
    permissionContext: deps.permissionContext || null,
    cwd: runtimeCtx?.cwd || deps.cwd || null,
    source: {
      permissionContext: deps.permissionContext || null,
      cwd: runtimeCtx?.cwd || deps.cwd || null,
      getSessionWorkspaceFolders: deps.getSessionWorkspaceFolders,
      getSessionAuthorizedFolders: deps.getSessionAuthorizedFolders,
      getAuthorizedFolders: deps.getAuthorizedFolders,
      getSessionCwd: deps.getSessionCwd,
    },
  });
  if (decision?.action === "allow") {
    return { allowed: true, status: "approved", decision };
  }
  if (decision?.action === "ask_user") {
    return { allowed: false, status: "ask_user", decision, reason: decision.reason };
  }
  return {
    allowed: false,
    status: decision?.action === "hard_deny" ? "blocked" : "denied",
    decision,
    reason: decision?.reason || "auto approval denied this action",
  };
}

export function wrapWithSessionPermission(tools = [], deps = {}) {
  return tools.map((tool) => {
    if (!tool?.execute || tool._sessionPermissionWrapped) return tool;
    return {
      ...tool,
      _sessionPermissionWrapped: true,
      execute: async (...args) => {
        const params = args[1] || {};
        const signal = args.slice(2).find(value => value && typeof value.aborted === "boolean" && typeof value.addEventListener === "function");
        if (signal?.aborted) return toolError("Action cancelled before execution.", { errorCode: "ACTION_ABORTED" });
        const toolTraceId = args[0] ? `tooltrace_${String(args[0]).slice(0, 120)}` : undefined;
        const ctx = findRuntimeCtx(args);
        const sessionPath = getToolSessionPath(ctx) || ctx?.sessionPath || deps.getSessionPath?.() || null;
        const actionId = sessionPath && args[0] ? toolActionId(sessionPath, String(args[0])) : null;
        const initialDigest = approvalDigest(tool.name, params, sessionPath);
        let initialPermission;
        try { initialPermission = currentPermissionState(tool, ctx, deps); }
        catch { return toolError("Current permission scope could not be verified.", { errorCode: "APPROVAL_SCOPE_UNAVAILABLE" }); }
        const initialScopeDigest = initialPermission.digest;
        const traceCtx = resolveTraceContext(ctx, sessionPath, deps);
        const mode = initialPermission.mode;
        const executeWithLedger = async (permission) => {
          if (signal?.aborted) return toolError("Action cancelled before execution.", { errorCode: "ACTION_ABORTED" });
          let currentPermission;
          try { currentPermission = currentPermissionState(tool, ctx, deps); }
          catch { return toolError("Current permission scope could not be verified.", { errorCode: "APPROVAL_SCOPE_UNAVAILABLE" }); }
          if (approvalDigest(tool.name, params, sessionPath) !== initialDigest || currentPermission.digest !== initialScopeDigest) {
            return toolError("Action parameters or permission scope changed during approval. Request fresh approval under the current permissions.", { errorCode: "APPROVAL_PARAMETERS_CHANGED" });
          }
          const ledger = deps.actionLedger;
          if (!ledger) return tool.execute(...args);
          if (!sessionPath || !args[0]) {
            return toolError('Durable execution requires a stable session and tool call ID.', { errorCode: 'ACTION_ID_REQUIRED' });
          }
          let record;
          try {
            record = ledger.begin({
              actionId,
              toolName: tool.name,
              parameterDigest: initialDigest,
              scopeDigest: initialScopeDigest,
              sessionRef: toolActionSessionRef(sessionPath),
              readOnly: isRetrySafeRead(tool),
              traceId: traceCtx?.traceId,
              toolTraceId: traceCtx?.toolTraceId || toolTraceId,
              approval: permission,
            });
          } catch (error) {
            return toolError(error?.code === 'ACTION_ALREADY_COMPLETED'
              ? 'This action already completed; it was not executed again.'
              : 'Action execution is blocked. Inspect the durable action record and reconcile any external result before retrying.',
              { errorCode: error?.code?.startsWith('ACTION_') ? error.code : 'ACTION_LEDGER_UNAVAILABLE', actionId });
          }
          let result;
          try { result = await tool.execute(...args); } catch (error) {
            // A timeout/throw cannot establish that an external write did not happen.
            try { ledger.finish(record, false); } catch { /* Existing running record remains fail-closed. */ }
            throw error;
          }
          try { ledger.finish(record, inferResultStatus(result) === 'success'); } catch {
            return toolError('The tool returned, but its completion could not be durably recorded. Check its result before retrying.',
              { errorCode: 'ACTION_RESULT_UNKNOWN', actionId });
          }
          return result;
        };
        const gatewayRequest = buildToolApprovalGatewayRequest(tool, tool.name, params, sessionPath, ctx?.agentId || null);
        const safety = evaluateToolSafetyPolicy(gatewayRequest);
        if (safety?.action === "block") {
          recordToolTrace(deps, tool, traceCtx, {
            toolTraceId,
            params,
            permission: {
              mode,
              decision: "blocked",
              reason: safety.reason,
              reviewer: safety.reviewer,
              risk: safety.risk,
            },
            result: { status: "blocked" },
          });
          return toolError(safety.reason, {
            errorCode: safety.code,
            permissionMode: mode,
            toolName: tool.name,
            reviewer: safety.reviewer,
            risk: safety.risk,
            ruleIds: safety.ruleIds,
          });
        }

        const decision = classifySessionPermission({ mode, toolName: tool.name, params, context: initialPermission.context });
        if (decision.action === "allow") {
          recordToolTrace(deps, tool, traceCtx, {
            toolTraceId,
            params,
            permission: { mode, decision: "allowed" },
            result: { status: "running" },
          });
          try {
            const result = await executeWithLedger({ mode, decision: "allowed" });
            recordToolTrace(deps, tool, traceCtx, {
              toolTraceId,
              params,
              permission: { mode, decision: "allowed" },
              result: { status: inferResultStatus(result) },
            });
            return result;
          } catch (err) {
            recordToolTrace(deps, tool, traceCtx, {
              toolTraceId,
              params,
              permission: { mode, decision: "allowed" },
              result: { status: "thrown_error", message: err?.message || String(err) },
            });
            throw err;
          }
        }
        if (decision.action === "deny") {
          recordToolTrace(deps, tool, traceCtx, {
            toolTraceId,
            params,
            permission: { mode, decision: "denied", reason: decision.code },
            result: { status: "blocked" },
          });
          return toolError(decision.message, {
            errorCode: decision.code,
            permissionMode: mode,
            toolName: tool.name,
            ...(decision.details || {}),
          });
        }

        if (decision.action === "review") {
          const review = await reviewToolApproval(tool, tool.name, params, sessionPath, deps, ctx, actionId);
          if (review.allowed && approvalDigest(tool.name, params, sessionPath) !== initialDigest) {
            return toolError('Tool parameters changed during approval; request approval again.', { errorCode: 'APPROVAL_PARAMETERS_CHANGED' });
          }
          if (review.allowed) {
            recordToolTrace(deps, tool, traceCtx, {
              toolTraceId,
              params,
              permission: {
                mode,
                decision: "approved",
                reviewer: review.decision?.reviewer,
                risk: review.decision?.risk,
              },
              result: { status: "running" },
            });
            try {
              const result = await executeWithLedger({ mode, decision: "approved", reviewer: review.decision?.reviewer });
              recordToolTrace(deps, tool, traceCtx, {
                toolTraceId,
                params,
                permission: {
                  mode,
                  decision: "approved",
                  reviewer: review.decision?.reviewer,
                  risk: review.decision?.risk,
                },
                result: { status: inferResultStatus(result) },
              });
              return result;
            } catch (err) {
              recordToolTrace(deps, tool, traceCtx, {
                toolTraceId,
                params,
                permission: {
                  mode,
                  decision: "approved",
                  reviewer: review.decision?.reviewer,
                  risk: review.decision?.risk,
                },
                result: { status: "thrown_error", message: err?.message || String(err) },
              });
              throw err;
            }
          }
          if (review.status !== "ask_user") {
            recordToolTrace(deps, tool, traceCtx, {
              toolTraceId,
              params,
              permission: {
                mode,
                decision: review.status,
                reason: review.reason,
                reviewer: review.decision?.reviewer,
                risk: review.decision?.risk,
              },
              result: { status: "blocked" },
            });
            return toolOk("Tool action was not approved.", {
              action: tool.name,
              confirmed: false,
              confirmation: {
                kind: "tool_action_approval",
                status: review.status,
                toolName: tool.name,
                reason: review.reason,
                reviewer: review.decision?.reviewer,
                risk: review.decision?.risk,
              },
            });
          }
        }

        const approval = await askForToolApproval(tool.name, params, sessionPath, deps, actionId || toolTraceId || gatewayRequest.id, initialScopeDigest, signal);
        if (!approval.allowed) {
          recordToolTrace(deps, tool, traceCtx, {
            toolTraceId,
            params,
            permission: {
              mode,
              decision: approval.status,
              confirmId: approval.confirmId,
              reason: approval.reason,
            },
            result: { status: "blocked" },
          });
          return toolOk("Tool action was not approved.", {
            action: tool.name,
            confirmed: false,
            confirmation: {
              kind: "tool_action_approval",
              status: approval.status,
              confirmId: approval.confirmId,
              toolName: tool.name,
              reason: approval.reason,
            },
          });
        }
        recordToolTrace(deps, tool, traceCtx, {
          toolTraceId,
          params,
          permission: { mode, decision: "confirmed", confirmId: approval.confirmId },
          result: { status: "running" },
        });
        try {
          const result = await executeWithLedger({ mode, decision: "confirmed", confirmId: approval.confirmId });
          recordToolTrace(deps, tool, traceCtx, {
            toolTraceId,
            params,
            permission: { mode, decision: "confirmed", confirmId: approval.confirmId },
            result: { status: inferResultStatus(result) },
          });
          return result;
        } catch (err) {
          recordToolTrace(deps, tool, traceCtx, {
            toolTraceId,
            params,
            permission: { mode, decision: "confirmed", confirmId: approval.confirmId },
            result: { status: "thrown_error", message: err?.message || String(err) },
          });
          throw err;
        }
      },
    };
  });
}
