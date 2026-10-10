// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createPluginProxyRoute,
  createPluginsRoute,
  verifyPluginIframeTicketForHostRequest,
} from "../server/routes/plugins.js";
import { PluginIframeTicketError } from "../core/plugin-iframe-ticket-service.js";
import { PluginAssetSessionError } from "../core/plugin-asset-session-service.js";
import {
  isMalformedPluginAssetRequest,
  isPluginAssetRequest,
  verifyPluginAssetSessionForHostRequest,
} from "../server/http/plugin-assets.js";

describe("plugin route proxy", () => {
  it("dispatches to registered plugin route", async () => {
    const routeRegistry = new Map();
    const pluginApp = new Hono();
    pluginApp.get("/hello", (c) => c.json({ msg: "world" }));
    routeRegistry.set("my-plugin", pluginApp);
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    const res = await app.request("/api/plugins/my-plugin/hello");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: "world" });
  });

  it("returns 404 for unknown plugin", async () => {
    const routeRegistry = new Map();
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    const res = await app.request("/api/plugins/nope/hello");
    expect(res.status).toBe(404);
  });

  it("returns 404 after plugin is removed from registry", async () => {
    const routeRegistry = new Map();
    const pluginApp = new Hono();
    pluginApp.get("/test", (c) => c.text("ok"));
    routeRegistry.set("temp", pluginApp);
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    let res = await app.request("/api/plugins/temp/test");
    expect(res.status).toBe(200);
    routeRegistry.delete("temp");
    res = await app.request("/api/plugins/temp/test");
    expect(res.status).toBe(404);
  });
});

// ── Management API tests ──

function mockEngine(overrides = {}) {
  const routeRegistry = new Map();
  const allowFullAccess = overrides.allowFullAccess ?? false;
  const currentAgentId = overrides.currentAgentId || "default-agent";
  const defaultAgent = overrides.agent || { id: currentAgentId };
  return {
    appVersion: overrides.appVersion || "0.7.3",
    codiaHome: overrides.codiaHome,
    currentAgentId,
    getAgent: overrides.getAgent || vi.fn((agentId) => (
      agentId === currentAgentId ? defaultAgent : null
    )),
    fetch: overrides.fetch,
    pluginDevService: overrides.pluginDevService,
    getPluginInstallRecord: overrides.getPluginInstallRecord || vi.fn(() => null),
    recordPluginInstall: overrides.recordPluginInstall || vi.fn(),
    syncPluginExtensions: vi.fn(),
    pluginManager: {
      listPlugins: () => overrides.plugins || [],
      routeRegistry,
      enablePlugin: overrides.enablePlugin || vi.fn(),
      disablePlugin: overrides.disablePlugin || vi.fn(),
      removePlugin: overrides.removePlugin || vi.fn(),
      installPlugin: overrides.installPlugin || vi.fn(),
      setFullAccess: overrides.setFullAccess || vi.fn(),
      getAllConfigSchemas: () => [],
      getConfigSchema: () => null,
      getConfig: overrides.getConfig || (() => null),
      setConfig: overrides.setConfig || vi.fn(),
      getDiagnostics: overrides.getDiagnostics || (() => []),
      getPages: overrides.getPages || (() => []),
      getWidgets: overrides.getWidgets || (() => []),
      getUiHostCapabilityGrants: overrides.getUiHostCapabilityGrants || (() => []),
      getUserPluginsDir: () => "/user",
      isValidPluginDir: () => true,
      getAllowFullAccess: () => allowFullAccess,
      getRouteApp: (id) => routeRegistry.get(id) || null,
      ...overrides.pm,
    },
  };
}

function createApp(engine) {
  const app = new Hono();
  app.route("/api", createPluginsRoute(engine));
  return app;
}

function createAppWithProductionPluginResourceAuth(engine) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authPrincipal", {
      principalId: "local-test-principal",
      scopes: ["chat"],
    });
    const routePath = new URL(c.req.url).pathname;
    if (
      (c.req.method === "GET" || c.req.method === "HEAD")
      && /^\/api\/plugins\/[^/]+\/.+$/.test(routePath)
      && c.req.query("pluginIframeTicket")
    ) {
      try {
        verifyPluginIframeTicketForHostRequest(c, engine, { requireTicket: true });
      } catch (err) {
        if (err instanceof PluginIframeTicketError) {
          return c.json({ error: err.code, detail: err.message }, err.status);
        }
        throw err;
      }
      await next();
      return;
    }
    if (isMalformedPluginAssetRequest(c.req.url, routePath)) {
      return c.json({ error: "plugin_asset_not_found" }, 404);
    }
    if ((c.req.method === "GET" || c.req.method === "HEAD") && isPluginAssetRequest(routePath)) {
      try {
        const session = verifyPluginAssetSessionForHostRequest(c, engine, { requireSession: false });
        if (session) {
          await next();
          return;
        }
      } catch (err) {
        if (err instanceof PluginAssetSessionError) {
          return c.json({ error: err.code, detail: err.message }, err.status);
        }
        throw err;
      }
    }
    if (/^\/api\/plugins\/[^/]+\/.+$/.test(routePath) && routePath.includes("/assets/")) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
  app.route("/api", createPluginsRoute(engine));
  return app;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

describe("plugin asset session boundary", () => {
  it("issues a scoped HttpOnly asset cookie from plugin HTML and serves bundled web assets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-plugin-assets-"));
    try {
      const pluginDir = path.join(root, "demo-plugin");
      fs.mkdirSync(path.join(pluginDir, "assets", "dist"), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "assets", "dist", "app.js"), "console.log('demo');", "utf-8");
      fs.writeFileSync(path.join(pluginDir, "assets", "dist", "data.json"), "{\"ok\":true}", "utf-8");
      fs.writeFileSync(path.join(pluginDir, "assets", "dist", "clip.mp4"), "mp4", "utf-8");
      fs.writeFileSync(path.join(pluginDir, "assets", "dist", "clip.webm"), "webm", "utf-8");
      fs.writeFileSync(path.join(pluginDir, "assets", "dist", "clip.mov"), "mov", "utf-8");

      const pluginApp = new Hono();
      pluginApp.get("/page", (c) => c.html("<script type=\"module\" src=\"/api/plugins/demo/assets/dist/app.js\"></script>"));

      const engine = mockEngine({
        codiaHome: root,
        plugins: [{ id: "demo", name: "Demo", version: "1.0.0", status: "loaded", pluginDir }],
      });
      engine.pluginManager.routeRegistry.set("demo", pluginApp);
      const app = createAppWithProductionPluginResourceAuth(engine);

      const page = await app.request("/api/plugins/demo/page");
      expect(page.status).toBe(200);
      const cookie = page.headers.get("set-cookie") || "";
      expect(cookie).toContain("codia_plugin_assets_");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/api/plugins/demo/assets/");

      const blocked = await app.request("/api/plugins/demo/assets/dist/app.js");
      expect(blocked.status).toBe(403);

      const asset = await app.request("/api/plugins/demo/assets/dist/app.js", {
        headers: { Cookie: cookie },
      });
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(await asset.text()).toContain("demo");

      const json = await app.request("/api/plugins/demo/assets/dist/data.json", {
        headers: { Cookie: cookie },
      });
      expect(json.status).toBe(200);
      expect(json.headers.get("content-type")).toContain("application/json");

      for (const assetPath of [
        "/api/plugins/demo/assets/dist/clip.mp4",
        "/api/plugins/demo/assets/dist/clip.webm",
        "/api/plugins/demo/assets/dist/clip.mov",
      ]) {
        const video = await app.request(assetPath, { headers: { Cookie: cookie } });
        expect(video.status).toBe(200);
        expect(video.headers.get("content-type")).toContain("video/");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects plugin asset traversal, dotfiles, source maps, and unknown extensions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-plugin-assets-deny-"));
    try {
      const pluginDir = path.join(root, "demo-plugin");
      fs.mkdirSync(path.join(pluginDir, "assets", "dist"), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "assets", "dist", "app.js"), "console.log('demo');", "utf-8");
      fs.writeFileSync(path.join(pluginDir, "assets", "dist", "app.js.map"), "{}", "utf-8");
      fs.writeFileSync(path.join(pluginDir, "assets", ".secret.js"), "secret", "utf-8");
      fs.writeFileSync(path.join(pluginDir, "assets", "dist", "notes.txt"), "notes", "utf-8");

      const pluginApp = new Hono();
      pluginApp.get("/page", (c) => c.html("<main>demo</main>"));
      const engine = mockEngine({
        codiaHome: root,
        plugins: [{ id: "demo", name: "Demo", version: "1.0.0", status: "loaded", pluginDir }],
      });
      engine.pluginManager.routeRegistry.set("demo", pluginApp);
      const app = createAppWithProductionPluginResourceAuth(engine);
      const page = await app.request("/api/plugins/demo/page");
      const cookie = page.headers.get("set-cookie") || "";
      expect(cookie).toContain("codia_plugin_assets_");

      const normalizedTraversal = await app.request("/api/plugins/demo/assets/../outside.js", {
        headers: { Cookie: cookie },
      });
      expect(normalizedTraversal.status).toBe(404);

      for (const pathToReject of [
        "/api/plugins/demo/assets/%2e%2e/outside.js",
        "/api/plugins/demo/assets/.secret.js",
        "/api/plugins/demo/assets/dist/app.js.map",
        "/api/plugins/demo/assets/dist/notes.txt",
      ]) {
        const res = await app.request(pathToReject, { headers: { Cookie: cookie } });
        expect(res.status).toBe(404);
        const body = await res.text();
        if ((res.headers.get("content-type") || "").includes("application/json")) {
          expect(JSON.parse(body)).toEqual({ error: "plugin_asset_not_found" });
        } else {
          expect(body).toMatch(/404|not found/i);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("plugin management API", () => {
  describe("GET /plugins", () => {
    it("returns plugins with trust field", async () => {
      const engine = mockEngine({
        plugins: [
          { id: "a", name: "A", version: "1.0", description: "desc", status: "active", source: "community", trust: "full-access", contributions: {} },
        ],
      });
      const app = createApp(engine);
      const res = await app.request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].trust).toBe("full-access");
    });

    it("defaults trust to restricted", async () => {
      const engine = mockEngine({
        plugins: [
          { id: "b", name: "B", version: "1.0", description: "", status: "active", contributions: {} },
        ],
      });
      const app = createApp(engine);
      const res = await app.request("/api/plugins");
      const body = await res.json();
      expect(body[0].trust).toBe("restricted");
      expect(body[0].source).toBe("community");
    });
  });

  describe("GET /plugins/health", () => {
    it("reports unavailable reasons and hidden plugins when requested", async () => {
      const engine = mockEngine({
        plugins: [
          {
            id: "ok",
            name: "OK",
            version: "1.0",
            status: "loaded",
            source: "community",
            trust: "restricted",
            contributions: ["tools"],
            manifest: {},
          },
          {
            id: "legacy-video",
            name: "Legacy Video",
            version: "1.0",
            status: "loaded",
            hidden: true,
            source: "builtin",
            trust: "full-access",
            disabledTools: [{ file: "generate-video.js", name: "generate_video", reason: "disabled" }],
            manifest: {},
          },
          {
            id: "needs-config",
            name: "Needs Config",
            version: "1.0",
            status: "loaded",
            source: "community",
            trust: "full-access",
            manifest: {
              contributes: {
                configuration: {
                  required: ["apiKey"],
                  properties: { apiKey: { type: "string" } },
                },
              },
            },
            ctx: { config: { get: () => "" } },
          },
          {
            id: "failed",
            name: "Failed",
            version: "1.0",
            status: "failed",
            source: "community",
            trust: "restricted",
            error: "boom",
            manifest: {},
          },
        ],
      });
      const app = createApp(engine);

      let res = await app.request("/api/plugins/health");
      expect(res.status).toBe(200);
      let body = await res.json();
      expect(body.plugins.map(p => p.id)).not.toContain("legacy-video");

      res = await app.request("/api/plugins/health?includeHidden=1");
      body = await res.json();
      expect(body.summary).toMatchObject({ total: 4, ok: 1, warn: 2, error: 1 });
      expect(body.plugins.find(p => p.id === "legacy-video")).toMatchObject({
        health: "warn",
        hidden: true,
        disabledTools: [{ name: "generate_video" }],
      });
      expect(body.plugins.find(p => p.id === "needs-config")).toMatchObject({
        health: "warn",
        missingConfig: ["apiKey"],
      });
      expect(body.plugins.find(p => p.id === "failed")).toMatchObject({
        health: "error",
        reasons: ["boom"],
      });
    });
  });

  describe("DELETE /plugins/:id", () => {
    it("calls removePlugin and returns ok", async () => {
      const removeFn = vi.fn().mockResolvedValue(null);
      const engine = mockEngine({ removePlugin: removeFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/my-plugin", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(removeFn).toHaveBeenCalledWith("my-plugin");
    });

    it("returns 404 when plugin not found", async () => {
      const removeFn = vi.fn().mockRejectedValue(new Error("not found"));
      const engine = mockEngine({ removePlugin: removeFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/nope", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /plugins/:id/enabled", () => {
    it("enables a plugin", async () => {
      const enableFn = vi.fn().mockResolvedValue();
      const engine = mockEngine({ enablePlugin: enableFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/p1/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(enableFn).toHaveBeenCalledWith("p1");
    });

    it("disables a plugin", async () => {
      const disableFn = vi.fn().mockResolvedValue();
      const engine = mockEngine({ disablePlugin: disableFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/p1/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      expect(disableFn).toHaveBeenCalledWith("p1");
    });

    it("returns 404 when plugin not found", async () => {
      const enableFn = vi.fn().mockRejectedValue(new Error("not found"));
      const engine = mockEngine({ enablePlugin: enableFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/nope/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /plugins/settings", () => {
    it("returns allow_full_access setting", async () => {
      const engine = mockEngine({ allowFullAccess: true });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/settings");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ allow_full_access: true });
    });

    it("defaults to false", async () => {
      const engine = mockEngine({ allowFullAccess: false });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/settings");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ allow_full_access: false });
    });
  });

  describe("GET /plugins/diagnostics", () => {
    it("returns plugin, event bus, task, and schedule diagnostics", async () => {
      const engine = mockEngine({
        getDiagnostics: () => [{
          id: "demo",
          name: "Demo",
          hidden: false,
          status: "loaded",
          activationState: "activated",
          routes: { pages: [], widgets: [], settingsTabs: [] },
          tools: [{ name: "demo_tool" }],
          commands: [],
          providers: [],
          config: { keys: ["enabled"] },
        }],
      });
      engine.eventBus = { listCapabilities: () => [{ type: "plugin_event", available: true }] };
      engine.taskRegistry = {
        listAll: () => [{ taskId: "task_1", type: "demo" }],
        listSchedules: () => [{ scheduleId: "daily", type: "digest", enabled: true }],
      };
      const app = createApp(engine);

      const res = await app.request("/api/plugins/diagnostics");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        plugins: [{ id: "demo", activationState: "activated" }],
        eventBus: [{ type: "plugin_event", available: true }],
        tasks: [{ taskId: "task_1" }],
        schedules: [{ scheduleId: "daily", enabled: true }],
      });
    });
  });

  describe("plugin dev loop routes", () => {
    it("delegates tool invoke, enable state, diagnostics, surfaces, and scenarios to PluginDevService", async () => {
      const service = {
        invokeTool: vi.fn(async () => ({ ok: true, result: "pong" })),
        enablePlugin: vi.fn(async () => ({ ok: true, enabled: true })),
        disablePlugin: vi.fn(async () => ({ ok: true, enabled: false })),
        getDiagnostics: vi.fn(() => ({ slots: [] })),
        listSurfaces: vi.fn(() => [{ pluginId: "demo", kind: "page", route: "/page" }]),
        describeSurfaceDebug: vi.fn(() => ({ ok: true, selector: "#root" })),
        getScenarios: vi.fn(() => [{ id: "smoke", title: "Smoke", steps: [] }]),
        runScenario: vi.fn(async () => ({ ok: true, scenarioId: "smoke" })),
      };
      const app = createApp(mockEngine({ pluginDevService: service }));

      const invoke = await app.request("/api/plugins/dev/demo/tools/echo/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { text: "ping" }, sessionPath: "/sessions/a.jsonl", agentId: "agent-a" }),
      });
      expect(invoke.status).toBe(200);
      expect(await invoke.json()).toEqual({ ok: true, result: "pong" });
      expect(service.invokeTool).toHaveBeenCalledWith({
        pluginId: "demo",
        toolName: "echo",
        input: { text: "ping" },
        sessionPath: "/sessions/a.jsonl",
        agentId: "agent-a",
      });

      const disable = await app.request("/api/plugins/dev/demo/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, devRunId: "run-1" }),
      });
      expect(disable.status).toBe(200);
      expect(service.disablePlugin).toHaveBeenCalledWith("demo", { devRunId: "run-1" });

      const diagnostics = await app.request("/api/plugins/dev/diagnostics?pluginId=demo");
      expect(diagnostics.status).toBe(200);
      expect(service.getDiagnostics).toHaveBeenCalledWith("demo");

      const surfaces = await app.request("/api/plugins/dev/surfaces?pluginId=demo");
      expect(surfaces.status).toBe(200);
      expect(await surfaces.json()).toEqual([{ pluginId: "demo", kind: "page", route: "/page" }]);

      const describe = await app.request("/api/plugins/dev/surfaces/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: "demo", surfaceId: "main" }),
      });
      expect(describe.status).toBe(200);
      expect(service.describeSurfaceDebug).toHaveBeenCalledWith({ pluginId: "demo", surfaceId: "main" });

      const scenarios = await app.request("/api/plugins/dev/demo/scenarios");
      expect(scenarios.status).toBe(200);
      expect(await scenarios.json()).toEqual({
        pluginId: "demo",
        scenarios: [{ id: "smoke", title: "Smoke", steps: [] }],
      });

      const run = await app.request("/api/plugins/dev/demo/scenarios/smoke/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowDestructive: true }),
      });
      expect(run.status).toBe(200);
      expect(service.runScenario).toHaveBeenCalledWith({
        pluginId: "demo",
        scenarioId: "smoke",
        allowDestructive: true,
      });
    });

    it("returns a stable error code when PluginDevService is unavailable", async () => {
      const app = createApp(mockEngine());

      const res = await app.request("/api/plugins/dev/diagnostics");

      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({
        code: "PLUGIN_DEV_SERVICE_UNAVAILABLE",
      });
    });
  });

  describe("GET/PUT /plugins/:id/config", () => {
    it("returns redacted plugin config values", async () => {
      const engine = mockEngine({
        getConfig: () => ({
          pluginId: "demo",
          schema: { properties: { token: { type: "string", sensitive: true } } },
          values: { token: "********" },
        }),
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/demo/config");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ pluginId: "demo", values: { token: "********" } });
    });

    it("updates plugin config with scope metadata", async () => {
      const setConfig = vi.fn(() => ({
        pluginId: "demo",
        schema: { properties: { enabled: { type: "boolean" } } },
        values: { enabled: true },
        rawValues: { enabled: true },
      }));
      const engine = mockEngine({ setConfig });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/demo/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { enabled: true }, scope: "global" }),
      });

      expect(res.status).toBe(200);
      expect(setConfig).toHaveBeenCalledWith("demo", { enabled: true }, {
        scope: "global",
        agentId: undefined,
        sessionPath: undefined,
      });
      expect(await res.json()).toEqual({
        pluginId: "demo",
        schema: { properties: { enabled: { type: "boolean" } } },
        values: { enabled: true },
      });
    });

    it("deletes plugin config values when null is submitted", async () => {
      const setConfig = vi.fn(() => ({
        pluginId: "demo",
        schema: { properties: { defaultImageModel: { type: "object" } } },
        values: {},
        rawValues: {},
      }));
      const engine = mockEngine({ setConfig });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/demo/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { defaultImageModel: null }, scope: "global" }),
      });

      expect(res.status).toBe(200);
      expect(setConfig).toHaveBeenCalledWith("demo", { defaultImageModel: null }, {
        scope: "global",
        agentId: undefined,
        sessionPath: undefined,
      });
    });
  });

  describe("plugin UI host capability routes", () => {
    it("returns host capabilities for plugin pages and widgets", async () => {
      const engine = mockEngine({
        getPages: () => [{
          pluginId: "demo",
          title: "Demo Page",
          icon: "panel",
          route: "/page",
          hostCapabilities: ["external.open", "clipboard.writeText"],
        }],
        getWidgets: () => [{
          pluginId: "demo",
          title: "Demo Widget",
          icon: "widget",
          route: "/widget",
          hostCapabilities: ["sessionFile.open"],
        }],
      });
      const app = createApp(engine);

      const pagesRes = await app.request("/api/plugins/pages");
      expect(pagesRes.status).toBe(200);
      expect(await pagesRes.json()).toEqual([{
        pluginId: "demo",
        title: "Demo Page",
        icon: "panel",
        routeUrl: "/api/plugins/demo/page",
        hostCapabilities: ["external.open", "clipboard.writeText"],
      }]);

      const widgetsRes = await app.request("/api/plugins/widgets");
      expect(widgetsRes.status).toBe(200);
      expect(await widgetsRes.json()).toEqual([{
        pluginId: "demo",
        title: "Demo Widget",
        icon: "widget",
        routeUrl: "/api/plugins/demo/widget",
        hostCapabilities: ["sessionFile.open"],
      }]);
    });

    it("returns aggregate UI host capability grants", async () => {
      const engine = mockEngine({
        getUiHostCapabilityGrants: () => [{
          pluginId: "demo",
          hostCapabilities: ["external.open"],
        }],
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/ui-host-capabilities");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ pluginId: "demo", hostCapabilities: ["external.open"] }]);
    });
  });

  describe("PUT /plugins/settings", () => {
    it("calls setFullAccess and returns plugin list", async () => {
      const setFn = vi.fn().mockResolvedValue();
      const engine = mockEngine({
        setFullAccess: setFn,
        plugins: [
          { id: "x", name: "X", version: "1.0", description: "", status: "active", source: "community", trust: "restricted", contributions: {} },
        ],
      });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow_full_access: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].trust).toBe("restricted");
      expect(setFn).toHaveBeenCalledWith(true);
    });
  });

  describe("POST /plugins/install", () => {
    it("returns 400 when path is missing", async () => {
      const engine = mockEngine();
      const app = createApp(engine);
      const res = await app.request("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("path is required");
    });

    it("returns 400 for malformed JSON", async () => {
      const engine = mockEngine();
      const app = createApp(engine);
      const res = await app.request("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{bad json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid JSON body" });
    });

    it("returns 500 when pluginManager is null", async () => {
      const engine = { pluginManager: null };
      const app = createApp(engine);
      const res = await app.request("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/some/dir" }),
      });
      expect(res.status).toBe(500);
    });

    it("rejects dragged OpenClaw plugin zips with an explicit incompatibility error", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-openclaw-plugin-"));
      try {
        const userPluginsDir = path.join(tmpDir, "plugins");
        const sourcePath = path.join(tmpDir, "openclaw-plugin.zip");
        fs.writeFileSync(sourcePath, makeStoredZip({
          "openclaw-voice/openclaw.plugin.json": JSON.stringify({
            id: "openclaw-voice",
            name: "OpenClaw Voice",
            version: "1.0.0",
            configSchema: { type: "object", additionalProperties: false },
          }),
          "openclaw-voice/package.json": JSON.stringify({
            name: "openclaw-voice",
            version: "1.0.0",
          }),
        }));
        const installPlugin = vi.fn();
        const engine = mockEngine({
          pm: {
            getUserPluginsDir: () => userPluginsDir,
            installPlugin,
          },
        });
        const app = createApp(engine);

        const res = await app.request("/api/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourcePath }),
        });
        const data = await res.json();

        expect(res.status).toBe(400);
        expect(data).toMatchObject({ code: "PLUGIN_FORMAT_INCOMPATIBLE" });
        expect(data.error).toMatch(/OpenClaw-style plugin package/i);
        expect(installPlugin).not.toHaveBeenCalled();
        expect(fs.readdirSync(userPluginsDir)).toEqual([]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("restores the previous plugin directory when replacement fails to load", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codia-plugin-rollback-"));
      try {
        const userPluginsDir = path.join(tmp, "plugins");
        const existingDir = path.join(userPluginsDir, "demo");
        const sourceDir = path.join(tmp, "incoming", "demo");
        fs.mkdirSync(existingDir, { recursive: true });
        fs.writeFileSync(path.join(existingDir, "manifest.json"), JSON.stringify({
          id: "demo",
          name: "Demo",
          version: "1.0.0",
        }), "utf-8");
        fs.writeFileSync(path.join(existingDir, "old.txt"), "old version", "utf-8");
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify({
          id: "demo",
          name: "Demo",
          version: "2.0.0",
        }), "utf-8");
        fs.writeFileSync(path.join(sourceDir, "new.txt"), "new version", "utf-8");
        const installPlugin = vi.fn()
          .mockRejectedValueOnce(new Error("load exploded"))
          .mockResolvedValueOnce({ id: "demo", name: "Demo", version: "1.0.0", status: "loaded" });
        const engine = mockEngine({
          codiaHome: tmp,
          pm: {
            getUserPluginsDir: () => userPluginsDir,
            listPlugins: () => [{ id: "demo", name: "Demo", version: "1.0.0", status: "loaded", pluginDir: existingDir }],
            installPlugin,
            isValidPluginDir: (dir) => fs.existsSync(path.join(dir, "manifest.json")),
          },
        });
        const app = createApp(engine);

        const res = await app.request("/api/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourceDir }),
        });

        expect(res.status).toBe(500);
        expect(await res.json()).toMatchObject({ error: "load exploded" });
        expect(fs.existsSync(path.join(existingDir, "old.txt"))).toBe(true);
        expect(fs.existsSync(path.join(existingDir, "new.txt"))).toBe(false);
        expect(installPlugin).toHaveBeenCalledTimes(2);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("GET /plugins/marketplace", () => {
    it("returns deterministic version state for marketplace plugins", async () => {
      const oldDir = path.join(os.tmpdir(), "codia-plugin-old");
      const newDir = path.join(os.tmpdir(), "codia-plugin-new");
      const plugin = {
        id: "demo",
        name: "Demo",
        publisher: "Codia",
        description: "Demo plugin",
        trust: "restricted",
        permissions: [],
        contributions: ["tools"],
        version: "2.0.0",
        versions: [
          {
            version: "2.0.0",
            compatibility: { minAppVersion: "9.0.0" },
            distribution: { kind: "source", path: newDir, resolvedPath: newDir },
          },
          {
            version: "1.0.0",
            compatibility: { minAppVersion: "0.1.0" },
            distribution: { kind: "source", path: oldDir, resolvedPath: oldDir },
          },
        ],
        readme: "# Demo",
      };
      const engine = mockEngine({
        appVersion: "0.7.3",
        plugins: [{ id: "demo", name: "Demo", version: "1.0.0", status: "loaded" }],
      });
      engine.pluginMarketplace = {
        load: async () => ({ source: { kind: "file", configured: true }, schemaVersion: 1, plugins: [plugin], warnings: [] }),
        resolveSourceDistribution: (item) => item.distribution?.resolvedPath || null,
      };
      const app = createApp(engine);

      const res = await app.request("/api/plugins/marketplace");

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        plugins: [{
          id: "demo",
          installed: true,
          installedVersion: "1.0.0",
          latestVersion: "2.0.0",
          selectedVersion: "1.0.0",
          updateAvailable: false,
          reinstall: true,
          installAction: "reinstall",
          canInstall: true,
        }],
      });
    });

    it("blocks marketplace downgrades unless explicitly allowed and records deterministic installs", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codia-marketplace-version-"));
      try {
        const userPluginsDir = path.join(tmp, "plugins");
        const sourceDir = path.join(tmp, "sources", "demo");
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify({
          id: "demo",
          name: "Demo",
          version: "1.0.0",
        }), "utf-8");
        const plugin = {
          id: "demo",
          name: "Demo",
          publisher: "Codia",
          description: "Demo plugin",
          trust: "restricted",
          permissions: [],
          contributions: ["tools"],
          version: "2.0.0",
          versions: [
            {
              version: "2.0.0",
              compatibility: { minAppVersion: "9.0.0" },
              distribution: { kind: "source", path: "missing-v2", resolvedPath: path.join(tmp, "missing-v2") },
            },
            {
              version: "1.0.0",
              compatibility: { minAppVersion: "0.1.0" },
              distribution: { kind: "source", path: "sources/demo", resolvedPath: sourceDir },
            },
          ],
          readme: "# Demo",
        };
        const recordPluginInstall = vi.fn();
        const installPlugin = vi.fn(async (dir) => ({
          id: "demo",
          name: "Demo",
          version: "1.0.0",
          installedManifestExists: fs.existsSync(path.join(dir, "manifest.json")),
        }));
        const engine = mockEngine({
          appVersion: "0.7.3",
          codiaHome: tmp,
          plugins: [{ id: "demo", name: "Demo", version: "2.0.0", status: "loaded", pluginDir: path.join(userPluginsDir, "demo") }],
          recordPluginInstall,
          pm: {
            getUserPluginsDir: () => userPluginsDir,
            installPlugin,
            listPlugins: () => [{ id: "demo", name: "Demo", version: "2.0.0", status: "loaded", pluginDir: path.join(userPluginsDir, "demo") }],
            isValidPluginDir: (dir) => fs.existsSync(path.join(dir, "manifest.json")),
          },
        });
        engine.pluginMarketplace = {
          load: async () => ({ source: { kind: "file", configured: true, path: path.join(tmp, "marketplace.json") }, schemaVersion: 1, plugins: [plugin], warnings: [] }),
          getPlugin: async () => plugin,
          getReadme: async () => "# Demo",
          resolveSourceDistribution: (item) => item.distribution?.resolvedPath || null,
        };
        const app = createApp(engine);

        const rejected = await app.request("/api/plugins/marketplace/demo/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ code: "PLUGIN_VERSION_DOWNGRADE" });

        const allowed = await app.request("/api/plugins/marketplace/demo/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowDowngrade: true }),
        });
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toMatchObject({
          id: "demo",
          version: "1.0.0",
          installedManifestExists: true,
        });
        expect(recordPluginInstall).toHaveBeenCalledWith(expect.objectContaining({
          pluginId: "demo",
          installedVersion: "1.0.0",
          source: "marketplace",
          marketplaceId: "demo",
          distributionKind: "source",
        }));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
