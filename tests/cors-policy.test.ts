import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createCorsMiddleware, isCorsOriginAllowed } from "../server/http/cors-policy.js";

describe("CORS policy", () => {
  it("preserves host CORS headers on responses forwarded from a plugin", async () => {
    const plugin = new Hono();
    plugin.get("/providers", c => c.json({ providers: [] }));
    const host = new Hono();
    host.use("*", createCorsMiddleware());
    host.get("/api/plugins/image-gen/providers", () => plugin.request("/providers"));
    const response = await host.request("/api/plugins/image-gen/providers", {
      headers: { Origin: "http://127.0.0.1:59123" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:59123");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(await response.json()).toEqual({ providers: [] });
  });

  it("handles preflight and keeps disallowed origins outside the allowlist", async () => {
    const host = new Hono();
    host.use("*", createCorsMiddleware());
    const preflight = await host.request("/api/plugins/test", {
      method: "OPTIONS", headers: { Origin: "http://localhost:54321" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    const untrusted = await host.request("/missing", { headers: { Origin: "https://untrusted.example" } });
    expect(untrusted.status).toBe(404);
    expect(untrusted.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows Electron file and loopback browser origins by default", () => {
    expect(isCorsOriginAllowed({ origin: "null" })).toBe(true);
    expect(isCorsOriginAllowed({ origin: "file://" })).toBe(true);
    expect(isCorsOriginAllowed({ origin: "http://localhost:5173" })).toBe(true);
    expect(isCorsOriginAllowed({ origin: "http://127.0.0.1:14500" })).toBe(true);
  });

  it("does not allow arbitrary LAN or public origins unless explicitly configured", () => {
    expect(isCorsOriginAllowed({ origin: "http://192.168.31.75:5173" })).toBe(false);
    expect(isCorsOriginAllowed({ origin: "https://example.com" })).toBe(false);
    expect(isCorsOriginAllowed({
      origin: "https://example.com",
      configuredOrigin: "https://example.com",
    })).toBe(true);
    expect(isCorsOriginAllowed({
      origin: "https://evil.example",
      configuredOrigin: "https://example.com",
    })).toBe(false);
  });
});
