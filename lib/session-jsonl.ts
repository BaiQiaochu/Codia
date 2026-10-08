// @ts-nocheck
import fs from "fs";
import path from "path";

const TAIL_READ_THRESHOLD = 256 * 1024;

export function sessionIdFromFilename(filename) {
  return filename.replace(/\.jsonl$/, "");
}

export function listSessionFiles(sessionDir) {
  const results = [];

  function scanDir(dir, prefix) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;
          results.push({
            sessionId: sessionIdFromFilename(path.basename(filePath)),
            filename: prefix ? `${prefix}/${file}` : file,
            filePath,
            mtime: stat.mtime,
          });
        } catch {
          // Ignore files that disappear during scanning.
        }
      }
    } catch {
      // Missing optional session directories are expected.
    }
  }

  if (!sessionDir) return results;
  scanDir(sessionDir, null);
  scanDir(path.join(sessionDir, "bridge", "owner"), "bridge/owner");
  return results;
}

export function readSessionMessages(filePath, opts = {}) {
  const since = opts.since && !Number.isNaN(Date.parse(opts.since))
    ? Date.parse(opts.since)
    : null;
  let raw;

  try {
    const stat = fs.statSync(filePath);
    if (opts.full !== true && stat.size > TAIL_READ_THRESHOLD) {
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(TAIL_READ_THRESHOLD);
        fs.readSync(fd, buf, 0, TAIL_READ_THRESHOLD, stat.size - TAIL_READ_THRESHOLD);
        raw = buf.toString("utf-8");
        const firstNewline = raw.indexOf("\n");
        if (firstNewline !== -1) raw = raw.slice(firstNewline + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(filePath, "utf-8");
    }
  } catch {
    return { messages: [], lastTimestamp: null };
  }

  const messages = [];
  let lastTimestamp = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message" || !entry.message) continue;
      const { role, content } = entry.message;
      if (role !== "user" && role !== "assistant") continue;
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (since && (Number.isNaN(ts) || ts <= since)) continue;
      messages.push({ role, content, timestamp: entry.timestamp || null });
      if (entry.timestamp) lastTimestamp = entry.timestamp;
    } catch {
      // Ignore a malformed line rather than blocking the whole diary path.
    }
  }

  return { messages, lastTimestamp };
}
