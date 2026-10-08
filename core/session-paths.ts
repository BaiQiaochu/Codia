import path from "node:path";
import { normalizeSessionLocatorPath } from "./session-manifest/path-normalizer.ts";

/**
 * Isolate path semantics from session/SDK initialization. Production validators
 * always use native realpath normalization, including existing-parent symlinks.
 * Foreign-platform lexical tests pass an explicit path implementation and
 * normalizer; they must not replace Node's global path or filesystem modules.
 */
export function createSessionPathValidators({
  pathImpl = path,
  normalizePath = normalizeSessionLocatorPath,
} = {}) {
  function relativePathInsideBase(targetPath, baseDir) {
    if (typeof targetPath !== "string" || typeof baseDir !== "string") return null;
    if (!targetPath || !baseDir) return null;

    const resolved = normalizePath(targetPath);
    const base = normalizePath(baseDir);
    const rel = pathImpl.relative(base, resolved);
    if (rel === "") return "";
    if (!rel || rel.startsWith("..") || pathImpl.isAbsolute(rel)) return null;
    return rel;
  }

  /**
   * Validate that sessionPath stays under the allowed baseDir.
   * baseDir can be a single-agent sessionDir or the global agentsDir.
   */
  function isValidSessionPath(sessionPath, baseDir) {
    return relativePathInsideBase(sessionPath, baseDir) !== null;
  }

  function desktopSessionParts(sessionPath, agentsDir) {
    const rel = relativePathInsideBase(sessionPath, agentsDir);
    if (rel === null) return false;
    const parts = rel.split(pathImpl.sep);
    if (!parts[0] || !parts[1]) return false;
    return parts;
  }

  function isJsonlFileName(name) {
    return typeof name === "string" && name.endsWith(".jsonl") && pathImpl.basename(name) === name;
  }

  function isActiveDesktopSessionPath(sessionPath, agentsDir) {
    const parts = desktopSessionParts(sessionPath, agentsDir);
    if (!parts || parts.length !== 3) return false;
    if (parts[1] !== "sessions") return false;
    return isJsonlFileName(parts[2]);
  }

  function isArchivedDesktopSessionPath(sessionPath, agentsDir) {
    const parts = desktopSessionParts(sessionPath, agentsDir);
    if (!parts || parts.length !== 4) return false;
    if (parts[1] !== "sessions" || parts[2] !== "archived") return false;
    return isJsonlFileName(parts[3]);
  }

  function isDesktopSessionPath(sessionPath, agentsDir) {
    return isActiveDesktopSessionPath(sessionPath, agentsDir)
      || isArchivedDesktopSessionPath(sessionPath, agentsDir);
  }

  function isActiveSessionPath(sessionPath, agentsDir) {
    return isActiveDesktopSessionPath(sessionPath, agentsDir);
  }

  return {
    relativePathInsideBase,
    isValidSessionPath,
    isActiveDesktopSessionPath,
    isArchivedDesktopSessionPath,
    isDesktopSessionPath,
    isActiveSessionPath,
  };
}

export const {
  relativePathInsideBase,
  isValidSessionPath,
  isActiveDesktopSessionPath,
  isArchivedDesktopSessionPath,
  isDesktopSessionPath,
  isActiveSessionPath,
} = createSessionPathValidators();
