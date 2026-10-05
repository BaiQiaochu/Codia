// @ts-nocheck
/**
 * Shared helpers for Hono route handlers.
 */

export class InvalidJsonBodyError extends Error {
  constructor(message = "invalid JSON body") {
    super(message);
    this.name = "InvalidJsonBodyError";
    this.status = 400;
    this.httpStatus = 400;
  }
}

export function isInvalidJsonBodyError(err) {
  return err instanceof InvalidJsonBodyError
    || err?.name === "InvalidJsonBodyError"
    || (err?.status === 400 && err?.message === "invalid JSON body");
}

export function routeError(c, err, fallbackStatus = 500) {
  const status = Number.isInteger(err?.status)
    ? err.status
    : Number.isInteger(err?.httpStatus)
      ? err.httpStatus
      : fallbackStatus;
  return c.json({ error: err?.message || "internal server error" }, status);
}

/** Backward-compatible JSON parser: empty or invalid bodies return fallback. */
export async function safeJson(c, fallback = {}) {
  try {
    const text = await c.req.text();
    return text && text.trim() ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

/** Strict JSON parser for public APIs: malformed JSON is a client error. */
export async function strictJson(c, fallback = {}) {
  const text = await c.req.text();
  if (!text || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonBodyError();
  }
}
