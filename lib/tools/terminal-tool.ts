// @ts-nocheck
import { Type } from "../pi-sdk/index.ts";
import { getToolSessionPath } from "./tool-session.ts";

const READ_ACTIONS = new Set(["read", "list"]);

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function normalizeAction(action) {
  const text = typeof action === "string" ? action.trim().toLowerCase() : "";
  if (["start", "write", "read", "close", "list"].includes(text)) return text;
  return "";
}

function optionalNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function createTerminalTool({
  getTerminalSessionManager,
  getAgentId,
  getCwd,
} = {}) {
  return {
    name: "terminal",
    label: "terminal",
    description:
      "Manage per-session persistent terminal sessions. Use bash for short one-shot commands. Use terminal only for long-running or interactive processes that need continued stdin/stdout, such as dev servers, REPLs, ssh, or shells. Actions: start, write, read, close, list.",
    parameters: Type.Object({
      action: Type.String({ description: "One of: start, write, read, close, list." }),
      terminal_id: Type.Optional(Type.String({ description: "Terminal id returned by action=start or action=list." })),
      command: Type.Optional(Type.String({ description: "Command to start in a PTY. Omit to start an interactive shell." })),
      chars: Type.Optional(Type.String({ description: "Input to write to the terminal for action=write." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for action=start. Defaults to the current session cwd." })),
      label: Type.Optional(Type.String({ description: "Short human label for action=start." })),
      since_seq: Type.Optional(Type.Number({ description: "Only return transcript chunks after this sequence number for action=read." })),
      cols: Type.Optional(Type.Number({ description: "PTY columns for action=start." })),
      rows: Type.Optional(Type.Number({ description: "PTY rows for action=start." })),
    }),
    execute: async (_toolCallId, params = {}, _signal, _onUpdate, ctx) => {
      const action = normalizeAction(params.action);
      if (!action) {
        return textResult("terminal action must be one of: start, write, read, close, list", {
          errorCode: "TERMINAL_INVALID_ACTION",
        });
      }
      const sessionPath = getToolSessionPath(ctx);
      if (!sessionPath) {
        return textResult("current session is required to use terminal", {
          errorCode: "TERMINAL_SESSION_REQUIRED",
        });
      }
      const manager = getTerminalSessionManager?.();
      if (!manager) {
        return textResult("terminal manager unavailable", {
          errorCode: "TERMINAL_MANAGER_UNAVAILABLE",
        });
      }

      if (action === "list") {
        return jsonResult(manager.list(sessionPath));
      }

      if (action === "start") {
        const cwd = params.cwd || ctx?.sessionManager?.getCwd?.() || getCwd?.() || process.cwd();
        const result = await manager.start({
          sessionPath,
          agentId: getAgentId?.() || "",
          cwd,
          command: params.command || "",
          label: params.label || "",
          cols: optionalNumber(params.cols, 80),
          rows: optionalNumber(params.rows, 24),
        });
        return jsonResult(result);
      }

      const terminalId = params.terminal_id || params.terminalId;
      if (!terminalId) {
        return textResult("terminal_id is required", {
          errorCode: "TERMINAL_ID_REQUIRED",
          action,
        });
      }

      if (action === "read") {
        return jsonResult(manager.read({
          sessionPath,
          terminalId,
          sinceSeq: optionalNumber(params.since_seq, 0),
        }));
      }

      if (action === "write") {
        return jsonResult(manager.write({
          sessionPath,
          terminalId,
          chars: params.chars || "",
        }));
      }

      if (action === "close") {
        return jsonResult(manager.close({ sessionPath, terminalId }));
      }

      return textResult(`terminal action ${action} is not implemented`, {
        errorCode: "TERMINAL_ACTION_UNIMPLEMENTED",
        action,
        readOnlyAction: READ_ACTIONS.has(action),
      });
    },
  };
}
