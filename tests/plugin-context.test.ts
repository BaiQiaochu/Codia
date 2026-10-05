// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import { createPluginContext } from "../core/plugin-context.js";

async function makeBus() {
  const { EventBus } = await import("../hub/event-bus.js");
  return new EventBus();
}

describe("createPluginContext", () => {
  it("returns ctx with all required properties", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const ctx = createPluginContext({
      pluginId: "test-plugin",
      pluginDir: "/plugins/test-plugin",
      dataDir: "/plugin-data/test-plugin",
      bus,
    });
    expect(ctx.pluginId).toBe("test-plugin");
    expect(ctx.pluginDir).toBe("/plugins/test-plugin");
    expect(ctx.dataDir).toBe("/plugin-data/test-plugin");
    expect(ctx.bus).toBeDefined();
    expect(typeof ctx.bus.emit).toBe("function");
    expect(ctx.log).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(typeof ctx.config.get).toBe("function");
    expect(typeof ctx.config.set).toBe("function");
  });

  it("exposes server runtime scope when provided", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const ctx = createPluginContext({
      pluginId: "scoped-plugin",
      pluginDir: "/plugins/scoped-plugin",
      dataDir: "/plugin-data/scoped-plugin",
      bus,
      runtimeContext: {
        serverId: "server_scope",
        serverNodeId: "node_scope",
        userId: "user_scope",
        studioId: "studio_scope",
        connectionKind: "local",
        credentialKind: "loopback_token",
        platformAccountId: null,
        officialServiceKind: null,
        executionBoundary: {
          schemaVersion: 1,
          boundaryId: "execb_node_scope_studio_scope",
          kind: "local_process",
          serverNodeId: "node_scope",
          studioId: "studio_scope",
        },
      },
    });

    expect(ctx.serverId).toBe("server_scope");
    expect(ctx.serverNodeId).toBe("node_scope");
    expect(ctx.userId).toBe("user_scope");
    expect(ctx.studioId).toBe("studio_scope");
    expect(ctx.connectionKind).toBe("local");
    expect(ctx.credentialKind).toBe("loopback_token");
    expect(ctx.platformAccountId).toBeNull();
    expect(ctx.officialServiceKind).toBeNull();
    expect(ctx.executionBoundary).toMatchObject({
      boundaryId: "execb_node_scope_studio_scope",
      serverNodeId: "node_scope",
      studioId: "studio_scope",
    });
  });

  it("config.get/set reads and writes plugin-data config.json", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpDir = path.join(os.tmpdir(), "gsap-ctx-test-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const ctx = createPluginContext({
        pluginId: "x", pluginDir: "/tmp", dataDir: tmpDir,
        bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      });
      ctx.config.set("foo", 42);
      expect(ctx.config.get("foo")).toBe(42);
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
      expect(raw.global.foo).toBe(42);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stages plugin output files as session-file media items", () => {
    const registerSessionFile = vi.fn((entry) => ({
      id: "sf_plugin_output",
      fileId: "sf_plugin_output",
      sessionId: entry.sessionId,
      sessionPath: entry.sessionPath,
      sessionRef: entry.sessionRef || { sessionId: entry.sessionId, sessionPath: entry.sessionPath },
      filePath: entry.filePath,
      label: entry.label,
      mime: "text/plain",
      size: 12,
      kind: "document",
      origin: entry.origin,
      storageKind: entry.storageKind,
      status: "available",
    }));
    const ctx = createPluginContext({
      pluginId: "files",
      pluginDir: "/tmp",
      dataDir: "/tmp",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      registerSessionFile,
      runtimeContext: {
        sessionId: "sess_plugin_ctx",
        sessionPath: "/sessions/main.jsonl",
      },
    });

    const staged = ctx.stageFile({
      sessionPath: "/sessions/main.jsonl",
      filePath: process.platform === "win32" ? "C:\\tmp\\plugin.txt" : "/tmp/plugin.txt",
      label: "plugin.txt",
      origin: "user_supplied",
      storageKind: "external",
    });

    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/sessions/main.jsonl",
      label: "plugin.txt",
      origin: "plugin_output",
      storageKind: "plugin_data",
    }));
    expect(staged.mediaItem).toMatchObject({
      type: "session_file",
      fileId: "sf_plugin_output",
      sessionId: "sess_plugin_ctx",
      label: "plugin.txt",
      mime: "text/plain",
    });
  });

  it("rejects staging files without absolute paths", () => {
    const ctx = createPluginContext({
      pluginId: "files",
      pluginDir: "/tmp",
      dataDir: "/tmp",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      registerSessionFile: () => ({}),
    });

    expect(() => ctx.stageFile({
      sessionPath: "/sessions/main.jsonl",
      filePath: "relative.txt",
    })).toThrow("absolute filePath");
  });

  it("log has scoped prefix", () => {
    const ctx = createPluginContext({
      pluginId: "my-plug", pluginDir: "/tmp", dataDir: "/tmp",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
    });
    expect(typeof ctx.log.info).toBe("function");
    expect(typeof ctx.log.error).toBe("function");
  });

  it("forwards log entries to an optional log sink", () => {
    const logSink = vi.fn();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const ctx = createPluginContext({
        pluginId: "my-plug", pluginDir: "/tmp", dataDir: "/tmp",
        bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
        logSink,
      });
      ctx.log.info("hello", { token: "secret-token", count: 2 });
      expect(logSink).toHaveBeenCalledWith(expect.objectContaining({
        pluginId: "my-plug",
        level: "info",
        args: ["hello", { token: "secret-token", count: 2 }],
      }));
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("exposes declared network.fetch with host allowlist, timeout, and cache controls", async () => {
    const fetchImpl = vi.fn(async (url, init) => new Response(JSON.stringify({
      ok: true,
      url: String(url),
      signal: !!init?.signal,
      call: fetchImpl.mock.calls.length,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const ctx = createPluginContext({
      pluginId: "scores-plugin",
      pluginDir: "/plugins/scores-plugin",
      dataDir: "/plugin-data/scores-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      capabilities: ["network.fetch"],
      network: {
        allowedHosts: ["api.example.com"],
        methods: ["GET"],
        defaultTimeoutMs: 2500,
        maxResponseBytes: 1024,
      },
      fetchImpl,
    });

    const first = await ctx.network.fetch("https://api.example.com/live?league=world-cup", {
      cacheTtlMs: 1000,
    });
    const second = await ctx.network.fetch("https://api.example.com/live?league=world-cup", {
      cacheTtlMs: 1000,
    });

    await expect(first.json()).resolves.toMatchObject({ ok: true, signal: true, call: 1 });
    await expect(second.json()).resolves.toMatchObject({ ok: true, signal: true, call: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("GET");
  });

  it("rejects network.fetch when capability, host, localhost, or byte boundaries are violated", async () => {
    const base = {
      pluginId: "scores-plugin",
      pluginDir: "/plugins/scores-plugin",
      dataDir: "/plugin-data/scores-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
    };

    await expect(createPluginContext({
      ...base,
      capabilities: ["session"],
      network: { allowedHosts: ["api.example.com"] },
      fetchImpl: vi.fn(),
    }).network.fetch("https://api.example.com/live"))
      .rejects.toMatchObject({ code: "PLUGIN_NETWORK_CAPABILITY_NOT_DECLARED" });

    await expect(createPluginContext({
      ...base,
      capabilities: ["network.fetch"],
      network: { allowedHosts: ["api.example.com"] },
      fetchImpl: vi.fn(),
    }).network.fetch("https://evil.example.net/live"))
      .rejects.toMatchObject({ code: "PLUGIN_NETWORK_HOST_NOT_ALLOWED", host: "evil.example.net" });

    await expect(createPluginContext({
      ...base,
      capabilities: ["network.fetch"],
      network: { allowedHosts: ["127.0.0.1"] },
      fetchImpl: vi.fn(async () => new Response("ok")),
    }).network.fetch("http://127.0.0.1:11434/api/tags"))
      .rejects.toMatchObject({ code: "PLUGIN_NETWORK_PRIVATE_HOST_FORBIDDEN" });

    await expect(createPluginContext({
      ...base,
      capabilities: ["network.fetch"],
      network: { allowedHosts: ["127.0.0.1"], allowLocalhost: true },
      fetchImpl: vi.fn(async () => new Response("ok")),
    }).network.fetch("http://127.0.0.1:11434/api/tags"))
      .resolves.toBeInstanceOf(Response);

    await expect(createPluginContext({
      ...base,
      capabilities: ["network.fetch"],
      network: { allowedHosts: ["api.example.com"], maxResponseBytes: 3 },
      fetchImpl: vi.fn(async () => new Response("1234")),
    }).network.fetch("https://api.example.com/live"))
      .rejects.toMatchObject({ code: "PLUGIN_NETWORK_RESPONSE_TOO_LARGE", maxResponseBytes: 3 });
  });
});

describe("createPluginContext with accessLevel", () => {
  it("full-access context exposes bus.handle", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "full-access",
    });
    expect(typeof ctx.bus.handle).toBe("function");
    expect(typeof ctx.bus.request).toBe("function");
    expect(typeof ctx.bus.emit).toBe("function");
  });

  it("restricted context does NOT expose bus.handle", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    });
    expect(ctx.bus.handle).toBeUndefined();
    expect(typeof ctx.bus.request).toBe("function");
    expect(typeof ctx.bus.emit).toBe("function");
    expect(typeof ctx.bus.subscribe).toBe("function");
  });

  it("restricted context exposes read-only bus capability metadata", async () => {
    const bus = await makeBus();
    bus.handle("demo:read", async () => ({ ok: true }), {
      capability: {
        title: "Read demo",
        permission: "demo.read",
      },
    });

    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    });

    expect(ctx.bus.handle).toBeUndefined();
    expect(typeof ctx.bus.listCapabilities).toBe("function");
    expect(typeof ctx.bus.getCapability).toBe("function");
    expect(ctx.bus.getCapability("demo:read")).toMatchObject({
      type: "demo:read",
      permission: "demo.read",
      available: true,
    });
  });

  it("restricted bus proxy is frozen", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    });
    expect(Object.isFrozen(ctx.bus)).toBe(true);
    expect(() => { ctx.bus.handle = () => {}; }).toThrow();
  });

  it("restricted bus requests carry plugin caller context", async () => {
    const bus = {
      emit() {},
      subscribe() { return () => {}; },
      request: vi.fn(async () => ({ ok: true })),
      hasHandler() { return false; },
      listCapabilities() { return []; },
      getCapability() { return null; },
    };
    const ctx = createPluginContext({
      pluginId: "caller-plugin",
      pluginDir: "/tmp/caller",
      dataDir: "/tmp/caller-data",
      bus,
      accessLevel: "restricted",
    });

    await expect(ctx.bus.request("custom:task", { id: 1 }, { timeoutMs: 50 }))
      .resolves.toEqual({ ok: true });
    expect(bus.request).toHaveBeenCalledWith(
      "custom:task",
      { id: 1 },
      expect.objectContaining({
        timeoutMs: 50,
        caller: expect.objectContaining({
          kind: "plugin",
          pluginId: "caller-plugin",
          pluginKey: "caller-plugin",
          source: "community",
        }),
      }),
    );
  });

  it("defaults to restricted when accessLevel omitted", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus,
    });
    expect(ctx.bus.handle).toBeUndefined();
  });

  it("filters llm usage events and requests from restricted plugins without usage.read", async () => {
    const bus = await makeBus();
    bus.handle("usage:list", async () => ({ entries: [{ requestId: "req-1" }] }), {
      capability: {
        title: "Usage list",
        permission: "usage.read",
      },
    });
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    });

    await expect(ctx.bus.request("usage:list", {}))
      .rejects.toMatchObject({ code: "FORBIDDEN", permission: "usage.read" });
    expect(() => ctx.bus.subscribe(() => {}, { types: ["llm_usage"] }))
      .toThrow(/usage\.read/);
    expect(() => ctx.bus.emit({ type: "llm_usage", entry: { requestId: "req-x" } }, null))
      .toThrow(/usage\.read/);

    const events = [];
    const off = ctx.bus.subscribe((event) => events.push(event));
    bus.emit({ type: "llm_usage", entry: { requestId: "req-2" } }, null);
    bus.emit({ type: "other_event" }, null);
    off();
    expect(events).toEqual([{ type: "other_event" }]);
  });

  it("allows usage.read for restricted plugins that declare the permission", async () => {
    const bus = await makeBus();
    bus.handle("usage:list", async () => ({ entries: [{ requestId: "req-1" }] }), {
      capability: {
        title: "Usage list",
        permission: "usage.read",
      },
    });
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
      permissions: ["usage.read"],
    });

    await expect(ctx.bus.request("usage:list", {})).resolves.toEqual({
      entries: [{ requestId: "req-1" }],
    });
    const events = [];
    const off = ctx.bus.subscribe((event) => events.push(event), { types: ["llm_usage"] });
    bus.emit({ type: "llm_usage", entry: { requestId: "req-2" } }, null);
    off();
    expect(events).toEqual([{ type: "llm_usage", entry: { requestId: "req-2" } }]);
  });
});
