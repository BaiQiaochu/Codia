// @ts-nocheck
import { normalizeBridgePlatforms } from "../bridge/bridge-context.ts";

const CHANNEL_DESKTOP = "desktop";
const CHANNEL_BRIDGE_OWNER = "bridge_owner";
const CHANNEL_AUTO = "auto";
const CONTEXT_RECORD_WHEN_DELIVERED = "record_when_delivered";
const AUDIENCE_OWNER = "owner";
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const DESKTOP_FOCUS_ALWAYS = "always";
const DESKTOP_FOCUS_WHEN_UNFOCUSED = "when_unfocused";
const DESKTOP_FOCUS_WHEN_SESSION_UNFOCUSED = "when_session_unfocused";

const VALID_CHANNELS = new Set([CHANNEL_DESKTOP, CHANNEL_BRIDGE_OWNER, CHANNEL_AUTO]);
const VALID_DESKTOP_FOCUS_POLICIES = new Set([
  DESKTOP_FOCUS_ALWAYS,
  DESKTOP_FOCUS_WHEN_UNFOCUSED,
  DESKTOP_FOCUS_WHEN_SESSION_UNFOCUSED,
]);

export function formatNotificationText(title, body) {
  const safeTitle = typeof title === "string" ? title.trim() : "";
  const safeBody = typeof body === "string" ? body.trim() : "";
  if (safeTitle && safeBody) return `${safeTitle}\n\n${safeBody}`;
  return safeBody || safeTitle;
}

export function normalizeNotificationPayload(payload = {}) {
  const title = typeof payload.title === "string" ? payload.title : "";
  const body = typeof payload.body === "string" ? payload.body : "";
  const audience = payload.audience || AUDIENCE_OWNER;
  const contextPolicy = payload.contextPolicy || CONTEXT_RECORD_WHEN_DELIVERED;
  const { channels, invalidChannels } = normalizeChannels(payload.channels);
  const { bridgePlatforms, invalidBridgePlatforms } = normalizeBridgePlatforms(payload.bridgePlatforms);

  return {
    ...payload,
    title,
    body,
    audience,
    contextPolicy,
    idempotencyKey: normalizeIdempotencyKey(payload.idempotencyKey),
    desktopFocusPolicy: normalizeDesktopFocusPolicy(payload.desktopFocusPolicy),
    channels,
    invalidChannels,
    bridgePlatforms,
    invalidBridgePlatforms,
  };
}

function normalizeDesktopFocusPolicy(value) {
  return VALID_DESKTOP_FOCUS_POLICIES.has(value) ? value : DESKTOP_FOCUS_ALWAYS;
}

function normalizeIdempotencyKey(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeChannels(value) {
  const hasExplicitChannels = Array.isArray(value) || (typeof value === "string" && value);
  const raw = Array.isArray(value) ? value : hasExplicitChannels ? [value] : [CHANNEL_DESKTOP];
  const normalized = [];
  const invalidChannels = [];
  for (const item of raw) {
    const channel = typeof item === "string" ? item.trim() : "";
    if (!channel) continue;
    if (!VALID_CHANNELS.has(channel)) {
      invalidChannels.push(channel);
      continue;
    }
    if (channel === CHANNEL_AUTO) {
      if (!normalized.includes(CHANNEL_DESKTOP)) normalized.push(CHANNEL_DESKTOP);
      continue;
    }
    if (!normalized.includes(channel)) normalized.push(channel);
  }
  if (!hasExplicitChannels && normalized.length === 0) normalized.push(CHANNEL_DESKTOP);
  return { channels: normalized, invalidChannels };
}

export class NotificationService {
  /**
   * @param {object} deps
    *
   * @param {() => import('../bridge/bridge-manager.ts').BridgeManager|null} deps.getBridgeManager
   */
  constructor({ emitDesktop, getBridgeManager } = {}) {
    this._emitDesktop = emitDesktop;
    this._getBridgeManager = getBridgeManager;
    this._idempotency = new Map();
  }

  async notify(payload, context = {}) {
    const normalized = normalizeNotificationPayload(payload);
    const idempotencyKey = normalized.idempotencyKey || normalizeIdempotencyKey(context.idempotencyKey);
    if (idempotencyKey) {
      const existing = this._getIdempotentDelivery(idempotencyKey);
      if (existing) return existing;
      const promise = this._notifyOnce(normalized, context, idempotencyKey);
      this._idempotency.set(idempotencyKey, { promise, createdAt: Date.now(), result: null });
      return promise;
    }

    return this._notifyOnce(normalized, context, null);
  }

  _getIdempotentDelivery(idempotencyKey) {
    this._pruneIdempotency();
    const existing = this._idempotency.get(idempotencyKey);
    if (!existing) return null;
    if (existing.promise) return existing.promise;
    return {
      ...(existing.result || {}),
      ok: true,
      idempotencyKey,
      skipped: true,
      deliveries: [{
        channel: "notification",
        status: "skipped",
        reason: "duplicate notification",
      }],
    };
  }

  _pruneIdempotency(now = Date.now()) {
    for (const [key, entry] of this._idempotency) {
      if (now - entry.createdAt > IDEMPOTENCY_TTL_MS) this._idempotency.delete(key);
    }
  }

  async _notifyOnce(normalized, context = {}, idempotencyKey = null) {
    const deliveries = [];

    for (const channel of normalized.invalidChannels) {
      deliveries.push({
        channel,
        status: "failed",
        error: `unsupported notification channel: ${channel}`,
      });
    }

    for (const platform of normalized.invalidBridgePlatforms) {
      deliveries.push({
        channel: CHANNEL_BRIDGE_OWNER,
        status: "failed",
        error: `unsupported bridge platform: ${platform}`,
      });
    }

    for (const channel of normalized.channels) {
      if (channel === CHANNEL_DESKTOP) {
        deliveries.push(await this._deliverDesktop(normalized, context));
      } else if (channel === CHANNEL_BRIDGE_OWNER) {
        deliveries.push(await this._deliverBridgeOwner(normalized, context));
      }
    }

    const result = {
      ok: deliveries.length > 0 && deliveries.every((d) => d.status === "sent"),
      title: normalized.title,
      body: normalized.body,
      channels: normalized.channels,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      deliveries,
    };
    if (idempotencyKey) {
      const delivered = deliveries.some((d) => d.status === "sent");
      if (delivered) {
        this._idempotency.set(idempotencyKey, {
          promise: null,
          createdAt: Date.now(),
          result,
        });
      } else {
        this._idempotency.delete(idempotencyKey);
      }
    }
    return result;
  }

  async _deliverDesktop(payload, context) {
    try {
      const sessionPath = normalizeSessionPath(payload.sessionPath) || normalizeSessionPath(context.sessionPath);
      await this._emitDesktop?.({
        title: payload.title,
        body: payload.body,
        agentId: context.agentId || null,
        desktopFocusPolicy: payload.desktopFocusPolicy,
        ...(sessionPath ? { sessionPath } : {}),
      });
      return { channel: CHANNEL_DESKTOP, status: "sent" };
    } catch (err) {
      return { channel: CHANNEL_DESKTOP, status: "failed", error: err.message };
    }
  }

  async _deliverBridgeOwner(payload, context) {
    if (payload.audience !== AUDIENCE_OWNER) {
      return {
        channel: CHANNEL_BRIDGE_OWNER,
        status: "failed",
        error: `unsupported audience for bridge_owner: ${payload.audience}`,
      };
    }

    const manager = this._getBridgeManager?.();
    if (!manager) {
      return { channel: CHANNEL_BRIDGE_OWNER, status: "failed", error: "bridge manager unavailable" };
    }

    const text = formatNotificationText(payload.title, payload.body);
    if (!text) {
      return { channel: CHANNEL_BRIDGE_OWNER, status: "failed", error: "notification text is empty" };
    }

    try {
      const proactiveOpts = {
        contextPolicy: payload.contextPolicy,
      };
      if (payload.bridgePlatforms.length) proactiveOpts.bridgePlatforms = payload.bridgePlatforms;
      if (payload.idempotencyKey) proactiveOpts.idempotencyKey = `${payload.idempotencyKey}:bridge_owner`;
      const result = await manager.sendProactive(text, context.agentId || null, proactiveOpts);
      if (!result) {
        return { channel: CHANNEL_BRIDGE_OWNER, status: "failed", error: "no bridge owner delivery target available" };
      }
      return {
        channel: CHANNEL_BRIDGE_OWNER,
        status: "sent",
        platform: result.platform,
        chatId: result.chatId,
        sessionKey: result.sessionKey,
        recorded: result.recorded === true,
      };
    } catch (err) {
      return { channel: CHANNEL_BRIDGE_OWNER, status: "failed", error: err.message };
    }
  }
}

function normalizeSessionPath(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
