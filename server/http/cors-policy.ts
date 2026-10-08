import type { MiddlewareHandler } from "hono";

const DEFAULT_LOOPBACK_WEB_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ELECTRON_FILE_ORIGINS = new Set(["file://", "file:///"]);

export function isCorsOriginAllowed({
  origin,
  configuredOrigin = "",
}: { origin?: unknown; configuredOrigin?: string } = {}): boolean {
  const value = String(origin || "");
  if (!value) return false;
  if (configuredOrigin) return value === configuredOrigin;
  if (value === "null") return true;
  if (ELECTRON_FILE_ORIGINS.has(value)) return true;
  return DEFAULT_LOOPBACK_WEB_ORIGIN.test(value);
}

// Apply host headers after downstream routes return: plugin routes may return
// their own Response, replacing headers prepared on the parent context.
export function createCorsMiddleware(configuredOrigin = ""): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "OPTIONS") await next();
    const origin = c.req.header("origin") || "";
    if (origin && isCorsOriginAllowed({ origin, configuredOrigin })) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin", { append: true });
      c.header("Access-Control-Allow-Credentials", "true");
    }
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-GSAP-API-Key, X-gsap-API-Key, X-GSAP-VSCode-Bridge, X-Requested-With");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
  };
}
