// @ts-nocheck
import { classifySessionPermission, normalizeSessionPermissionMode } from "../../core/session-permission-mode.ts";
import { getToolSessionPath } from "./tool-session.ts";
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

function buildToolApprovalRequest(confirmId, toolName, params) {
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
      detail: summarizeParams(params),
    },
    severity: "elevated",
    actions: {
      confirmLabel: "同意",
      rejectLabel: "拒绝",
    },
    payload: { toolName, params },
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
  if (result?.details?.errorCode || result?.isError) return "tool_error";
  return "success";
}

async function askForToolApproval(toolName, params, sessionPath, deps) {
  const confirmStore = deps.getConfirmStore?.() || deps.confirmStore || null;
  if (!confirmStore || !sessionPath) {
    return { allowed: false, status: "rejected", confirmId: "", reason: "confirmation-unavailable" };
  }
  const { confirmId, promise } = confirmStore.create(
    "tool_action_approval",
    { toolName, params },
    sessionPath,
  );
  deps.emitEvent?.({
    type: "session_confirmation",
    request: buildToolApprovalRequest(confirmId, toolName, params),
  }, sessionPath);
  const decision = await promise;
  const status = toStatus(decision?.action);
  return {
    allowed: status === "confirmed",
    status,
    confirmId,
  };
}

async function reviewToolApproval(tool, toolName, params, sessionPath, deps, runtimeCtx = null) {
  const gateway = deps.getApprovalGateway?.() || deps.approvalGateway || null;
  if (!gateway || typeof gateway.review !== "function") {
    return {
      allowed: false,
      status: "ask_user",
      reason: "approval-gateway-unavailable",
    };
  }
  const request = buildToolApprovalGatewayRequest(tool, toolName, params, sessionPath, runtimeCtx?.agentId || null);
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
        const toolTraceId = args[0] ? `tooltrace_${String(args[0]).slice(0, 120)}` : undefined;
        const ctx = findRuntimeCtx(args);
        const sessionPath = getToolSessionPath(ctx) || ctx?.sessionPath || deps.getSessionPath?.() || null;
        const traceCtx = resolveTraceContext(ctx, sessionPath, deps);
        const mode = normalizeSessionPermissionMode(
          deps.getPermissionMode?.(sessionPath) || deps.getPermissionMode?.() || "ask",
        );
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

        const decision = classifySessionPermission({ mode, toolName: tool.name, params, context: permissionContextForTool(tool, deps) });
        if (decision.action === "allow") {
          recordToolTrace(deps, tool, traceCtx, {
            toolTraceId,
            params,
            permission: { mode, decision: "allowed" },
            result: { status: "running" },
          });
          try {
            const result = await tool.execute(...args);
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
          const review = await reviewToolApproval(tool, tool.name, params, sessionPath, deps, ctx);
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
              const result = await tool.execute(...args);
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

        const approval = await askForToolApproval(tool.name, params, sessionPath, deps);
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
          const result = await tool.execute(...args);
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
