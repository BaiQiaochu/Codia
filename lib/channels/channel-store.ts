// @ts-nocheck
/**
 * Markdown-backed channel store.
 *
 * A channel is stored as one Markdown file with frontmatter metadata and a
 * message stream body. Agent channel bookmarks are stored separately.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { t, getLocale } from "../i18n.ts";

export const CHANNEL_MEMBER_ROLE_VALUES = ["project_manager", "admin", "worker"];
export const MIN_CHANNEL_AGENT_MEMBERS = 2;

const _fileLocks = new Map(); // filePath -> Promise

/**
 * Serialize writes for one file while allowing unrelated files to proceed.
 */
function _withFileLock(filePath, fn) {
  const prev = _fileLocks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn); // Continue even if the previous operation failed.
  _fileLocks.set(filePath, next);
  // Clean completed locks so the map does not grow forever.
  next.then(() => {
    if (_fileLocks.get(filePath) === next) _fileLocks.delete(filePath);
  });
  return next;
}

/** Message header: ### sender | YYYY-MM-DD HH:MM[:SS]. */
const MSG_HEADER_RE = /^### (.+?) \| (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)$/;

/**
 * Parse channel markdown content into frontmatter and message entries.
 * @param {string} content
  *
 */
export function parseChannel(content) {
  const lines = content.split("\n");
  let meta = {};
  let bodyStart = 0;

  // Parse frontmatter.
  if (lines[0]?.trim() === "---") {
    let fmEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        fmEnd = i;
        break;
      }
    }
    if (fmEnd > 0) {
      const fmLines = lines.slice(1, fmEnd);
      meta = parseFrontmatter(fmLines);
      bodyStart = fmEnd + 1;
    }
  }

  // Parse message stream.
  const messages = [];
  let current = null;
  const bodyLines = [];

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(MSG_HEADER_RE);

    if (match) {
      // Save previous message.
      if (current) {
        const parsedBody = parseMessageBodyMetadata(bodyLines.join("\n").trim());
        current.body = parsedBody.body;
        if (parsedBody.blocks.length > 0) current.blocks = parsedBody.blocks;
        if (parsedBody.resources.length > 0) current.resources = parsedBody.resources;
        messages.push(current);
        bodyLines.length = 0;
      }
      current = { sender: match[1], timestamp: match[2], body: "" };
    } else if (current) {
      if (line.trim() === "---") continue;
      bodyLines.push(line);
    }
  }

  // Save final message.
  if (current) {
    const parsedBody = parseMessageBodyMetadata(bodyLines.join("\n").trim());
    current.body = parsedBody.body;
    if (parsedBody.blocks.length > 0) current.blocks = parsedBody.blocks;
    if (parsedBody.resources.length > 0) current.resources = parsedBody.resources;
    messages.push(current);
  }

  return { meta, messages };
}

const MESSAGE_META_RE = /\n?\s*<!--\s*codia-channel-message-meta:([A-Za-z0-9+/=]+)\s*-->\s*$/;

function parseMessageBodyMetadata(body) {
  const rawBody = String(body || "");
  const match = rawBody.match(MESSAGE_META_RE);
  if (!match) return { body: rawBody, blocks: [], resources: [] };
  const visibleBody = rawBody.slice(0, match.index).trim();
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    const blocks = Array.isArray(parsed?.blocks)
      ? parsed.blocks.filter((block) => block && typeof block === "object" && typeof block.type === "string")
      : [];
    const resources = Array.isArray(parsed?.resources)
      ? parsed.resources.filter((resource) => resource && typeof resource === "object" && typeof resource.resourceId === "string")
      : [];
    return { body: visibleBody, blocks, resources };
  } catch {
    return { body: rawBody, blocks: [], resources: [] };
  }
}

function serializeMessageMetadata(meta = {}) {
  const blocks = Array.isArray(meta.blocks)
    ? meta.blocks.filter((block) => block && typeof block === "object" && typeof block.type === "string")
    : [];
  const resources = Array.isArray(meta.resources)
    ? meta.resources.filter((resource) => resource && typeof resource === "object" && typeof resource.resourceId === "string")
    : [];
  if (blocks.length === 0 && resources.length === 0) return "";
  const encoded = Buffer.from(JSON.stringify({ blocks, resources }), "utf-8").toString("base64");
  return `<!-- codia-channel-message-meta:${encoded} -->`;
}

/**
 * Minimal frontmatter parser without a YAML dependency.
 * Supports key: value and key: [a, b, c].
 */
function parseFrontmatter(lines) {
  const result = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();

    // Array syntax: [a, b, c]
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    }
    result[key] = val;
  }
  return result;
}

/**
 * Serialize metadata into frontmatter.
 */
function serializeFrontmatter(meta) {
  const lines = ["---"];
  for (const [key, val] of Object.entries(meta)) {
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.join(", ")}]`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export function normalizeChannelMemberRole(role) {
  return CHANNEL_MEMBER_ROLE_VALUES.includes(role) ? role : "worker";
}

export function buildDefaultChannelMemberRoles(members) {
  const uniqMembers = [...new Set((members || []).filter(Boolean))];
  const roles = {};
  uniqMembers.forEach((memberId, index) => {
    if (index === 0) roles[memberId] = "project_manager";
    else if (index === 1) roles[memberId] = "admin";
    else roles[memberId] = "worker";
  });
  return roles;
}

function parseStoredChannelMemberRoles(rawRoles) {
  const entries = Array.isArray(rawRoles)
    ? rawRoles
    : rawRoles && typeof rawRoles === "object"
      ? Object.entries(rawRoles).map(([memberId, role]) => `${memberId}=${role}`)
      : [];

  const parsed = {};
  for (const entry of entries) {
    const text = String(entry || "").trim();
    if (!text) continue;
    const sepIdx = text.indexOf("=");
    if (sepIdx <= 0) continue;
    const memberId = text.slice(0, sepIdx).trim();
    const role = text.slice(sepIdx + 1).trim();
    if (!memberId) continue;
    parsed[memberId] = normalizeChannelMemberRole(role);
  }
  return parsed;
}

function serializeChannelMemberRoles(memberRoles) {
  return Object.entries(memberRoles)
    .filter(([memberId]) => !!memberId)
    .map(([memberId, role]) => `${memberId}=${normalizeChannelMemberRole(role)}`);
}

export function normalizeChannelMemberRoles(members, rawRoles) {
  const uniqMembers = [...new Set((members || []).filter(Boolean))];
  const defaults = buildDefaultChannelMemberRoles(uniqMembers);
  const parsed = parseStoredChannelMemberRoles(rawRoles);

  const roles = {};
  for (const memberId of uniqMembers) {
    roles[memberId] = normalizeChannelMemberRole(parsed[memberId] || defaults[memberId]);
  }

  if (uniqMembers.length > 0 && !Object.values(roles).includes("project_manager")) {
    roles[uniqMembers[0]] = "project_manager";
  }

  return roles;
}

/**
 * Generate a channel id with the ch_ prefix.
 * @param {string} [customId]
 * @returns {string}
 */
export function generateChannelId(customId) {
  const base = customId || crypto.randomUUID().slice(0, 6);
  return base.startsWith("ch_") ? base : `ch_${base}`;
}

export function normalizeChannelMembers(members) {
  if (!Array.isArray(members)) return [];
  return Array.from(new Set(
    members
      .filter((member) => typeof member === "string")
      .map((member) => member.trim())
      .filter(Boolean),
  ));
}

export function assertValidChannelMembers(members) {
  const normalized = normalizeChannelMembers(members);
  if (normalized.length < MIN_CHANNEL_AGENT_MEMBERS) {
    throw new Error(`channel requires at least ${MIN_CHANNEL_AGENT_MEMBERS} agent members`);
  }
  return normalized;
}

/**
 * Create a channel Markdown file.
 * @param {string} channelsDir
 * @param {object} opts
 * @param {string} [opts.id]
 * @param {string} [opts.name]
 * @param {string} [opts.description]
 * @param {string[]} opts.members
 * @param {string} [opts.intro]
 * @returns {{ filePath: string, id: string }}
 */
export function createChannel(channelsDir, { id, name, description, members, memberRoles, intro }) {
  fs.mkdirSync(channelsDir, { recursive: true });
  const channelId = id ? (id.startsWith("ch_") ? id : `ch_${id}`) : generateChannelId();
  const filePath = path.join(channelsDir, `${channelId}.md`);
  const normalizedMembers = normalizeChannelMembers(members);

  if (fs.existsSync(filePath)) {
    throw new Error(t("error.channelAlreadyExists", { id: channelId }));
  }

  const normalizedRoles = normalizeChannelMemberRoles(normalizedMembers, memberRoles);
  const meta = { id: channelId, members: normalizedMembers };
  if (name) meta.name = name;
  if (description) meta.description = description;
  if (Object.keys(normalizedRoles).length > 0) {
    meta.member_roles = serializeChannelMemberRoles(normalizedRoles);
  }
  const parts = [serializeFrontmatter(meta), ""];

  if (intro) {
    const ts = formatTimestamp(new Date());
    parts.push(`### system | ${ts}`, "", intro, "", "---", "");
  }

  fs.writeFileSync(filePath, parts.join("\n"), "utf-8");
  return { filePath, id: channelId };
}

/**
 * Append one message to a channel file.
 * @param {string} filePath
 * @param {string} sender
 * @param {string} body
 * @returns {{ timestamp: string }}
 */
export function appendMessage(filePath, sender, body, meta = {}) {
  const ts = formatTimestamp(new Date());
  const metadata = serializeMessageMetadata(meta);
  const messageBody = [String(body || "").trim(), metadata].filter(Boolean).join("\n\n");
  const block = `\n### ${sender} | ${ts}\n\n${messageBody}\n\n---\n`;
  fs.appendFileSync(filePath, block, "utf-8");
  return { timestamp: ts };
}

/**
 * Read messages newer than a bookmark.
 * @param {string} filePath
 * @param {string} [bookmark]
 * @param {string} [selfName]
 * @returns {Array<{sender: string, timestamp: string, body: string}>}
 */
export function getNewMessages(filePath, bookmark, selfName) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const { messages } = parseChannel(content);

  let filtered = messages;

  // Only messages after the bookmark.
  if (bookmark) {
    filtered = filtered.filter(m => m.timestamp > bookmark);
  }

  // Skip messages sent by the local user or agent.
  if (selfName) {
    filtered = filtered.filter(m => m.sender !== selfName);
  }

  return filtered;
}

/**
 * Get the latest channel messages, optionally excluding the local sender.
 * @param {string} filePath
 * @param {number} [count=10]
 * @param {string} [selfName]
 * @returns {Array<{sender: string, timestamp: string, body: string}>}
 */
export function getRecentMessages(filePath, count = 10, selfName) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const { messages } = parseChannel(content);

  const filtered = selfName
    ? messages.filter(m => m.sender !== selfName)
    : messages;

  return filtered.slice(-count);
}

/**
 * Read channel member ids.
 * @param {string} filePath
 * @returns {string[]}
 */
export function getChannelMembers(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const { meta } = parseChannel(content);
  return Array.isArray(meta.members) ? meta.members : [];
}

/**
 * Read channel metadata such as id, name, description, and members.
 * @param {string} filePath
 * @returns {object}
 */
export function getChannelMeta(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf-8");
  const { meta } = parseChannel(content);
  return meta;
}

export function updateChannelMeta(filePath, patch) {
  if (!fs.existsSync(filePath)) return {};
  let nextMeta = {};
  rewriteFrontmatter(filePath, (meta) => {
    nextMeta = { ...meta, ...(patch || {}) };
    Object.assign(meta, nextMeta);
    return true;
  });
  return Object.keys(nextMeta).length > 0 ? nextMeta : getChannelMeta(filePath);
}

export function getChannelMemberRoles(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf-8");
  const { meta } = parseChannel(content);
  return normalizeChannelMemberRoles(meta.members, meta.member_roles);
}

/**
 * Add a member to a channel.
 * @param {string} filePath
 * @param {string} memberId
 */
export function addChannelMember(filePath, memberId, role) {
  rewriteFrontmatter(filePath, (meta) => {
    const members = Array.isArray(meta.members) ? meta.members : [];
    const exists = members.includes(memberId);
    if (!exists) members.push(memberId);
    const memberRoles = normalizeChannelMemberRoles(members, meta.member_roles);
    const currentRole = memberRoles[memberId];
    const nextRole = role ? normalizeChannelMemberRole(role) : currentRole;
    const changed = !exists || currentRole !== nextRole;
    if (!changed) return false;
    memberRoles[memberId] = nextRole;
    meta.members = members;
    meta.member_roles = serializeChannelMemberRoles(memberRoles);
    return true;
  });
}

/**
 * Remove a member from a channel.
 * @param {string} filePath
 * @param {string} memberId
 */
export function removeChannelMember(filePath, memberId) {
  if (!fs.existsSync(filePath)) return;
  rewriteFrontmatter(filePath, (meta) => {
    const members = Array.isArray(meta.members) ? meta.members : [];
    const idx = members.indexOf(memberId);
    if (idx < 0) return false; // Member is not present; no write needed.
    members.splice(idx, 1);
    meta.members = members;
    const memberRoles = normalizeChannelMemberRoles(members, meta.member_roles);
    if (Object.keys(memberRoles).length > 0) {
      meta.member_roles = serializeChannelMemberRoles(memberRoles);
    } else {
      delete meta.member_roles;
    }
    return true;
  });
}

export function setChannelMemberRole(filePath, memberId, role) {
  if (!fs.existsSync(filePath)) return {};
  let nextRoles = {};
  rewriteFrontmatter(filePath, (meta) => {
    const members = Array.isArray(meta.members) ? meta.members : [];
    if (!members.includes(memberId)) {
      throw new Error(t("error.agentNotChannelMember", { channel: path.basename(filePath, ".md") }));
    }
    const memberRoles = normalizeChannelMemberRoles(members, meta.member_roles);
    const nextRole = normalizeChannelMemberRole(role);
    if (memberRoles[memberId] === nextRole) {
      nextRoles = memberRoles;
      return false;
    }
    memberRoles[memberId] = nextRole;
    const normalized = normalizeChannelMemberRoles(members, memberRoles);
    meta.member_roles = serializeChannelMemberRoles(normalized);
    nextRoles = normalized;
    return true;
  });
  return Object.keys(nextRoles).length > 0 ? nextRoles : getChannelMemberRoles(filePath);
}

/**
 * Rewrite channel frontmatter while preserving the message body.
 *
 * The file is re-read before writing to avoid overwriting concurrently appended
 * messages, then written atomically through a temporary file.
 *
 * @param {string} filePath
 * @param {(meta: object) => boolean} mutator
 */
function rewriteFrontmatter(filePath, mutator) {
  const content = fs.readFileSync(filePath, "utf-8");
  const { meta } = parseChannel(content);

  if (!mutator(meta)) return; // mutator returned false; no write needed.

  // Re-read before writing to avoid overwriting appended messages.
  const freshContent = fs.readFileSync(filePath, "utf-8");
  const freshLines = freshContent.split("\n");
  let fmEnd = 0;
  if (freshLines[0]?.trim() === "---") {
    for (let i = 1; i < freshLines.length; i++) {
      if (freshLines[i].trim() === "---") { fmEnd = i; break; }
    }
  }

  const body = freshLines.slice(fmEnd + 1).join("\n");
  const newContent = serializeFrontmatter(meta) + "\n" + body;

  // atomic write
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, newContent, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Delete a channel file.
 * @param {string} filePath
 */
export function deleteChannel(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * channels.md format:
 *
 * # 频道
 *
 * - crew (last: 2026-02-27 14:30)
 * - codia-butter (last: 2026-02-27 13:00)
 */

const BOOKMARK_RE = /^- (.+?) \(last: (.+?)\)$/;

/**
 * Read an agent's channel bookmark list.
 * @param {string} channelsMdPath
 * @returns {Map<string, string>}
 */
export function readBookmarks(channelsMdPath) {
  const bookmarks = new Map();
  if (!fs.existsSync(channelsMdPath)) return bookmarks;

  const content = fs.readFileSync(channelsMdPath, "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(BOOKMARK_RE);
    if (match) {
      bookmarks.set(match[1], match[2]);
    }
  }
  return bookmarks;
}

/**
 * Update one channel bookmark for an agent.
 * @param {string} channelsMdPath
 * @param {string} channelName
 * @param {string} timestamp
 */
export function updateBookmark(channelsMdPath, channelName, timestamp) {
  const bookmarks = readBookmarks(channelsMdPath);
  bookmarks.set(channelName, timestamp);
  writeBookmarks(channelsMdPath, bookmarks);
}

/**
 * Add a channel bookmark entry for an agent.
 * @param {string} channelsMdPath
 * @param {string} channelName
 */
export function addBookmarkEntry(channelsMdPath, channelName) {
  const bookmarks = readBookmarks(channelsMdPath);
  if (!bookmarks.has(channelName)) {
    bookmarks.set(channelName, "never");
    writeBookmarks(channelsMdPath, bookmarks);
  }
}

/**
 * Remove a channel bookmark entry for an agent.
 * @param {string} channelsMdPath
 * @param {string} channelName
 */
export function removeBookmarkEntry(channelsMdPath, channelName) {
  const bookmarks = readBookmarks(channelsMdPath);
  if (bookmarks.has(channelName)) {
    bookmarks.delete(channelName);
    writeBookmarks(channelsMdPath, bookmarks);
  }
}

/**
 * Write a bookmark map back to channels.md.
 */
function writeBookmarks(channelsMdPath, bookmarks) {
  const lines = ["# 频道", ""];
  for (const [name, ts] of bookmarks) {
    lines.push(`- ${name} (last: ${ts})`);
  }
  lines.push(""); // trailing newline
  fs.mkdirSync(path.dirname(channelsMdPath), { recursive: true });
  // atomic write
  const tmpPath = channelsMdPath + ".tmp";
  fs.writeFileSync(tmpPath, lines.join("\n"), "utf-8");
  fs.renameSync(tmpPath, channelsMdPath);
}

/**
 * Format a timestamp as YYYY-MM-DD HH:MM:SS.
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

/**
 * Format messages as readable text for LLM prompts.
 * @param {Array<{sender: string, timestamp: string, body: string}>} messages
 * @returns {string}
 */
export function formatMessagesForLLM(messages) {
  if (messages.length === 0) return getLocale().startsWith("zh") ? "(没有新消息)" : "(no new messages)";
  return messages
    .map((m) => {
      const blockSummary = formatChannelBlocksForLLM(m.blocks);
      const resourceSummary = formatChannelResourcesForLLM(m.resources);
      const body = [m.body, blockSummary, resourceSummary].filter(Boolean).join("\n");
      return `[${m.timestamp}] ${m.sender}: ${body}`;
    })
    .join("\n\n");
}

function formatChannelResourcesForLLM(resources) {
  if (!Array.isArray(resources) || resources.length === 0) return "";
  return resources
    .filter((resource) => resource && typeof resource === "object")
    .map((resource) => {
      const label = resource.displayName || resource.name || resource.filename || resource.resourceId || "resource";
      const kind = resource.kind || resource.ext || resource.type || "file";
      const content = resource.links?.content || resource.links?.self || "";
      return `[resource:${kind}] ${label}${content ? ` ${content}` : ""}`;
    })
    .filter(Boolean)
    .join("\n");
}

function formatChannelBlocksForLLM(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  return blocks
    .filter((block) => block && typeof block === "object" && typeof block.type === "string")
    .map((block) => {
      if (block.type === "file") {
        const label = block.label || block.title || block.filename || block.filePath || "file";
        const kind = block.kind || block.ext || "file";
        const pathText = block.filePath ? ` ${block.filePath}` : "";
        return `[file:${kind}] ${label}${pathText}`;
      }
      if (block.type === "artifact") {
        return `[artifact:${block.artifactType || "artifact"}] ${block.title || block.label || block.artifactId || "artifact"}`;
      }
      if (block.type === "media_generation") {
        return `[media:${block.kind || "media"}] ${block.status || "done"} ${block.prompt || block.taskId || ""}`.trim();
      }
      return `[${block.type}] ${block.title || block.label || block.name || ""}`.trim();
    })
    .filter(Boolean)
    .join("\n");
}
