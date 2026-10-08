/**
 * Normalize renderer-provided paths for shell.trashItem().
 *
 * Renderer workspace paths may use slash separators on every OS. The Electron
 * main process converts them to the native platform path before touching files.
 */
const path = require("path");

function pathForPlatform(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function resolveTrashItemPath(filePath, platform = process.platform) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  const pathImpl = pathForPlatform(platform);
  if (!pathImpl.isAbsolute(filePath)) return null;
  return pathImpl.resolve(filePath);
}

module.exports = { resolveTrashItemPath };
