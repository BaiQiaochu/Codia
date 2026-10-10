import crypto from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

type AnyRecord = Record<string, any>;
type ErrorStatus = 400 | 401 | 403 | 404 | 410 | 500;
type PluginIframeTicketErrorOptions = {
  code?: string;
  status?: ErrorStatus;
};

export const PLUGIN_IFRAME_TICKET_KEY_FILE = "plugin-iframe-ticket-key";
export const PLUGIN_IFRAME_TICKET_ACTION = "plugins.iframe";
export const DEFAULT_PLUGIN_IFRAME_TICKET_TTL_MS = 5 * 60 * 1000;

export class PluginIframeTicketError extends Error {
  code: string;
  status: ErrorStatus;

  constructor(message: string, { code = "plugin_iframe_ticket_invalid", status = 403 }: PluginIframeTicketErrorOptions = {}) {
    super(message);
    this.name = "PluginIframeTicketError";
    this.code = code;
    this.status = status;
  }
}

export function issuePluginIframeTicket({
  codiaHome,
  pluginId,
  surfacePath,
  principalId,
  now = new Date().toISOString(),
  ttlMs = DEFAULT_PLUGIN_IFRAME_TICKET_TTL_MS,
}: AnyRecord = {}) {
  const home = resolveHome(codiaHome);
  assertNonEmpty(pluginId, "pluginId");
  assertNonEmpty(surfacePath, "surfacePath");
  assertNonEmpty(principalId, "principalId");
  const issuedAtMs = Date.parse(now);
  if (!Number.isFinite(issuedAtMs)) throw new Error("now must be an ISO timestamp");
  const safeTtlMs = Math.max(1, Math.min(Number(ttlMs) || DEFAULT_PLUGIN_IFRAME_TICKET_TTL_MS, DEFAULT_PLUGIN_IFRAME_TICKET_TTL_MS));
  const payload = {
    schemaVersion: 1,
    ticketId: `pit_${crypto.randomUUID()}`,
    pluginId,
    surfacePath,
    action: PLUGIN_IFRAME_TICKET_ACTION,
    principalId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + safeTtlMs).toISOString(),
  };
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = signBody(home, body);
  return {
    ...payload,
    ticket: `${body}.${signature}`,
  };
}

export function verifyPluginIframeTicket({
  codiaHome,
  ticket,
  pluginId,
  surfacePath,
  now = new Date().toISOString(),
}: AnyRecord = {}) {
  const home = resolveHome(codiaHome);
  assertNonEmpty(pluginId, "pluginId");
  assertNonEmpty(surfacePath, "surfacePath");
  if (typeof ticket !== "string" || !ticket.trim()) {
    throw new PluginIframeTicketError("plugin iframe ticket required");
  }
  const [body, signature, extra] = ticket.split(".");
  if (!body || !signature || extra !== undefined) {
    throw new PluginIframeTicketError("plugin iframe ticket malformed");
  }
  const expected = signBody(home, body);
  if (!timingSafeEqual(signature, expected)) {
    throw new PluginIframeTicketError("plugin iframe ticket signature invalid");
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch {
    throw new PluginIframeTicketError("plugin iframe ticket payload invalid");
  }
  if (payload?.schemaVersion !== 1 || payload.action !== PLUGIN_IFRAME_TICKET_ACTION) {
    throw new PluginIframeTicketError("plugin iframe ticket action invalid");
  }
  if (payload.pluginId !== pluginId) {
    throw new PluginIframeTicketError("plugin iframe ticket plugin mismatch");
  }
  if (payload.surfacePath !== surfacePath) {
    throw new PluginIframeTicketError("plugin iframe ticket route mismatch");
  }
  const expiresAtMs = Date.parse(payload.expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
    throw new PluginIframeTicketError("plugin iframe ticket timestamp invalid");
  }
  if (expiresAtMs <= nowMs) {
    throw new PluginIframeTicketError("plugin iframe ticket expired", { code: "plugin_iframe_ticket_expired" });
  }
  return Object.freeze({
    schemaVersion: 1,
    ticketId: payload.ticketId,
    pluginId: payload.pluginId,
    surfacePath: payload.surfacePath,
    action: payload.action,
    principalId: payload.principalId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
}

function resolveHome(codiaHome: unknown): string {
  assertNonEmpty(codiaHome, "codiaHome");
  return codiaHome;
}

function pluginIframeTicketKeyPath(codiaHome: unknown): string {
  assertNonEmpty(codiaHome, "codiaHome");
  return path.join(codiaHome, "security", PLUGIN_IFRAME_TICKET_KEY_FILE);
}

function signBody(codiaHome: string, body: string): string {
  return crypto
    .createHmac("sha256", readOrCreateTicketKey(codiaHome))
    .update(body)
    .digest("base64url");
}

function readOrCreateTicketKey(codiaHome: string): string {
  const filePath = pluginIframeTicketKeyPath(codiaHome);
  try {
    const existing = fs.readFileSync(filePath, "utf-8").trim();
    if (existing) return existing;
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const key = crypto.randomBytes(32).toString("base64url");
  atomicWriteSync(filePath, `${key}\n`, { mode: 0o600 });
  return key;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf-8");
}

function timingSafeEqual(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} required`);
}
