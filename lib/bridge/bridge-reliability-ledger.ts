// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_MESSAGES = 2_000;
const MAX_DEAD_LETTERS = 500;

export class BridgeReliabilityLedger {
  constructor({ dataDir, now = () => Date.now() } = {}) {
    this._dataDir = dataDir || path.join(process.cwd(), "bridge");
    this._filePath = path.join(this._dataDir, "reliability-ledger.json");
    this._now = now;
    this._state = this._load();
  }

  recordMessage(entry = {}) {
    const item = {
      id: entry.id || crypto.randomUUID(),
      ts: numberOr(entry.ts, this._now()),
      platform: textOrNull(entry.platform),
      direction: textOrNull(entry.direction) || "unknown",
      sessionKey: textOrNull(entry.sessionKey),
      channelId: textOrNull(entry.channelId || entry.sessionKey),
      chatId: textOrNull(entry.chatId),
      agentId: textOrNull(entry.agentId),
      isGroup: entry.isGroup === true,
      textLength: String(entry.text || "").length,
      status: textOrNull(entry.status) || "ok",
    };
    this._state.messages.push(item);
    this._state.messages.splice(0, Math.max(0, this._state.messages.length - MAX_MESSAGES));
    this._save();
    return item;
  }

  recordDeadLetter(input = {}) {
    const attempt = Number(input.attempt || input.retryCount || 0);
    const item = {
      id: input.id || crypto.randomUUID(),
      createdAt: numberOr(input.createdAt, this._now()),
      updatedAt: this._now(),
      platform: textOrNull(input.platform),
      chatId: textOrNull(input.chatId),
      sessionKey: textOrNull(input.sessionKey),
      agentId: textOrNull(input.agentId),
      kind: textOrNull(input.kind) || "text",
      payload: sanitizePayload(input.payload),
      error: textOrNull(input.error) || "send failed",
      retryCount: attempt,
      nextRetryAt: numberOr(input.nextRetryAt, this._now() + backoffMs(attempt)),
      status: "pending",
    };
    this._state.deadLetters.unshift(item);
    this._state.deadLetters.splice(MAX_DEAD_LETTERS);
    this._save();
    return item;
  }

  updateDeadLetter(id, patch = {}) {
    const item = this._state.deadLetters.find((entry) => entry.id === id);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: this._now() });
    this._save();
    return { ...item };
  }

  listDeadLetters({ includeResolved = false, limit = 100 } = {}) {
    const max = Math.max(1, Math.min(500, Number(limit) || 100));
    return this._state.deadLetters
      .filter((item) => includeResolved || item.status === "pending")
      .slice(0, max)
      .map((item) => ({ ...item }));
  }

  listDueDeadLetters() {
    const now = this._now();
    return this._state.deadLetters
      .filter((item) => item.status === "pending" && item.nextRetryAt <= now)
      .map((item) => ({ ...item }));
  }

  summary() {
    const pending = this._state.deadLetters.filter((item) => item.status === "pending");
    const byChannel = summarizeMessagesBy(this._state.messages, "channelId");
    const byPlatform = summarizeMessagesBy(this._state.messages, "platform");
    return {
      messages: this._state.messages.length,
      deadLetters: this._state.deadLetters.length,
      pendingDeadLetters: pending.length,
      nextRetryAt: pending.reduce((min, item) => min == null ? item.nextRetryAt : Math.min(min, item.nextRetryAt), null),
      byChannel,
      byPlatform,
    };
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._filePath, "utf-8"));
      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages.slice(-MAX_MESSAGES) : [],
        deadLetters: Array.isArray(parsed.deadLetters) ? parsed.deadLetters.slice(0, MAX_DEAD_LETTERS) : [],
      };
    } catch {
      return { messages: [], deadLetters: [] };
    }
  }

  _save() {
    try {
      fs.mkdirSync(this._dataDir, { recursive: true });
      const tmp = `${this._filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), "utf-8");
      fs.renameSync(tmp, this._filePath);
    } catch {
      // Reliability accounting must not break bridge delivery.
    }
  }
}

export function backoffMs(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(15 * 60_000, 5_000 * (2 ** n));
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return {
    text: typeof payload.text === "string" ? payload.text.slice(0, 20_000) : undefined,
    mediaItem: payload.mediaItem ? {
      type: payload.mediaItem.type || null,
      filePath: payload.mediaItem.filePath ? path.basename(String(payload.mediaItem.filePath)) : undefined,
      url: payload.mediaItem.url ? String(payload.mediaItem.url).slice(0, 500) : undefined,
    } : undefined,
  };
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function summarizeMessagesBy(messages, key) {
  const map = new Map();
  for (const message of messages) {
    const id = textOrNull(message?.[key]) || "unknown";
    const current = map.get(id) || {
      [key]: id,
      messages: 0,
      inbound: 0,
      outbound: 0,
      failed: 0,
      lastAt: null,
    };
    current.messages += 1;
    if (message.direction === "in") current.inbound += 1;
    if (message.direction === "out") current.outbound += 1;
    if (message.status && message.status !== "ok") current.failed += 1;
    current.lastAt = current.lastAt == null ? message.ts : Math.max(current.lastAt, message.ts);
    map.set(id, current);
  }
  return [...map.values()]
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    .slice(0, 50);
}
