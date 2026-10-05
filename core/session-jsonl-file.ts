// @ts-nocheck
import fs from "fs";

export const DEFAULT_SESSION_JSONL_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_SESSION_JSONL_MAX_STRING_CHARS = 8192;
const DEFAULT_SESSION_JSONL_MAX_ARRAY_ITEMS = 128;
const DEFAULT_SESSION_JSONL_MAX_OBJECT_KEYS = 128;
const LARGE_SESSION_ENTRY_KEYS = new Set([
  "base64",
  "content",
  "data",
  "inlineData",
  "partialArgs",
  "snapshot",
  "text",
  "thumbnail",
]);
const TOOL_ARG_KEYS = new Set(["arguments", "args", "input"]);

export function parseSessionEntries(raw, opts = {}) {
  const maxLineBytes = Math.max(1024, opts.maxLineBytes || DEFAULT_SESSION_JSONL_MAX_LINE_BYTES);
  const entries = [];
  const lines = String(raw || "").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(parseSessionLine(line, maxLineBytes).entry);
    } catch {
      return null;
    }
  }
  if (entries.length === 0) return null;
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") return null;
  return entries;
}

function parseSessionLine(line, maxLineBytes) {
  const byteLength = Buffer.byteLength(line, "utf8");
  const parsed = JSON.parse(line);
  if (byteLength <= maxLineBytes) return { entry: parsed, projected: false, byteLength };
  const projected = projectOversizedSessionEntry(parsed, { originalByteLength: byteLength });
  return { entry: projected, projected: true, byteLength };
}

export function projectOversizedSessionEntry(entry, { originalByteLength = null } = {}) {
  const projected = projectSessionValue(entry, new Set(), {
    inToolArgs: false,
    originalByteLength,
  });
  if (projected && typeof projected === "object" && !Array.isArray(projected)) {
    return {
      ...projected,
      gsapRepair: {
        ...(projected.gsapRepair || {}),
        oversizedLineProjected: true,
        ...(originalByteLength ? { originalByteLength } : {}),
      },
    };
  }
  return projected;
}

export function repairOversizedSessionEntries(entries, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return { entries, projected: 0 };
  const maxLineBytes = Math.max(1024, opts.maxLineBytes || DEFAULT_SESSION_JSONL_MAX_LINE_BYTES);
  let projected = 0;
  const repaired = entries.map((entry) => {
    const line = JSON.stringify(entry);
    const byteLength = Buffer.byteLength(line, "utf8");
    if (byteLength <= maxLineBytes) return entry;
    projected += 1;
    return projectOversizedSessionEntry(entry, { originalByteLength: byteLength });
  });
  return {
    entries: projected > 0 ? repaired : entries,
    projected,
  };
}

function projectSessionValue(value, seen, context) {
  if (typeof value === "string") {
    const limit = context.inToolArgs ? 512 : DEFAULT_SESSION_JSONL_MAX_STRING_CHARS;
    if (value.length <= limit) return value;
    return `[omitted ${value.length} chars by G-SAP session JSONL guard]`;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, DEFAULT_SESSION_JSONL_MAX_ARRAY_ITEMS)
      .map((item) => projectSessionValue(item, seen, context));
    if (value.length > DEFAULT_SESSION_JSONL_MAX_ARRAY_ITEMS) {
      items.push(`[omitted ${value.length - DEFAULT_SESSION_JSONL_MAX_ARRAY_ITEMS} items by G-SAP session JSONL guard]`);
    }
    seen.delete(value);
    return items;
  }

  const out = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= DEFAULT_SESSION_JSONL_MAX_OBJECT_KEYS) {
      out._omittedKeys = Object.keys(value).length - count;
      break;
    }
    count += 1;
    const inToolArgs = context.inToolArgs || TOOL_ARG_KEYS.has(key);
    if ((LARGE_SESSION_ENTRY_KEYS.has(key) || inToolArgs) && typeof item === "string" && item.length > 512) {
      out[key] = `[omitted ${item.length} chars by G-SAP session JSONL guard]`;
      continue;
    }
    out[key] = projectSessionValue(item, seen, { ...context, inToolArgs });
  }
  seen.delete(value);
  return out;
}

export function serializeSessionEntries(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function readSessionEntriesFile(sessionPath) {
  let raw;
  try {
    raw = fs.readFileSync(sessionPath, "utf-8");
  } catch {
    return null;
  }

  const entries = parseSessionEntries(raw);
  if (!entries) return null;
  return { raw, entries };
}

export function repairOversizedSessionEntriesInFile(sessionPath, opts = {}) {
  const maxLineBytes = Math.max(1024, opts.maxLineBytes || DEFAULT_SESSION_JSONL_MAX_LINE_BYTES);
  let raw;
  try {
    raw = fs.readFileSync(sessionPath, "utf-8");
  } catch {
    return { repaired: false, projected: 0, skipped: 0, backupPath: null };
  }

  let changed = false;
  let skipped = 0;
  const entries = [];
  for (const line of String(raw || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      entries.push(parsed);
    } catch {
      skipped += 1;
      changed = true;
    }
  }

  if (entries.length === 0) return { repaired: false, projected: 0, skipped: 0, backupPath: null };
  const repairedEntries = repairOversizedSessionEntries(entries, { maxLineBytes });
  if (repairedEntries.projected > 0) changed = true;
  if (!changed) return { repaired: false, projected: 0, skipped: 0, backupPath: null };

  const header = repairedEntries.entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") {
    return { repaired: false, projected: 0, skipped: 0, backupPath: null };
  }

  const backupPath = `${sessionPath}.repair.jsonl`;
  try {
    if (!fs.existsSync(backupPath)) fs.copyFileSync(sessionPath, backupPath);
    writeSessionEntriesFile(sessionPath, repairedEntries.entries);
  } catch {
    return { repaired: false, projected: 0, skipped: 0, backupPath: null };
  }
  return { repaired: true, projected: repairedEntries.projected, skipped, backupPath };
}

export function writeSessionEntriesFile(sessionPath, entries) {
  fs.writeFileSync(sessionPath, serializeSessionEntries(entries));
}
