import crypto from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

type AnyRecord = Record<string, any>;
type ErrorStatus = 400 | 401 | 403 | 404 | 410 | 500;
type PluginAssetSessionErrorOptions = {
  code?: string;
  status?: ErrorStatus;
};

export const PLUGIN_ASSET_SESSION_KEY_FILE = "plugin-asset-session-key";
export const PLUGIN_ASSET_SESSION_ACTION = "plugins.assets";
export const DEFAULT_PLUGIN_ASSET_SESSION_TTL_MS = 30 * 60 * 1000;

export class PluginAssetSessionError extends Error {
  code: string;
  status: ErrorStatus;

  constructor(message: string, { code = "plugin_asset_session_invalid", status = 403 }: PluginAssetSessionErrorOptions = {}) {
    super(message);
    this.name = "PluginAssetSessionError";
    this.code = code;
    this.status = status;
  }
}

export function pluginAssetSessionCookieName(pluginId: unknown): string {
  assertNonEmpty(pluginId, "pluginId");
  const digest = crypto.createHash("sha256").update(pluginId).digest("base64url").slice(0, 24);
  return `codia_plugin_assets_${digest}`;
}

export function pluginAssetSessionCookiePath(pluginId: unknown): string {
  assertNonEmpty(pluginId, "pluginId");
  return `/api/plugins/${encodeURIComponent(pluginId)}/assets/`;
}

export function createPluginAssetSessionCookie({
  pluginId,
  token,
  maxAgeSeconds = Math.ceil(DEFAULT_PLUGIN_ASSET_SESSION_TTL_MS / 1000),
  secure = false,
}: AnyRecord = {}): string {
  assertNonEmpty(pluginId, "pluginId");
  assertNonEmpty(token, "token");
  const safeMaxAge = Math.max(1, Math.floor(Number(maxAgeSeconds) || 1));
  const parts = [
    `${pluginAssetSessionCookieName(pluginId)}=${encodeURIComponent(token)}`,
    `Path=${pluginAssetSessionCookiePath(pluginId)}`,
    `Max-Age=${safeMaxAge}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function issuePluginAssetSession({
  codiaHome,
  pluginId,
  principalId,
  now = new Date().toISOString(),
  ttlMs = DEFAULT_PLUGIN_ASSET_SESSION_TTL_MS,
}: AnyRecord = {}) {
  const home = resolveHome(codiaHome);
  assertNonEmpty(pluginId, "pluginId");
  assertNonEmpty(principalId, "principalId");
  const issuedAtMs = Date.parse(now);
  if (!Number.isFinite(issuedAtMs)) throw new Error("now must be an ISO timestamp");
  const safeTtlMs = Math.max(
    1,
    Math.min(Number(ttlMs) || DEFAULT_PLUGIN_ASSET_SESSION_TTL_MS, DEFAULT_PLUGIN_ASSET_SESSION_TTL_MS),
  );
  const payload = {
    schemaVersion: 1,
    sessionId: `pas_${crypto.randomUUID()}`,
    pluginId,
    action: PLUGIN_ASSET_SESSION_ACTION,
    principalId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + safeTtlMs).toISOString(),
  };
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = signBody(home, body);
  return {
    ...payload,
    token: `${body}.${signature}`,
    cookieName: pluginAssetSessionCookieName(pluginId),
  };
}

export function verifyPluginAssetSession({
  codiaHome,
  pluginId,
  token,
  now = new Date().toISOString(),
}: AnyRecord = {}) {
  const home = resolveHome(codiaHome);
  assertNonEmpty(pluginId, "pluginId");
  if (typeof token !== "string" || !token.trim()) {
    throw new PluginAssetSessionError("plugin asset session required", {
      code: "plugin_asset_session_required",
    });
  }
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) {
    throw new PluginAssetSessionError("plugin asset session malformed");
  }
  const expected = signBody(home, body);
  if (!timingSafeEqual(signature, expected)) {
    throw new PluginAssetSessionError("plugin asset session signature invalid");
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch {
    throw new PluginAssetSessionError("plugin asset session payload invalid");
  }
  if (payload?.schemaVersion !== 1 || payload.action !== PLUGIN_ASSET_SESSION_ACTION) {
    throw new PluginAssetSessionError("plugin asset session action invalid");
  }
  if (payload.pluginId !== pluginId) {
    throw new PluginAssetSessionError("plugin asset session plugin mismatch");
  }
  const expiresAtMs = Date.parse(payload.expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
    throw new PluginAssetSessionError("plugin asset session timestamp invalid");
  }
  if (expiresAtMs <= nowMs) {
    throw new PluginAssetSessionError("plugin asset session expired", {
      code: "plugin_asset_session_expired",
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    sessionId: payload.sessionId,
    pluginId: payload.pluginId,
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

function pluginAssetSessionKeyPath(codiaHome: unknown): string {
  assertNonEmpty(codiaHome, "codiaHome");
  return path.join(codiaHome, "security", PLUGIN_ASSET_SESSION_KEY_FILE);
}

function signBody(codiaHome: string, body: string): string {
  return crypto
    .createHmac("sha256", readOrCreateSessionKey(codiaHome))
    .update(body)
    .digest("base64url");
}

function readOrCreateSessionKey(codiaHome: string): string {
  const filePath = pluginAssetSessionKeyPath(codiaHome);
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
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} required`);
  }
}
