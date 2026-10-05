import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeImageGenCtx(tmpDir: string, options: any = {}) {
  const defaultImageModel = options.defaultImageModel || { provider: "mock-provider", id: "mock-image" };
  const mediaProviders = options.mediaProviders || {
    "mock-provider": {
      providerId: "mock-provider",
      hasCredentials: true,
      models: [{ id: "mock-image", protocolId: "mock-protocol" }],
    },
  };
  const resolveMediaModel = options.resolveMediaModel || (async ({ providerId, modelId }) => ({
    providerId,
    modelId,
    protocolId: "mock-protocol",
  }));
  return {
    dataDir: path.join(tmpDir, "image-gen"),
    config: { get: vi.fn((key) => (key === "defaultImageModel" ? defaultImageModel : undefined)) },
    _mediaGen: {
      registry: {
        getProtocol: vi.fn(() => ({ id: "mock-protocol", checkAuth: vi.fn(async () => ({ ok: true })) })),
        get: vi.fn(() => null),
      },
    },
    bus: {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:resolve-media-model") {
          return resolveMediaModel(payload || {});
        }
        if (type === "provider:media-providers") {
          return { providers: mediaProviders };
        }
        return {};
      }),
    },
  };
}

function makeEngine(
  tmpDir: string,
  disabledOrOptions: any = [],
  pluginTools: any[] = [{ _pluginId: "beautify", name: "beautify_create-cover" }],
) {
  const options = Array.isArray(disabledOrOptions)
    ? { disabled: disabledOrOptions, pluginTools }
    : (disabledOrOptions || {});
  const disabled = options.disabled || [];
  const agent = {
    id: "agent-1",
    name: "G-SAP",
    agentName: "G-SAP",
    config: { tools: { disabled } },
  };
  const emitEvent = vi.fn();
  const executeIsolated = options.executeIsolated || vi.fn(async () => ({
    sessionPath: path.join(tmpDir, "agents", "agent-1", "activity", "cover.jsonl"),
  }));
  const activityStore = options.activityStore || {
    add: vi.fn((activity) => activity),
    update: vi.fn((id, patch) => ({ id, ...patch })),
  };
  const imageGenCtx = options.imageGenCtx || makeImageGenCtx(tmpDir);
  return {
    gsapHome: path.join(tmpDir, "gsap-home"),
    deskCwd: tmpDir,
    homeCwd: tmpDir,
    currentAgentId: agent.id,
    agent,
    agentsDir: path.join(tmpDir, "agents"),
    getAgent: () => agent,
    getPrimaryAgentId: () => agent.id,
    getActivityStore: () => activityStore,
    listAgents: () => [agent],
    executeIsolated,
    ...(options.media ? { media: options.media } : {}),
    pluginManager: {
      getAllTools: () => options.pluginTools ?? [{ _pluginId: "beautify", name: "beautify_create-cover" }],
      getPlugin: (id) => (id === "image-gen" ? { ctx: imageGenCtx, status: "loaded" } : null),
    },
    emitEvent,
    _test: { activityStore, executeIsolated, imageGenCtx },
  };
}

describe("desk beautify cover apply route", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-cover-route-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a user-selected local image through the same cover service", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "cover.png");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    fs.writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x04, 0x00,
    ]));

    const { createDeskRoute } = await import("../server/routes/desk.js");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, imageFilePath: imagePath, agentId: "agent-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "app_event",
      event: {
        type: "markdown-cover-updated",
        payload: { filePath: notePath },
        source: "server",
      },
    }, null);
  });

  it("allows direct system cover apply when agent generation is disabled", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "cover.png");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    fs.writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x04, 0x00,
    ]));

    const { createDeskRoute } = await import("../server/routes/desk.js");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir, ["beautify"]), null));

    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, imageFilePath: imagePath, agentId: "agent-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
  });

  it("reports system cover availability separately from AI generation", async () => {
    const { createDeskRoute } = await import("../server/routes/desk.js");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir, ["beautify"]), null));

    const res = await app.request("/api/desk/beautify/status?executorAgentId=agent-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      systemCover: { available: true },
      agentGenerate: {
        available: true,
        enabled: false,
        executorAgentId: "agent-1",
        disabledReason: "beautify-disabled",
        settingsTarget: "agent-tools",
      },
      available: true,
      enabled: false,
      agentId: "agent-1",
    });
  });

  it("keeps UI AI cover generation available when the agent beautify chat tool is disabled", async () => {
    const { createDeskRoute } = await import("../server/routes/desk.js");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir, ["beautify"]), null));

    const res = await app.request("/api/desk/beautify/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      systemCover: { available: true },
      agentGenerate: {
        available: true,
        enabled: true,
        executorAgentId: "agent-1",
        disabledReason: null,
      },
      available: true,
      enabled: true,
      agentId: "agent-1",
    });
  });

  it("keeps UI AI cover generation available when the saved default image model was removed", async () => {
    const imageGenCtx = makeImageGenCtx(tmpDir, {
      defaultImageModel: { provider: "tu", id: "gptimage2" },
      mediaProviders: {
        minimax: {
          providerId: "minimax",
          hasCredentials: true,
          models: [{ id: "image-01", protocolId: "mock-protocol" }],
        },
      },
      resolveMediaModel: async ({ providerId, modelId }) => {
        if (providerId === "tu" && modelId === "gptimage2") {
          return { error: 'Media model "tu/gptimage2" not found' };
        }
        return { providerId, modelId, protocolId: "mock-protocol" };
      },
    });

    const { createDeskRoute } = await import("../server/routes/desk.js");
    const engine = makeEngine(tmpDir, { imageGenCtx });
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      agentGenerate: {
        available: true,
        enabled: true,
        disabledReason: null,
      },
      enabled: true,
    });
    expect(imageGenCtx.bus.request).toHaveBeenCalledWith("provider:resolve-media-model", expect.objectContaining({
      providerId: "tu",
      modelId: "gptimage2",
    }));
    expect(imageGenCtx.bus.request).toHaveBeenCalledWith("provider:resolve-media-model", expect.objectContaining({
      providerId: "minimax",
      modelId: "image-01",
    }));

    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    const coverRes = await app.request("/api/desk/beautify/cover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, executorAgentId: "agent-1" }),
    });

    expect(coverRes.status).toBe(200);
    expect(await coverRes.json()).toMatchObject({ ok: true });
    expect(engine._test.executeIsolated.mock.calls[0][0]).toContain("media_generate-image");
    expect(engine._test.executeIsolated.mock.calls[0][0]).toContain("provider: minimax");
    expect(engine._test.executeIsolated.mock.calls[0][0]).toContain("model: image-01");
  });

  it("keeps UI AI cover generation available when native media default was removed", async () => {
    const imageGenCtx = makeImageGenCtx(tmpDir, {
      defaultImageModel: { provider: "tu", id: "gptimage2" },
      mediaProviders: {},
      resolveMediaModel: async ({ providerId, modelId }) => {
        if (providerId === "tu" && modelId === "gptimage2") {
          return { error: 'Media model "tu/gptimage2" not found' };
        }
        return { providerId, modelId, protocolId: "mock-protocol" };
      },
    });
    const media = {
      getImageConfig: vi.fn(() => ({
        defaultImageModel: { provider: "tu", id: "gptimage2" },
      })),
      resolveImageModelRef: vi.fn((ref) => {
        if (ref.providerId === "tu" && ref.modelId === "gptimage2") {
          throw new Error('Media model "tu/gptimage2" not found');
        }
        return {
          providerId: ref.providerId,
          modelId: ref.modelId,
          protocolId: "mock-protocol",
        };
      }),
      listImageProviders: vi.fn(async () => ({
        providers: {
          minimax: {
            providerId: "minimax",
            hasCredentials: true,
            models: [{ id: "image-01", protocolId: "mock-protocol" }],
          },
        },
      })),
    };

    const { createDeskRoute } = await import("../server/routes/desk.js");
    const engine = makeEngine(tmpDir, { imageGenCtx, media });
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      agentGenerate: {
        available: true,
        enabled: true,
        disabledReason: null,
      },
      enabled: true,
    });
    expect(media.resolveImageModelRef).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "tu",
      modelId: "gptimage2",
    }));
    expect(media.resolveImageModelRef).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "minimax",
      modelId: "image-01",
    }));

    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    const coverRes = await app.request("/api/desk/beautify/cover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, executorAgentId: "agent-1" }),
    });

    expect(coverRes.status).toBe(200);
    expect(await coverRes.json()).toMatchObject({ ok: true });
    expect(engine._test.executeIsolated.mock.calls[0][0]).toContain("media_generate-image");
    expect(engine._test.executeIsolated.mock.calls[0][0]).toContain("provider: minimax");
    expect(engine._test.executeIsolated.mock.calls[0][0]).toContain("model: image-01");
  });

  it("starts the controlled UI AI cover task when the agent beautify chat tool is disabled", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    const executeIsolated = vi.fn(async () => ({
      sessionPath: path.join(tmpDir, "agents", "agent-1", "activity", "cover.jsonl"),
    }));

    const { createDeskRoute } = await import("../server/routes/desk.js");
    const engine = makeEngine(tmpDir, { disabled: ["beautify"], executeIsolated });
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, executorAgentId: "agent-1", userGuidance: "warm light" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(engine._test.activityStore.add).toHaveBeenCalledWith(expect.objectContaining({
      type: "beautify",
      agentId: "agent-1",
      targetFilePath: notePath,
    }));
    expect(executeIsolated).toHaveBeenCalledWith(
      expect.stringContaining("warm light"),
      expect.objectContaining({
        agentId: "agent-1",
        activityType: "beautify",
        toolFilter: "*",
      }),
    );
  });

  it("keeps built-in cover actions available when the agent beautify tool is not registered", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "cover.png");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    fs.writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x04, 0x00,
    ]));

    const { createDeskRoute } = await import("../server/routes/desk.js");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir, [], []), null));

    const statusRes = await app.request("/api/desk/beautify/status?executorAgentId=agent-1");
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toMatchObject({
      systemCover: { available: true },
      agentGenerate: {
        enabled: false,
        disabledReason: "beautify-plugin-unavailable",
      },
      available: true,
      enabled: false,
    });

    const applyRes = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, imageFilePath: imagePath, agentId: "agent-1" }),
    });

    expect(applyRes.status).toBe(200);
    expect((await applyRes.json()).ok).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
  });

  it("applies a built-in cover gallery preset through a whitelist id", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { COVER_GALLERY_PRESETS } = await import("../shared/cover-gallery-presets.ts");
    const { createDeskRoute } = await import("../server/routes/desk.js");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: notePath,
        presetId: COVER_GALLERY_PRESETS[0].id,
        agentId: "agent-1",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "app_event",
      event: {
        type: "markdown-cover-updated",
        payload: { filePath: notePath },
        source: "server",
      },
    }, null);
  });

  it("rejects unknown built-in cover gallery preset ids", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { createDeskRoute } = await import("../server/routes/desk.js");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir), null));

    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: notePath,
        presetId: "../private",
        agentId: "agent-1",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown cover gallery preset" });
  });
});
