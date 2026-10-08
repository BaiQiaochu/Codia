// @ts-nocheck
import crypto from "crypto";
import {
  normalizePrincipal,
  principalHasScope,
  principalOwnsLocalConnection,
} from "../core/security-principal.ts";

const SAFE_GLOBAL_EVENTS = new Set([
  "session_created",
  "notification",
]);

const WRITE_MESSAGE_TYPES = new Set([
  "abort",
  "steer",
  "slash",
  "compact",
  "prompt",
]);

const READ_MESSAGE_TYPES = new Set([
  "resume_stream",
  "context_usage",
]);

export function createWsClientRecord({ principal, subscriptions = [], clientId = `wsc_${crypto.randomUUID()}` } = {}) {
  return Object.freeze({
    clientId,
    principal: normalizePrincipal(principal || { kind: "unknown" }),
    subscriptions: normalizeSubscriptions(subscriptions),
  });
}

export function subscribeWsClientToSession(client, { studioId, sessionPath }) {
  if (!client) return client;
  if (!studioId || !sessionPath) return client;
  const next = [
    ...client.subscriptions,
    { kind: "session", studioId, sessionPath },
  ];
  return createWsClientRecord({
    clientId: client.clientId,
    principal: client.principal,
    subscriptions: next,
  });
}

export function wsClientCanReceiveEvent(client, event) {
  if (!client || !event || typeof event !== "object") return false;
  const principal = normalizePrincipal(client.principal);
  if (principalOwnsLocalConnection(principal)) return true;

  if (event.thumbnail && typeof event.thumbnail === "string") return false;

  const sessionPath = stringOrNull(event.sessionPath);
  const eventStudioId = stringOrNull(event.studioId);
  if (sessionPath) {
    if (!eventStudioId) return false;
    if (!principalHasScope(principal, "chat.read")) return false;
    if (!sameStudio(principal, eventStudioId)) return false;
    return subscriptionAllows(client.subscriptions, { kind: "session", studioId: eventStudioId, sessionPath })
      || subscriptionAllows(client.subscriptions, { kind: "studio", studioId: eventStudioId });
  }

  if (SAFE_GLOBAL_EVENTS.has(event.type)) {
    return principalHasScope(principal, "chat.read");
  }

  if (event.resourceId) {
    return principalHasScope(principal, "resources.read") || principalHasScope(principal, "resources.content");
  }

  return false;
}

export function wsClientCanSendMessage(client, message) {
  if (!client || !message || typeof message !== "object") return false;
  const principal = normalizePrincipal(client.principal);
  if (principalOwnsLocalConnection(principal)) return true;
  const type = stringOrNull(message.type);
  if (WRITE_MESSAGE_TYPES.has(type)) return principalHasScope(principal, "chat.write");
  if (READ_MESSAGE_TYPES.has(type)) return principalHasScope(principal, "chat.read");
  return principalHasScope(principal, "chat");
}

function normalizeSubscriptions(subscriptions) {
  const out = [];
  const seen = new Set();
  for (const sub of Array.isArray(subscriptions) ? subscriptions : []) {
    if (!sub || typeof sub !== "object") continue;
    const kind = stringOrNull(sub.kind);
    const studioId = stringOrNull(sub.studioId);
    const sessionPath = stringOrNull(sub.sessionPath);
    const resourceId = stringOrNull(sub.resourceId);
    if (!kind || !studioId) continue;
    const normalized = {
      kind,
      studioId,
      ...(sessionPath ? { sessionPath } : {}),
      ...(resourceId ? { resourceId } : {}),
    };
    const key = JSON.stringify(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(Object.freeze(normalized));
    }
  }
  return Object.freeze(out);
}

function subscriptionAllows(subscriptions, target) {
  return (subscriptions || []).some((sub) => {
    if (sub.kind === "studio") return sub.studioId === target.studioId;
    if (sub.kind !== target.kind) return false;
    if (sub.studioId !== target.studioId) return false;
    if (target.sessionPath && sub.sessionPath !== target.sessionPath) return false;
    if (target.resourceId && sub.resourceId !== target.resourceId) return false;
    return true;
  });
}

function sameStudio(principal, studioId) {
  if (!studioId) return false;
  if (principal.studioId === studioId) return true;
  return Array.isArray(principal.studioIds) && principal.studioIds.includes(studioId);
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
