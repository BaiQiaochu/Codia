import fs from "fs";
import path from "path";

export function normalizeSessionLocatorPath(sessionPath) {
  if (typeof sessionPath !== "string" || sessionPath.trim() === "") {
    throw new Error("session locator path must be a non-empty string");
  }

  const resolved = path.resolve(sessionPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return normalizeMissingPathFromExistingParent(resolved);
    }
  }
}

export function sessionLocatorKey(sessionPath) {
  const normalized = normalizeSessionLocatorPath(sessionPath);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function normalizeMissingPathFromExistingParent(resolvedPath) {
  const missingParts = [];
  let cursor = resolvedPath;

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolvedPath;
    missingParts.unshift(path.basename(cursor));
    cursor = parent;
  }

  try {
    return path.join(fs.realpathSync.native(cursor), ...missingParts);
  } catch {
    try {
      return path.join(fs.realpathSync(cursor), ...missingParts);
    } catch {
      return resolvedPath;
    }
  }
}
