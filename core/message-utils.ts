/**
 * Message utilities
 *
 * Shared helpers for extracting text/thinking/tool-use data and reading
 * complete session history from JSON and JSONL files.
 */

import fs from "fs/promises";
import path from "path";
import { normalizeSessionLocatorPath } from './session-manifest/path-normalizer.ts';
import { getToolArgs, isToolCallBlock } from "./llm-utils.ts";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { DEFERRED_RESULT_RECORD_TYPE } from "../lib/deferred-result-notification.ts";
import {
  TURN_INPUT_CONSUMPTION_EVENT_TYPE,
  TURN_INPUT_PRESENTATION_EVENT_TYPE,
} from "../lib/turn-input-presentation.ts";
import { isAssistantCommentaryTextBlock } from "../shared/text-signature.ts";

/**
 * Tool argument keys to keep when summarizing tool-call parameters.
 */
export const TOOL_ARG_SUMMARY_KEYS = [
  "file_path", "path", "command", "pattern", "url", "query",
  "key", "value", "action", "type", "schedule", "prompt", "label",
];

const SESSION_TAIL_READ_THRESHOLD = 256 * 1024;
const ATTACHED_IMAGE_MARKER_RE = /\[attached_image:\s*[^\]]+\]/g;
const THINK_OPEN_RE = /<(think(?:ing)?|reflect)(?:>|<\|message\|>)([\s\S]*?)<\/\1>\s*/gi;
const THINK_OPEN_ONLY_RE = /<(?:think(?:ing)?|reflect)(?:>|<\|message\|>)\s*/gi;

type MutableSessionMessage = Record<string, any>;
type AssistantSummaryOptions = {
  maxBytes?: number;
  summaryLimit?: number;
};

function pushSessionMessage(messages, entry) {
  if (!entry || typeof entry !== "object") return;
  if (entry.type === "message" && entry.message) {
    const message = { ...entry.message };
    if (entry.id) message.id = entry.id;
    if (entry.timestamp) message.timestamp = entry.timestamp;
    messages.push(message);
    return;
  }
  if (entry.type === "custom_message" && entry.customType) {
    const message: MutableSessionMessage = {
      role: "custom",
      customType: entry.customType,
      content: entry.content || "",
      display: entry.display,
      ...(entry.details !== undefined ? { details: entry.details } : {}),
    };
    if (entry.id) message.id = entry.id;
    if (entry.timestamp) message.timestamp = entry.timestamp;
    messages.push(message);
    return;
  }
  if (
    entry.type === "custom" &&
    (
      entry.customType === DEFERRED_RESULT_RECORD_TYPE
      || entry.customType === 'codia-execution-run'
      || entry.customType === 'codia-input-presentation'
      || entry.customType === 'codia-agent-review'
      || entry.customType === TURN_INPUT_PRESENTATION_EVENT_TYPE
      || entry.customType === TURN_INPUT_CONSUMPTION_EVENT_TYPE
    )
  ) {
    const message: MutableSessionMessage = {
      role: "custom",
      customType: entry.customType,
      data: entry.data,
      display: false,
    };
    if (entry.id) message.id = entry.id;
    if (entry.timestamp) message.timestamp = entry.timestamp;
    messages.push(message);
    return;
  }
  if (typeof entry.role === "string" && Object.prototype.hasOwnProperty.call(entry, "content")) {
    messages.push(entry);
  }
}

function messagesFromJsonValue(value) {
  const messages = [];

  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (Array.isArray(item.messages)) {
      for (const child of item.messages) visit(child);
      return;
    }
    if (Array.isArray(item.entries)) {
      for (const child of item.entries) visit(child);
      return;
    }
    pushSessionMessage(messages, item);
  };

  visit(value);
  return messages;
}

export function parseSessionHistoryText(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    const messages = messagesFromJsonValue(parsed);
    if (messages.length > 0) return withExecutionRunIds(messages);
  } catch {
    // Fall back to JSONL parsing.
  }

  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      pushSessionMessage(messages, JSON.parse(line));
    } catch {
      // Skip corrupted lines.
    }
  }
  return withExecutionRunIds(messages);
}

function withExecutionRunIds(messages: MutableSessionMessage[]) {
  let runId: string | undefined;
  return messages.filter(message => {
    if (message.customType === 'codia-execution-run') {
      runId = message.data?.schemaVersion === 1 && typeof message.data.runId === 'string' ? message.data.runId : undefined;
      return false;
    }
    if (runId) message.runId = runId;
    return true;
  });
}

/** Extract and strip <think>/<thinking>/<reflect> tags from plain text. */
export function stripThinkTags(raw) {
  const thinkParts = [];
  const text = String(raw ?? "")
    .replace(THINK_OPEN_RE, (_, _tag, inner) => {
      const trimmed = inner.trim();
      if (trimmed) thinkParts.push(trimmed);
      return "";
    })
    .replace(/<\/(?:think(?:ing)?|reflect)>\s*/gi, "")
    .replace(THINK_OPEN_ONLY_RE, "");
  return { text, thinkContent: thinkParts.join("\n") };
}

/**
 * Extract plain text + thinking + tool_use + images from PI SDK content blocks.
 * content can be either a string or an array like:
 * [{type: "text", text: "..."}, {type: "thinking", thinking: "..."}, ...]
 *
 * Returns { text, thinking, toolUses, images }.
 */
export function extractTextContent(content, { stripThink = false } = {}) {
  if (typeof content === "string") {
    if (stripThink) {
      const { text, thinkContent } = stripThinkTags(content);
      return { text, thinking: thinkContent, toolUses: [], images: [] };
    }
    return { text: content, thinking: "", toolUses: [], images: [] };
  }
  if (!Array.isArray(content)) return { text: "", thinking: "", toolUses: [], images: [] };

  const rawText = content
    .filter((block) => block.type === "text" && block.text && !isAssistantCommentaryTextBlock(block))
    .map((block) => block.text)
    .join("");

  const images = content
    .filter((block) => block.type === "image" && (block.data || block.source?.data))
    .map((block) => ({
      data: block.data || block.source.data,
      mimeType: block.mimeType || block.source?.media_type || "image/png",
    }));

  const { text, thinkContent } = stripThink ? stripThinkTags(rawText) : { text: rawText, thinkContent: "" };

  const thinking = [
    thinkContent,
    ...content
      .filter((block) => block.type === "thinking" && block.thinking)
      .map((block) => block.thinking),
  ].filter(Boolean).join("\n");

  const toolUses = content
    .filter(isToolCallBlock)
    .map((block) => {
      const args = {};
      const params = getToolArgs(block);
      if (params && typeof params === "object") {
        for (const k of TOOL_ARG_SUMMARY_KEYS) {
          if (params[k] !== undefined) args[k] = params[k];
        }
      }
      return {
        ...(typeof block.id === "string" && block.id ? { id: block.id } : {}),
        name: block.name,
        args: Object.keys(args).length ? args : undefined,
      };
    });

  return { text, thinking, toolUses, images };
}

export function contentHasThinkingBlock(content, { stripThink = false } = {}) {
  if (typeof content === "string") {
    if (!stripThink) return false;
    return /<(think(?:ing)?|reflect)(?:>|<\|message\|>)[\s\S]*?<\/\1>/i.test(content);
  }
  if (!Array.isArray(content)) return false;
  if (content.some((block) => block?.type === "thinking" && block.thinking)) return true;
  if (!stripThink) return false;
  return content.some((block) => (
    block?.type === "text"
    && typeof block.text === "string"
    && /<(think(?:ing)?|reflect)(?:>|<\|message\|>)[\s\S]*?<\/\1>/i.test(block.text)
  ));
}

export function filterUnreferencedInlineImages(text, images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const markerCount = String(text || "").match(ATTACHED_IMAGE_MARKER_RE)?.length || 0;
  if (markerCount <= 0) return images;
  if (markerCount >= images.length) return [];
  return images.slice(markerCount);
}

/**
 * Prefer reading the full session history from session JSON/JSONL.
 * engine.messages may only contain the current context window, which can make
 * older messages disappear when revisiting a page. If reading fails, return an
 * empty array rather than surfacing a partial in-memory snapshot.
 */
export async function loadSessionHistoryMessages(_engine, explicitPath) {
  const sessionPath = explicitPath;
  if (!sessionPath) return [];

  try {
    if (await looksLikePiSessionFile(sessionPath)) {
      const manager = SessionManager.open(sessionPath, path.dirname(sessionPath));
      const messages = [];
      for (const entry of manager.getBranch()) {
        pushSessionMessage(messages, entry);
      }
      if (messages.length > 0) return withExecutionRunIds(messages);
    }
  } catch {
    // Fall back to compatible JSON/JSONL parsing below.
  }

  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    const messages = parseSessionHistoryText(raw);
    if (messages.length > 0) return messages;
  } catch {
    // File read failed.
  }

  return [];
}

async function looksLikePiSessionFile(sessionPath) {
  const fh = await fs.open(sessionPath, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf-8", 0, bytesRead).split("\n")[0]?.trim();
    if (!firstLine) return false;
    const header = JSON.parse(firstLine);
    return header?.type === "session" && typeof header.id === "string";
  } finally {
    await fh.close();
  }
}

async function readSessionTailUtf8(filePath, maxBytes = SESSION_TAIL_READ_THRESHOLD) {
  const stat = await fs.stat(filePath);
  if (!stat.size) return "";
  if (stat.size <= maxBytes) return await fs.readFile(filePath, "utf-8");

  const start = Math.max(0, stat.size - maxBytes);
  const fh = await fs.open(filePath, "r");
  try {
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    const raw = buf.toString("utf-8");
    const firstNewline = raw.indexOf("\n");
    return firstNewline === -1 ? "" : raw.slice(firstNewline + 1);
  } finally {
    await fh.close();
  }
}

export async function loadLatestAssistantSummaryFromSessionFile(sessionPath, options: AssistantSummaryOptions = {}) {
  if (!sessionPath) return null;
  const maxBytes = options.maxBytes ?? SESSION_TAIL_READ_THRESHOLD;
  const summaryLimit = options.summaryLimit ?? 200;

  try {
    const raw = path.extname(sessionPath).toLowerCase() === ".json"
      ? await fs.readFile(sessionPath, "utf-8")
      : await readSessionTailUtf8(sessionPath, maxBytes);
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const parsedMessages = parseSessionHistoryText(trimmed);
    if (parsedMessages.length > 0) {
      for (let i = parsedMessages.length - 1; i >= 0; i--) {
        const msg = parsedMessages[i];
        if (msg?.role !== "assistant") continue;
        const { text } = extractTextContent(msg.content, { stripThink: true });
        return text ? text.slice(0, summaryLimit) : null;
      }
      return null;
    }

    const lines = trimmed.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const msg = entry?.message;
        if (entry?.type !== "message" || msg?.role !== "assistant") continue;
        const { text } = extractTextContent(msg.content, { stripThink: true });
        return text ? text.slice(0, summaryLimit) : null;
      } catch {
        // Skip corrupted tail lines.
      }
    }
  } catch {
    // File read failed.
  }

  return null;
}

export function relativePathInsideBase(targetPath, baseDir) {
  if (typeof targetPath !== "string" || typeof baseDir !== "string") return null;
  if (!targetPath || !baseDir) return null;

  const resolved = normalizeSessionLocatorPath(targetPath);
  const base = normalizeSessionLocatorPath(baseDir);
  const rel = path.relative(base, resolved);
  if (rel === "") return "";
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * Validate that sessionPath stays under the allowed baseDir.
 * baseDir can be a single-agent sessionDir or the global agentsDir.
 */
export function isValidSessionPath(sessionPath, baseDir) {
  return relativePathInsideBase(sessionPath, baseDir) !== null;
}

function desktopSessionParts(sessionPath, agentsDir) {
  const rel = relativePathInsideBase(sessionPath, agentsDir);
  if (rel === null) return false;
  const parts = rel.split(path.sep);
  if (!parts[0] || !parts[1]) return false;
  return parts;
}

function isJsonlFileName(name) {
  return typeof name === "string" && name.endsWith(".jsonl") && path.basename(name) === name;
}

export function isActiveDesktopSessionPath(sessionPath, agentsDir) {
  const parts = desktopSessionParts(sessionPath, agentsDir);
  if (!parts || parts.length !== 3) return false;
  if (parts[1] !== "sessions") return false;
  return isJsonlFileName(parts[2]);
}

export function isArchivedDesktopSessionPath(sessionPath, agentsDir) {
  const parts = desktopSessionParts(sessionPath, agentsDir);
  if (!parts || parts.length !== 4) return false;
  if (parts[1] !== "sessions" || parts[2] !== "archived") return false;
  return isJsonlFileName(parts[3]);
}

export function isDesktopSessionPath(sessionPath, agentsDir) {
  return isActiveDesktopSessionPath(sessionPath, agentsDir)
    || isArchivedDesktopSessionPath(sessionPath, agentsDir);
}

export function isActiveSessionPath(sessionPath, agentsDir) {
  return isActiveDesktopSessionPath(sessionPath, agentsDir);
}
