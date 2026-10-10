// @ts-nocheck
/**
 * tool-wrapper.js -工具沙盒包装
 *
 * -Pi SDK 工具-execute 外面套一层路径校验- * 被拦截时返回 LLM 可读的文本错误，不抛异常- *
  * */

import fs from "fs";
import path from "path";
import { t } from "../i18n.ts";
import { normalizeWin32ShellPath } from "./win32-path.ts";

/** */
function blockedResult(reason) {
  return {
    content: [{ type: "text", text: t("sandbox.blocked", { reason }) }],
  };
}

function findRuntimeCtx(rest) {
  for (let i = rest.length - 1; i >= 0; i--) {
    const value = rest[i];
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

function resolveTraceContext(opts, rest) {
  const fallback = opts.getTraceContext?.() || null;
  const runtimeCtx = findRuntimeCtx(rest);
  return {
    ...(fallback || {}),
    ...(runtimeCtx || {}),
  };
}

function basename(value) {
  return String(value).replace(/\\/g, "/").split("/").filter(Boolean).pop() || String(value);
}

function summarizeSafeInput(params) {
  if (!params || typeof params !== "object") return null;
  const summary = { keys: Object.keys(params).slice(0, 40) };
  const pathValue = params.path || params.file_path || params.filePath;
  if (typeof pathValue === "string" && pathValue.trim()) {
    summary.pathBasename = basename(pathValue.trim());
  }
  if (typeof params.command === "string" && params.command.trim()) {
    summary.commandKind = params.command.trim().split(/\s+/)[0].slice(0, 80);
  }
  const urlValue = params.url || params.href;
  if (typeof urlValue === "string" && urlValue.trim()) {
    try { summary.urlHost = new URL(urlValue).host; } catch { summary.urlHost = ""; }
  }
  return summary;
}

function buildSandboxMetadata(opts, traceCtx, enabled) {
  let networkEnabled = null;
  try {
    networkEnabled = typeof opts.getSandboxNetworkEnabled === "function"
      ? opts.getSandboxNetworkEnabled() !== false
      : null;
  } catch {
    networkEnabled = null;
  }
  const executionBoundary = traceCtx?.executionBoundary || opts.executionBoundary || null;
  return {
    enabled,
    platform: opts.platform || process.platform,
    networkEnabled,
    boundaryId: executionBoundary?.boundaryId || traceCtx?.boundaryId || null,
  };
}

function recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, sandbox, result) {
  if (!traceCtx?.traceId || typeof opts.recordToolCall !== "function") return;
  try {
    opts.recordToolCall({
      traceId: traceCtx.traceId,
      toolTraceId: traceCtx.toolTraceId || (toolCallId ? `tooltrace_${String(toolCallId).slice(0, 120)}` : undefined),
      toolName: tool?.name || "unknown",
      source: tool?._pluginId || tool?.pluginId ? "plugin" : (tool?._toolSource || "builtin"),
      agentId: traceCtx.agentId || null,
      pluginId: tool?._pluginId || tool?.pluginId || null,
      input: summarizeSafeInput(params),
      sandbox,
      result,
    });
  } catch {
    // Trace writes are diagnostic-only and must not affect tool execution.
  }
}

/** 解析工具参数中的路径为绝对路-*/
function resolvePath(rawPath, cwd) {
  if (!rawPath) return null;
  if (process.platform === "win32") {
    return normalizeWin32ShellPath(rawPath, cwd, { allowRelative: true });
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function normalizeExistingOrResolvedPath(filePath) {
  const resolved = path.resolve(filePath);
  try { return fs.realpathSync(resolved); }
  catch { return resolved; }
}

function isInsideRoot(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function externalReadGrantCovers(targetPath, grantPath) {
  const target = normalizeExistingOrResolvedPath(targetPath);
  const grant = normalizeExistingOrResolvedPath(grantPath);
  if (target === grant) return true;
  try {
    return fs.statSync(grant).isDirectory() && isInsideRoot(target, grant);
  } catch {
    return false;
  }
}

function hasExternalReadGrant(absolutePath, opts = {}) {
  if (!absolutePath || typeof opts.getExternalReadPaths !== "function") return false;
  let grants = [];
  try {
    grants = opts.getExternalReadPaths() || [];
  } catch {
    return false;
  }
  return grants.some((grantPath) => grantPath && externalReadGrantCovers(absolutePath, grantPath));
}

function checkWithExternalReadGrant(guard, absolutePath, operation, opts = {}) {
  const result = guard.check(absolutePath, operation);
  if (result.allowed) return result;
  if (operation === "read" && hasExternalReadGrant(absolutePath, opts)) return { allowed: true };
  return result;
}

function shouldSkipCommandPathGuard(operation) {
  return process.platform === "win32" && operation === "read";
}

function checkManagedConfigWrite(absolutePath, operation, opts = {}) {
  if (!absolutePath || typeof opts.checkManagedConfigWrite !== "function") {
    return { allowed: true };
  }
  if (operation !== "write" && operation !== "delete") {
    return { allowed: true };
  }
  try {
    return opts.checkManagedConfigWrite(absolutePath, operation) || { allowed: true };
  } catch (err) {
    return {
      allowed: false,
      reason: err?.message || String(err),
    };
  }
}

/**
 * 轻量 preflight 模式匹配
 * macOS/Linux: 体验层（OS 沙盒兜底- * Windows: 安全层之丢（restricted-token helper 之前的契约检查）
 */
const PREFLIGHT_UNIX = [
  [/\bsudo\s/, () => t("sandbox.noSudo")],
  [/\bsu\s+\w/, () => t("sandbox.noSu")],
  [/\bchmod\s/, () => t("sandbox.noChmod")],
  [/\bchown\s/, () => t("sandbox.noChown")],
];

const PREFLIGHT_WIN32 = [
  [/\bdel\s+\/s/i, () => t("sandbox.noDelRecursive")],
  [/\brmdir\s+\/s/i, () => t("sandbox.noRmdirRecursive")],
  [/\breg\s+(delete|add)\b/i, () => t("sandbox.noRegEdit")],
  [/\btakeown\b/i, () => t("sandbox.noTakeown")],
  [/\bicacls\b/i, () => t("sandbox.noIcacls")],
  [/\bnet\s+(user|localgroup)\b/i, () => t("sandbox.noNetUser")],
  [/\bschtasks\s+\/create\b/i, () => t("sandbox.noSchtasks")],
  [/\bsc\s+(create|delete)\b/i, () => t("sandbox.noScService")],
  [/powershell.*-e(xecutionpolicy)?\s*(bypass|unrestricted)/i, () => t("sandbox.noPsExecutionBypass")],
  [/\bformat\s+[a-z]:/i, () => t("sandbox.noFormat")],
  [/\bbcdedit\b/i, () => t("sandbox.noBcdedit")],
  [/\bwmic\b/i, () => t("sandbox.noWmic")],
];

const PREFLIGHT_PATTERNS = process.platform === "win32"
  ? [...PREFLIGHT_UNIX, ...PREFLIGHT_WIN32]
  : PREFLIGHT_UNIX;

/**
 * -bash 命令中提取可能的文件路径（启发式- * 用于 Windows restricted-token 执行前的 PathGuard 校验
 */
const OP_PRIORITY = { read: 1, write: 2, delete: 3 };
const READ_PATH_COMMANDS = new Set(["cat", "ls", "less", "head", "tail", "stat", "file", "find"]);
const WRITE_PATH_COMMANDS = new Set(["touch", "mkdir", "tee"]);
const DELETE_PATH_COMMANDS = new Set(["rm", "rmdir"]);
const COPY_MOVE_COMMANDS = new Set(["cp", "mv"]);
function readShellWord(command, start) {
  let word = "";
  let quote = null;
  let i = start;

  for (; i < command.length; i++) {
    const ch = command[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }

    if (quote === "\"") {
      if (ch === "\"") {
        quote = null;
      } else if (ch === "\\" && i + 1 < command.length && /["\\$`\n]/.test(command[i + 1])) {
        word += command[++i];
      } else {
        word += ch;
      }
      continue;
    }

    if (/\s|[;&|<>]/.test(ch)) break;
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      continue;
    }
    word += ch;
  }

  return { word, end: i };
}

function splitShellSegments(command) {
  const segments = [];
  let quote = null;
  let escaped = false;
  let start = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }

    const isSeparator = ch === ";" || ch === "|" || (ch === "&" && command[i + 1] === "&");
    if (!isSeparator) continue;

    const segment = command.slice(start, i).trim();
    if (segment) segments.push(segment);
    if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
    start = i + 1;
  }

  const tail = command.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

function tokenizeShellWords(command) {
  const words = [];
  for (let i = 0; i < command.length;) {
    while (/\s/.test(command[i] || "")) i++;
    if (i >= command.length) break;
    if (/[;&|<>]/.test(command[i])) {
      i++;
      continue;
    }
    const { word, end } = readShellWord(command, i);
    if (word) words.push(word);
    i = Math.max(end, i + 1);
  }
  return words;
}

function commandName(word) {
  return String(word || "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function normalizePathForCheck(rawPath, cwd, allowRelative) {
  if (process.platform === "win32") {
    return normalizeWin32ShellPath(rawPath, cwd, { allowRelative });
  }
  if (path.isAbsolute(rawPath)) return rawPath;
  return allowRelative && cwd ? path.resolve(cwd, rawPath) : null;
}

function isPosixNullDevicePath(filePath) {
  return process.platform !== "win32" && filePath === "/dev/null";
}

function rememberCheck(checks, rawPath, operation, cwd, allowRelative = false, {
  skipPosixNullDevice = false,
} = {}) {
  const normalized = normalizePathForCheck(rawPath, cwd, allowRelative);
  if (!normalized) return;
  if (skipPosixNullDevice && isPosixNullDevicePath(normalized)) return;
  const previous = checks.get(normalized);
  if (!previous || OP_PRIORITY[operation] > OP_PRIORITY[previous.operation]) {
    checks.set(normalized, { path: normalized, rawPath, operation });
  }
}

function extractRedirectionChecks(command, cwd, checks) {
  let quote = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch !== ">" && ch !== "<") continue;

    const operation = ch === ">" ? "write" : "read";
    let targetStart = i + 1;
    if (command[targetStart] === ch || command[targetStart] === "|") targetStart++;
    if (operation === "read" && command[targetStart] === "(") continue;
    while (/\s/.test(command[targetStart] || "")) targetStart++;
    if (command[targetStart] === "&") continue;

    const { word } = readShellWord(command, targetStart);
    if (word) rememberCheck(checks, word, operation, cwd, true, { skipPosixNullDevice: true });
  }
}

function extractSegmentChecks(segment, cwd, checks) {
  const words = tokenizeShellWords(segment);
  if (!words.length) return;

  const name = commandName(words[0]);
  const operands = words.slice(1).filter((word) => word && !word.startsWith("-"));

  for (const word of words) {
    rememberCheck(checks, word, "read", cwd, false);
  }

  if (DELETE_PATH_COMMANDS.has(name)) {
    for (const word of operands) rememberCheck(checks, word, "delete", cwd, true);
    return;
  }

  if (WRITE_PATH_COMMANDS.has(name)) {
    for (const word of operands) rememberCheck(checks, word, "write", cwd, true);
    return;
  }

  if (COPY_MOVE_COMMANDS.has(name)) {
    const pathOperands = operands.filter((word) => normalizePathForCheck(word, cwd, true));
    pathOperands.forEach((word, index) => {
      const operation = index === pathOperands.length - 1 ? "write" : "read";
      rememberCheck(checks, word, operation, cwd, true);
    });
    return;
  }

  if (READ_PATH_COMMANDS.has(name)) {
    for (const word of operands) rememberCheck(checks, word, "read", cwd, true);
  }
}

function extractPathChecks(command, cwd) {
  const checks = new Map();
  extractRedirectionChecks(command, cwd, checks);
  for (const segment of splitShellSegments(command)) {
    extractSegmentChecks(segment, cwd, checks);
  }
  return [...checks.values()];
}

/**
 * 包装路径类工具（read, write, edit, grep, find, ls- *
 * @param {object} tool 原始工具
 * @param {object} guard PathGuard 实例
 * @param {string} operation  "read" | "write" | "delete"
  *
 * @param {object} [opts]
  *
 */
export function wrapPathTool(tool, guard, operation, cwd, opts = {}) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const traceCtx = resolveTraceContext(opts, rest);
      const start = Date.now();
      const rawPath = params.path;
      const absolutePath = resolvePath(rawPath, cwd);
      const managedConfigCheck = checkManagedConfigWrite(absolutePath, operation, opts);
      if (!managedConfigCheck.allowed) {
        recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, buildSandboxMetadata(opts, traceCtx, true), {
          status: "blocked",
          reason: "managed_config",
          durationMs: Date.now() - start,
        });
        return blockedResult(managedConfigCheck.reason);
      }

 //
      if (opts.getSandboxEnabled && !opts.getSandboxEnabled()) {
        const sandbox = buildSandboxMetadata(opts, traceCtx, false);
        try {
          const toolResult = await tool.execute(toolCallId, params, ...rest);
          recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, sandbox, {
            status: "success",
            durationMs: Date.now() - start,
          });
          return toolResult;
        } catch (err) {
          recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, sandbox, {
            status: "thrown_error",
            message: err?.message || String(err),
            durationMs: Date.now() - start,
          });
          throw err;
        }
      }

      const checkPath = absolutePath || cwd;
      const result = checkWithExternalReadGrant(guard, checkPath, operation, opts);

      if (!result.allowed) {
        recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, buildSandboxMetadata(opts, traceCtx, true), {
          status: "blocked",
          reason: result.reason,
          durationMs: Date.now() - start,
        });
        return blockedResult(result.reason);
      }

      const sandbox = buildSandboxMetadata(opts, traceCtx, true);
      try {
        const toolResult = await tool.execute(toolCallId, params, ...rest);
        recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, sandbox, {
          status: "success",
          durationMs: Date.now() - start,
        });
        return toolResult;
      } catch (err) {
        recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, sandbox, {
          status: "thrown_error",
          message: err?.message || String(err),
          durationMs: Date.now() - start,
        });
        throw err;
      }
    },
  };
}

/**
  *
 *
  *
 *
  *
 * @param {object} [opts]
  * */
export function wrapBashTool(tool, guard, cwd, opts = {}) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const traceCtx = resolveTraceContext(opts, rest);
      const start = Date.now();
      let pathChecks = null;
      if (cwd && typeof opts.checkManagedConfigWrite === "function") {
        pathChecks = extractPathChecks(params.command, cwd);
        for (const p of pathChecks) {
          const managedConfigCheck = checkManagedConfigWrite(p.path, p.operation, opts);
          if (!managedConfigCheck.allowed) {
            recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, buildSandboxMetadata(opts, traceCtx, true), {
              status: "blocked",
              reason: "managed_config",
              durationMs: Date.now() - start,
            });
            return blockedResult(managedConfigCheck.reason);
          }
        }
      }

 //
      if (opts.getSandboxEnabled && !opts.getSandboxEnabled()) {
        const sandbox = buildSandboxMetadata(opts, traceCtx, false);
        try {
          const result = await (opts.fallbackTool || tool).execute(toolCallId, params, ...rest);
          recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, sandbox, {
            status: "success",
            durationMs: Date.now() - start,
          });
          return result;
        } catch (err) {
          recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, sandbox, {
            status: "thrown_error",
            message: err?.message || String(err),
            durationMs: Date.now() - start,
          });
          throw err;
        }
      }

      // preflight
      for (const [pattern, reasonFn] of PREFLIGHT_PATTERNS) {
        if (pattern.test(params.command)) {
          recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, buildSandboxMetadata(opts, traceCtx, true), {
            status: "blocked",
            reason: "preflight",
            durationMs: Date.now() - start,
          });
          return blockedResult(reasonFn());
        }
      }

 // 路径校验：从命令中提取绝对路径，棢-PathGuard
      if (guard && cwd) {
        const paths = pathChecks || extractPathChecks(params.command, cwd);
        for (const p of paths) {
          if (shouldSkipCommandPathGuard(p.operation)) continue;
          const result = checkWithExternalReadGrant(guard, p.path, p.operation, opts);
          if (!result.allowed) {
            recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, buildSandboxMetadata(opts, traceCtx, true), {
              status: "blocked",
              reason: result.reason,
              durationMs: Date.now() - start,
            });
            return blockedResult(t("sandbox.restrictedPath", { path: p.rawPath }));
          }
        }
      }

      const sandbox = buildSandboxMetadata(opts, traceCtx, true);
      try {
        const result = await tool.execute(toolCallId, params, ...rest);

 //
        const text = result?.content?.[0]?.text;
        if (text && text.includes("Operation not permitted")) {
          result.content[0].text += "\n\n" + t("sandbox.writeRestricted");
        }

        recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, sandbox, {
          status: "success",
          durationMs: Date.now() - start,
        });
        return result;
      } catch (err) {
 //
        if (err.message?.includes("Operation not permitted")) {
          err.message += "\n\n" + t("sandbox.writeRestricted");
        }
        recordSandboxTrace(opts, tool, traceCtx, toolCallId, params, sandbox, {
          status: "thrown_error",
          message: err?.message || String(err),
          durationMs: Date.now() - start,
        });
        throw err;
      }
    },
  };
}
