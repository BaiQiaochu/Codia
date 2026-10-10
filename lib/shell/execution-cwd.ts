import { statSync as fsStatSync } from "fs";
import path from "path";

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

const ERROR_CODES = {
  invalid: "CODIA_EXEC_CWD_INVALID",
  relative: "CODIA_EXEC_CWD_RELATIVE",
  missing: "CODIA_EXEC_CWD_MISSING",
  "not-directory": "CODIA_EXEC_CWD_NOT_DIRECTORY",
};

function messageFor(status, cwd) {
  switch (status) {
    case "invalid":
      return "Working directory is required for command execution but was empty.";
    case "relative":
      return `Working directory must be an absolute path, got: ${cwd}`;
    case "missing":
      return `Working directory does not exist: ${cwd}. ` +
        "The folder may have been deleted, renamed, moved, or its drive disconnected. " +
        "Pick an existing working directory, then retry.";
    case "not-directory":
      return `Working directory is not a directory: ${cwd}`;
    default:
      return `Working directory check failed for: ${cwd}`;
  }
}

export function classifyExecutionCwd(cwd, { statSync = fsStatSync } = {}) {
  const raw = typeof cwd === "string" ? cwd.trim() : "";
  if (!raw) return { status: "invalid", cwd: raw, errorCode: null };
  if (!path.isAbsolute(raw) && !path.win32.isAbsolute(raw)) {
    return { status: "relative", cwd: raw, errorCode: null };
  }

  try {
    const stat = statSync(raw);
    return stat.isDirectory()
      ? { status: "ok", cwd: raw, errorCode: null }
      : { status: "not-directory", cwd: raw, errorCode: null };
  } catch (err) {
    const errorCode = typeof err?.code === "string" ? err.code : null;
    return {
      status: MISSING_CODES.has(errorCode) ? "missing" : "unreadable",
      cwd: raw,
      errorCode,
    };
  }
}

export function assertExecutionCwd(cwd, deps = {}) {
  const result = classifyExecutionCwd(cwd, deps);
  if (result.status === "ok" || result.status === "unreadable") return result.cwd;
  const err: any = new Error(messageFor(result.status, result.cwd));
  err.code = ERROR_CODES[result.status];
  err.cwd = result.cwd;
  throw err;
}
