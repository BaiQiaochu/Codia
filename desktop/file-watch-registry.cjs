const path = require("path");
const { normalizeFileWatchPath } = require("./file-watch-path.cjs");

function createFileWatchRegistry({ watch, notifySubscriber, debounceMs = 50 } = {}) {
  if (typeof watch !== "function") {
    throw new Error("createFileWatchRegistry: watch function required");
  }
  if (typeof notifySubscriber !== "function") {
    throw new Error("createFileWatchRegistry: notifySubscriber function required");
  }

  const entries = new Map();
  const filesBySubscriber = new Map();

  function bindSubscriber(fileKey, subscriberId) {
    let files = filesBySubscriber.get(subscriberId);
    if (!files) {
      files = new Set();
      filesBySubscriber.set(subscriberId, files);
    }
    files.add(fileKey);
  }

  function unbindSubscriber(fileKey, subscriberId) {
    const files = filesBySubscriber.get(subscriberId);
    if (!files) return;
    files.delete(fileKey);
    if (files.size === 0) filesBySubscriber.delete(subscriberId);
  }

  function closeEntry(fileKey, entry) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    try { entry.watcher?.close?.(); } catch {}
    entries.delete(fileKey);
  }

  function ensureEntry(filePath) {
    const resolvedPath = path.resolve(filePath);
    const fileKey = normalizeFileWatchPath(resolvedPath);
    let entry = entries.get(fileKey);
    if (entry) return entry;

    const watcher = watch(resolvedPath, { persistent: false }, (eventType, changedPath) => {
      if (
        eventType !== "change"
        && eventType !== "rename"
        && eventType !== "add"
        && eventType !== "unlink"
      ) {
        return;
      }
      const current = entries.get(fileKey);
      if (!current) return;
      const changed = changedPath ? path.resolve(changedPath) : current.filePath;
      if (normalizeFileWatchPath(changed) !== current.fileKey) return;
      if (current.debounceTimer) clearTimeout(current.debounceTimer);
      current.debounceTimer = setTimeout(() => {
        current.debounceTimer = null;
        const latest = entries.get(fileKey);
        if (!latest) return;
        for (const subscriberId of [...latest.subscribers]) {
          notifySubscriber(subscriberId, latest.filePath);
        }
      }, debounceMs);
    });

    entry = { fileKey, filePath: resolvedPath, watcher, subscribers: new Set(), debounceTimer: null };
    entries.set(fileKey, entry);
    return entry;
  }

  function watchFile(filePath, subscriberId) {
    try {
      const entry = ensureEntry(filePath);
      entry.subscribers.add(subscriberId);
      bindSubscriber(entry.fileKey, subscriberId);
      return true;
    } catch {
      return false;
    }
  }

  function unwatchFile(filePath, subscriberId) {
    const fileKey = normalizeFileWatchPath(filePath);
    const entry = entries.get(fileKey);
    if (!entry) {
      unbindSubscriber(fileKey, subscriberId);
      return true;
    }
    entry.subscribers.delete(subscriberId);
    unbindSubscriber(fileKey, subscriberId);
    if (entry.subscribers.size === 0) {
      closeEntry(fileKey, entry);
    }
    return true;
  }

  function unwatchAllForSubscriber(subscriberId) {
    const files = filesBySubscriber.get(subscriberId);
    if (!files) return;
    for (const fileKey of [...files]) {
      const entry = entries.get(fileKey);
      if (entry) unwatchFile(entry.filePath, subscriberId);
      else unbindSubscriber(fileKey, subscriberId);
    }
  }

  return {
    watchFile,
    unwatchFile,
    unwatchAllForSubscriber,
  };
}

module.exports = { createFileWatchRegistry };
