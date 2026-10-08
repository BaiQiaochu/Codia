import crypto from "crypto";
import { Hono } from "hono";
import { safeJson } from "./hono-helpers.ts";

const SESSION_DAYS = 7;
const SESSION_TTL_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const PASSWORD_SHA256 = "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92";

const PWA_USERS = new Map([
  ["15207718306", { id: "15207718306", name: "15207718306", passwordHash: PASSWORD_SHA256 }],
  ["BoshiPOC", { id: "BoshiPOC", name: "BoshiPOC", passwordHash: PASSWORD_SHA256 }],
]);

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function decodeBase64url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function readBearerToken(c) {
  const header = c.req.header("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match?.[1]) return match[1].trim();
  const url = new URL(c.req.url);
  return (url.searchParams.get("token") || "").trim();
}

function createToken(userId, secret, now = Date.now()) {
  const payload = base64url(JSON.stringify({
    scope: "pwa",
    sub: userId,
    iat: now,
    exp: now + SESSION_TTL_MS,
  }));
  return `pwa.${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || !token.startsWith("pwa.")) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [, payload, signature] = parts;
  const expected = sign(payload, secret);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  let data;
  try {
    data = JSON.parse(decodeBase64url(payload));
  } catch {
    return null;
  }
  if (data?.scope !== "pwa" || typeof data.sub !== "string" || !Number.isFinite(data.exp)) return null;
  if (data.exp <= now) return null;
  if (!PWA_USERS.has(data.sub)) return null;
  return { userId: data.sub, expiresAt: data.exp };
}

export function createPwaAuth({ secret }) {
  const route = new Hono();

  route.post("/pwa-auth/login", async (c) => {
    const body = await safeJson(c);
    const account = typeof body.account === "string" ? body.account.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = PWA_USERS.get(account);
    const passwordHash = sha256Hex(password);

    if (!user || !timingSafeEqualHex(passwordHash, user.passwordHash)) {
      return c.json({ ok: false, error: "invalid_credentials" }, 401);
    }

    const token = createToken(user.id, secret);
    const verified = verifyToken(token, secret);
    return c.json({
      ok: true,
      token,
      account: user.name,
      expiresAt: verified?.expiresAt || null,
    });
  });

  route.get("/pwa-auth/status", async (c) => {
    const token = readBearerToken(c);
    const session = verifyToken(token, secret);
    if (!session) return c.json({ authenticated: false });
    return c.json({ authenticated: true, account: session.userId, expiresAt: session.expiresAt });
  });

  return {
    route,
    isValidToken: (token) => !!verifyToken(token, secret),
    getSession: (token) => verifyToken(token, secret),
  };
}

export const __test__ = {
  createToken,
  verifyToken,
};
