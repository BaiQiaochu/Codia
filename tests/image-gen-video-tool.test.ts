// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

let execute, name, promptSnippet, promptGuidelines;
let tempDirs = [];

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../plugins/image-gen/tools/generate-video.js");
  execute = mod.execute;
  name = mod.name;
  promptSnippet = mod.promptSnippet;
  promptGuidelines = mod.promptGuidelines;
});

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeTempDataDir(config = null, agentId = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-video-tool-"));
  tempDirs.push(dir);
  if (config) {
    const configPath = agentId
      ? path.join(dir, "agents", agentId, "config.json")
      : path.join(dir, "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
  }
  return dir;
}

function makeAdapter(overrides = {}) {
  return {
    id: "volcengine-video",
    types: ["video"],
    submit: vi.fn(async () => ({ taskId: "video-task-1" })),
    ...overrides,
  };
}

function makeMediaGen(adapter = makeAdapter()) {
  const registry = {
    get: vi.fn((id) => (id === adapter.id ? adapter : undefined)),
    getByType: vi.fn(() => [adapter]),
  };
  const store = { add: vi.fn(), update: vi.fn() };
  const poller = { add: vi.fn() };
  return { registry, store, poller, adapter };
}

function makeCtx(mediaGen, dataDir = makeTempDataDir(), agentId = null) {
  return {
    _mediaGen: mediaGen,
    dataDir,
    agentId,
    sessionPath: "/sessions/main.jsonl",
    bus: { request: vi.fn(async () => ({})) },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
}

describe("generate-video tool", () => {
  it("tells the model to call the provider video tool for natural video generation requests", () => {
    expect(name).toBe("generate-video");
    expect(promptSnippet).toContain("image-gen_generate-video");
    expect(promptSnippet).toMatch(/without requiring a slash command/i);
    expect(promptGuidelines).toContain("short video");
    expect(promptGuidelines).not.toMatch(/video-gen_.*render/);
  });

  it("returns an initialization error when media generation is unavailable", async () => {
    const result = await execute({ prompt: "rain" }, makeCtx(null));
    expect(result.content[0].text).toContain("视频生成插件未初始化");
    expect(result.details.error).toMatchObject({
      code: "not_initialized",
      mediaType: "video",
    });
  });

  it("uses the configured default video model and Volcengine video adapter", async () => {
    const mediaGen = makeMediaGen();
    const dataDir = makeTempDataDir({
      defaultVideoModel: { provider: "volcengine", id: "seedance-default" },
    });
    const ctx = makeCtx(mediaGen, dataDir);

    const result = await execute({ prompt: "a calm sea", ratio: "16:9" }, ctx);

    expect(mediaGen.registry.get).toHaveBeenCalledWith("volcengine");
    expect(mediaGen.registry.get).toHaveBeenCalledWith("volcengine-video");
    expect(mediaGen.adapter.submit).toHaveBeenCalledOnce();
    const [params] = mediaGen.adapter.submit.mock.calls[0];
    expect(params).toMatchObject({
      type: "video",
      prompt: "a calm sea",
      provider: "volcengine",
      providerId: "volcengine",
      model: "seedance-default",
      ratio: "16:9",
      aspect_ratio: "16:9",
    });
    expect(result.details.card.title).toBe("视频生成");
    expect(result.details.card.route).toMatch(/^\/video-card\?batch=/);
  });

  it("maps explicit volcengine-coding requests to the Volcengine video adapter", async () => {
    const mediaGen = makeMediaGen();
    const ctx = makeCtx(mediaGen);

    await execute({ prompt: "coding video", provider: "volcengine-coding", model: "seedance-coding" }, ctx);

    const [params] = mediaGen.adapter.submit.mock.calls[0];
    expect(params.provider).toBe("volcengine-coding");
    expect(params.providerId).toBe("volcengine-coding");
    expect(params.model).toBe("seedance-coding");
  });

  it("marks bridge-originated video tasks for bridge delivery", async () => {
    const mediaGen = makeMediaGen();
    const dataDir = makeTempDataDir({
      defaultVideoModel: { provider: "volcengine", id: "seedance-default" },
    });
    const ctx = {
      ...makeCtx(mediaGen, dataDir),
      bridgeContext: {
        isBridgeSession: true,
        platform: "wechat",
        chatId: "wx-user",
        sessionKey: "wx_dm_wx-user@codia",
      },
    };

    await execute({ prompt: "bridge video" }, ctx);

    const deferredCall = ctx.bus.request.mock.calls.find(([type]) => type === "deferred:register");
    expect(deferredCall[1].meta.deliveryTarget).toEqual({
      kind: "bridge",
      platform: "wechat",
      chatId: "wx-user",
      sessionKey: "wx_dm_wx-user@codia",
    });
    expect(mediaGen.store.add.mock.calls[0][0].deliveryTarget).toEqual(deferredCall[1].meta.deliveryTarget);
  });

  it("uses the OpenAI-compatible media adapter for a configured third-party video model", async () => {
    const adapter = makeAdapter({
      id: "openai-compatible-media",
      types: ["audio", "music", "video"],
      submit: vi.fn(async () => ({ taskId: "video-task-1" })),
    });
    const mediaGen = makeMediaGen(adapter);
    mediaGen.registry.get.mockImplementation((id) => (id === adapter.id ? adapter : null));
    mediaGen.registry.getByType.mockReturnValue([]);
    const dataDir = makeTempDataDir({
      defaultVideoModel: { provider: "custom-video", id: "motion-plus" },
    });
    const ctx = makeCtx(mediaGen, dataDir);
    ctx.bus.request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "custom-video") {
        return { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://video.example.test/v1" };
      }
      return {};
    });

    await execute({ prompt: "a calm sea", ratio: "16:9" }, ctx);

    expect(mediaGen.registry.get).toHaveBeenCalledWith("custom-video");
    expect(mediaGen.registry.get).toHaveBeenCalledWith("openai-compatible-media");
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.submit.mock.calls[0][0]).toMatchObject({
      type: "video",
      prompt: "a calm sea",
      provider: "custom-video",
      providerId: "custom-video",
      model: "motion-plus",
      ratio: "16:9",
      aspect_ratio: "16:9",
    });
  });

  it("routes ToAPIs-like base URLs to the generic OpenAI-compatible media adapter", async () => {
    const toapisAdapter = makeAdapter({
      id: "toapis-video",
      types: ["video"],
      submit: vi.fn(async () => ({ taskId: "video-task-1" })),
    });
    const genericAdapter = makeAdapter({
      id: "openai-compatible-media",
      types: ["audio", "music", "video"],
    });
    const mediaGen = {
      registry: {
        get: vi.fn((id) => {
          if (id === "toapis-video") return toapisAdapter;
          if (id === "openai-compatible-media") return genericAdapter;
          return null;
        }),
        getByType: vi.fn(() => []),
      },
      store: { add: vi.fn(), update: vi.fn() },
      poller: { add: vi.fn() },
    };
    const dataDir = makeTempDataDir({
      defaultVideoModel: { provider: "custom-toapis", id: "wan2.6-flash" },
    });
    const ctx = makeCtx(mediaGen, dataDir);
    ctx.bus.request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "custom-toapis") {
        return { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://toapis.com/v1" };
      }
      return {};
    });

    await execute({
      prompt: "a cinematic product shot",
      provider: "custom-toapis",
      ratio: "16:9",
      resolution: "1080p",
      action: "image-to-video",
      audio: true,
      negative_prompt: "low quality",
      shot_type: "single",
      reference_urls: ["https://cdn.example.test/ref.mp4"],
    }, ctx);

    expect(genericAdapter.submit).toHaveBeenCalledOnce();
    expect(toapisAdapter.submit).not.toHaveBeenCalled();
    expect(genericAdapter.submit.mock.calls[0][0]).toMatchObject({
      provider: "custom-toapis",
      providerId: "custom-toapis",
      model: "wan2.6-flash",
      ratio: "16:9",
      aspect_ratio: "16:9",
      resolution: "1080p",
      action: "image-to-video",
      audio: true,
      negative_prompt: "low quality",
      shot_type: "single",
      reference_urls: ["https://cdn.example.test/ref.mp4"],
    });
  });

  it("preserves ordered reference images while removing duplicates", async () => {
    const mediaGen = makeMediaGen();
    const dataDir = makeTempDataDir({
      defaultVideoModel: { provider: "volcengine", id: "seedance-default" },
    });
    const ctx = makeCtx(mediaGen, dataDir);

    await execute({
      prompt: "animate references",
      images: [" /tmp/a.png ", "/tmp/b.png"],
      image: "/tmp/a.png",
      generate_audio: true,
      watermark: true,
      duration: 10,
    }, ctx);

    const [params] = mediaGen.adapter.submit.mock.calls[0];
    expect(params.images).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    expect(params).not.toHaveProperty("image");
    expect(params.generateAudio).toBe(true);
    expect(params.generate_audio).toBe(true);
    expect(params.watermark).toBe(true);
    expect(params.duration).toBe(10);
  });

  it("applies selected video model schema and rejects invalid parameter values", async () => {
    const mediaGen = makeMediaGen();
    const ctx = makeCtx(mediaGen);
    ctx.bus.request = vi.fn(async (type) => {
      if (type === "provider:media-providers") {
        return {
          providers: {
            volcengine: {
              providerId: "volcengine",
              hasCredentials: true,
              models: [{
                id: "seedance-default",
                protocolId: "volcengine-video",
                modes: [{
                  id: "text2video",
                  defaults: { duration: 5 },
                  parameterSchema: {
                    type: "object",
                    properties: {
                      duration: { type: "number", minimum: 1, maximum: 10 },
                      video_resolution: { type: "string", enum: ["720p", "1080p"] },
                    },
                  },
                }],
              }],
            },
          },
        };
      }
      return {};
    });

    await execute({
      prompt: "a calm sea",
      provider: "volcengine",
      model: "seedance-default",
      resolution: "1080p",
    }, ctx);

    const [params] = mediaGen.adapter.submit.mock.calls[0];
    expect(params.mode).toBe("text2video");
    expect(params.resolvedParameters).toMatchObject({
      duration: 5,
      video_resolution: "1080p",
    });

    const invalid = await execute({
      prompt: "a calm sea",
      provider: "volcengine",
      model: "seedance-default",
      resolution: "4k",
    }, ctx);

    expect(invalid.details.error).toMatchObject({
      code: "invalid_parameters",
      mediaType: "video",
    });
    expect(mediaGen.adapter.submit).toHaveBeenCalledTimes(1);
  });

  it("classifies missing video model separately from provider failures", async () => {
    const registry = {
      get: vi.fn(() => null),
      getByType: vi.fn(() => []),
    };
    const ctx = makeCtx({ registry, store: { add: vi.fn(), update: vi.fn() }, poller: { add: vi.fn() } });

    const result = await execute({ prompt: "a calm sea" }, ctx);

    expect(result.details.error).toMatchObject({
      code: "missing_model",
      mediaType: "video",
    });
    expect(result.content[0].text).toContain("没有可用的视频生成供应商");
  });

  it("classifies missing provider credentials before submitting a video task", async () => {
    const adapter = makeAdapter({
      checkAuth: vi.fn(async () => ({ ok: false, message: 'Provider "volcengine" has no API key configured.' })),
    });
    const mediaGen = makeMediaGen(adapter);
    const dataDir = makeTempDataDir({
      defaultVideoModel: { provider: "volcengine", id: "seedance-default" },
    });
    const ctx = makeCtx(mediaGen, dataDir);

    const result = await execute({ prompt: "a calm sea" }, ctx);

    expect(adapter.submit).not.toHaveBeenCalled();
    expect(result.details.error).toMatchObject({
      code: "missing_credentials",
      mediaType: "video",
    });
  });

  it("classifies provider preflight failures before submitting a video task", async () => {
    const adapter = makeAdapter({
      checkAuth: vi.fn(async () => ({ ok: false, message: "Volcengine video API error 403: forbidden" })),
    });
    const mediaGen = makeMediaGen(adapter);
    const dataDir = makeTempDataDir({
      defaultVideoModel: { provider: "volcengine", id: "seedance-default" },
    });
    const ctx = makeCtx(mediaGen, dataDir);

    const result = await execute({ prompt: "a calm sea" }, ctx);

    expect(adapter.submit).not.toHaveBeenCalled();
    expect(result.details.error).toMatchObject({
      code: "provider_failure",
      mediaType: "video",
    });
  });

  it("classifies missing video task ids as task failures", async () => {
    const mediaGen = makeMediaGen(makeAdapter({
      submit: vi.fn(async () => ({})),
    }));
    const dataDir = makeTempDataDir({
      defaultVideoModel: { provider: "volcengine", id: "seedance-default" },
    });
    const ctx = makeCtx(mediaGen, dataDir);

    const result = await execute({ prompt: "a calm sea" }, ctx);

    expect(result.details.error).toMatchObject({
      code: "task_failed",
      mediaType: "video",
    });
  });
});

describe("generate-video direct route", () => {
  it("submits OpenAI-compatible video tasks without relying on a chat model tool call", async () => {
    const routeMod = await import("../plugins/image-gen/routes/generate-video.js");
    const adapter = makeAdapter({
      id: "openai-compatible-media",
      types: ["audio", "music", "video"],
      submit: vi.fn(async () => ({ taskId: "video-task-1" })),
    });
    const mediaGen = makeMediaGen(adapter);
    const app = new Hono();
    const ctx = makeCtx(mediaGen);
    ctx.bus.request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "custom-video") {
        return { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://video.example.test/v1" };
      }
      return {};
    });
    routeMod.default(app, { ...ctx, pluginId: "image-gen" });

    const res = await app.request("/generate-video", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-codia-Session-Path": ctx.sessionPath,
      },
      body: JSON.stringify({
        prompt: "a starship leaving a nebula",
        provider: "custom-video",
        model: "motion-plus",
        aspect_ratio: "16:9",
        audio: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(adapter.submit.mock.calls[0][0]).toMatchObject({
      prompt: "a starship leaving a nebula",
      provider: "custom-video",
      providerId: "custom-video",
      model: "motion-plus",
      aspect_ratio: "16:9",
      audio: true,
    });
    expect(body.details.card).toMatchObject({
      pluginId: "image-gen",
      type: "iframe",
      title: "视频生成",
    });
  });

  it("rejects empty direct video prompts before invoking the adapter", async () => {
    const routeMod = await import("../plugins/image-gen/routes/generate-video.js");
    const adapter = makeAdapter();
    const mediaGen = makeMediaGen(adapter);
    const app = new Hono();
    routeMod.default(app, makeCtx(mediaGen));

    const res = await app.request("/generate-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   ", provider: "custom-video", model: "motion-plus" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "prompt is required" });
    expect(adapter.submit).not.toHaveBeenCalled();
  });
});
