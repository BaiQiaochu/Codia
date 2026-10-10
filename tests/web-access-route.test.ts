// @ts-nocheck
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

describe("web access preferences route", () => {
  it("generates, reads, and revokes a web access API key", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();

    let webAccess = {};
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      preferences: {
        getWebAccess: vi.fn(() => ({
          enabled: !!webAccess.api_key,
          api_key: webAccess.api_key || "",
          created_at: webAccess.created_at || null,
        })),
        setWebAccess: vi.fn((next) => { webAccess = next; }),
        clearWebAccess: vi.fn(() => { webAccess = {}; }),
      },
    };

    app.route("/api", createPreferencesRoute(engine));

    const emptyRes = await app.request("/api/preferences/web-access");
    expect(await emptyRes.json()).toEqual({
      enabled: false,
      api_key: "",
      created_at: null,
    });

    const genRes = await app.request("/api/preferences/web-access/generate", { method: "POST" });
    const generated = await genRes.json();
    expect(genRes.status).toBe(200);
    expect(generated.enabled).toBe(true);
    expect(generated.api_key).toMatch(/^codia_/);
    expect(generated.created_at).toBeTruthy();
    expect(engine.preferences.setWebAccess).toHaveBeenCalledWith({
      api_key: generated.api_key,
      created_at: generated.created_at,
      enabled: true,
    });

    const readRes = await app.request("/api/preferences/web-access");
    expect(await readRes.json()).toEqual({
      enabled: true,
      api_key: generated.api_key,
      created_at: generated.created_at,
    });

    const revokeRes = await app.request("/api/preferences/web-access", { method: "DELETE" });
    expect(revokeRes.status).toBe(200);
    expect(await revokeRes.json()).toEqual({ ok: true });
    expect(engine.preferences.clearWebAccess).toHaveBeenCalled();
  });

  it("accepts header token formats for HTTP and keeps query tokens opt-in for local sockets", async () => {
    const {
      extractAccessTokenFromHono,
      extractAccessTokenFromNodeRequest,
    } = await import("../server/access-token.js");

    const app = new Hono();
    const validKeys = new Set(["server-token", "web-key"]);

    app.use("*", async (c, next) => {
      if (!validKeys.has(extractAccessTokenFromHono(c))) {
        return c.json({ error: "forbidden" }, 403);
      }
      await next();
    });
    app.get("/api/health", (c) => c.json({ status: "ok" }));

    const acceptedRequests = [
      ["/api/health", { headers: { Authorization: "Bearer web-key" } }],
      ["/api/health", { headers: { Authorization: "bearer web-key" } }],
      ["/api/health", { headers: { Authorization: "Token web-key" } }],
      ["/api/health", { headers: { "X-API-Key": "web-key" } }],
      ["/api/health", { headers: { "X-CODIA-API-Key": "web-key" } }],
      ["/api/health", { headers: { "X-codia-API-Key": "web-key" } }],
      ["/api/health", { headers: { Authorization: "Bearer server-token" } }],
    ];

    for (const [url, init] of acceptedRequests) {
      const res = await app.request(url, init);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    }

    const rejected = await app.request("/api/health", {
      headers: { "X-API-Key": "wrong-key" },
    });
    expect(rejected.status).toBe(403);

    for (const url of [
      "/api/health?token=web-key",
      "/api/health?api_key=web-key",
      "/api/health?apikey=web-key",
    ]) {
      const res = await app.request(url);
      expect(res.status).toBe(403);
    }

    expect(extractAccessTokenFromNodeRequest({
      url: "/ws?api_key=web-key",
      headers: { host: "127.0.0.1:8123" },
    })).toBe("");
    expect(extractAccessTokenFromNodeRequest({
      url: "/ws?api_key=web-key",
      headers: { host: "127.0.0.1:8123" },
    }, { allowQuery: true })).toBe("web-key");
    expect(extractAccessTokenFromNodeRequest({
      url: "/ws?token=web-key",
      headers: { host: "127.0.0.1:8123" },
    }, { allowQuery: true })).toBe("web-key");
    expect(extractAccessTokenFromNodeRequest({
      url: "/ws?apikey=web-key",
      headers: { host: "127.0.0.1:8123" },
    }, { allowQuery: true })).toBe("web-key");
    expect(extractAccessTokenFromNodeRequest({
      url: "/ws?api_key=wrong-key",
      headers: { host: "127.0.0.1:8123", authorization: "Bearer web-key" },
    })).toBe("web-key");
    expect(extractAccessTokenFromNodeRequest({
      url: "/internal/browser",
      headers: { host: "127.0.0.1:8123", authorization: "Bearer web-key" },
    })).toBe("web-key");
    expect(extractAccessTokenFromNodeRequest({
      url: "/ws",
      headers: { host: "127.0.0.1:8123", "x-api-key": "web-key" },
    })).toBe("web-key");
  });
});
