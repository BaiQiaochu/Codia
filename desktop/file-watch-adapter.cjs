const path = require("path");
const fs = require("fs");
const chokidar = require("chokidar");
const { normalizeFileWatchPath } = require("./file-watch-path.cjs");

function createStableFileWatcher(filePath, options = {}, onChange) {
  if (typeof onChange !== "function") {
    throw new Error("createStableFileWatcher: onChange function required");
  }

  const { pollIntervalMs: requestedPollIntervalMs, ...watchOptions } = options;
  const targetPath = path.resolve(filePath);
  const targetKey = normalizeFileWatchPath(targetPath);
  const parentDir = path.dirname(targetPath);
  let lastEmittedSignature = statSignature(targetPath);

  function emitTargetChange(eventType) {
    const signature = statSignature(targetPath);
    if (signature && signature === lastEmittedSignature) return;
    lastEmittedSignature = signature;
    onChange(eventType, targetPath);
  }

  const watcher = chokidar.watch(parentDir, {
    ...watchOptions,
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: false,
    ignorePermissionErrors: true,
    depth: 0,
  });

  watcher.on("all", (eventType, changedPath) => {
    if (!changedPath) return;
    if (normalizeFileWatchPath(changedPath) !== targetKey) return;
    emitTargetChange(eventType);
  });

  const pollIntervalMs = Number.isFinite(Number(requestedPollIntervalMs))
    ? Math.max(50, Number(requestedPollIntervalMs))
    : 100;
  const pollListener = (curr, prev) => {
    if (!statChanged(curr, prev)) return;
    emitTargetChange(curr.nlink === 0 ? "unlink" : "change");
  };
  fs.watchFile(targetPath, { interval: pollIntervalMs, persistent: false }, pollListener);

  const close = watcher.close.bind(watcher);
  watcher.close = (...args) => {
    fs.unwatchFile(targetPath, pollListener);
    return close(...args);
  };

  return watcher;
}

function statSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ].join(":");
  } catch {
    return "missing";
  }
}

function statChanged(curr, prev) {
  return curr.nlink !== prev.nlink
    || curr.size !== prev.size
    || curr.mtimeMs !== prev.mtimeMs
    || curr.ctimeMs !== prev.ctimeMs
    || curr.ino !== prev.ino
    || curr.dev !== prev.dev;
}

module.exports = {
  createStableFileWatcher,
  normalizeFileWatchPath,
};
