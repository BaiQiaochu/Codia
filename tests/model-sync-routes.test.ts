// @ts-nocheck
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clearConfigCache = vi.fn();

vi.mock("../lib/memory/config-loader.js", () => ({
  clearConfigCache,
  getRawConfig: () => ({}),
}));

/** 从 providerRegistry.getCredentials 构造 engine.resolveProviderCredentials（与 ModelManager 行为一致） */
function withResolveCreds(engine) {
  engine.resolveProviderCredentials = (provider) => {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    const cred = engine.providerRegistry?.getCredentials?.(provider);
    if (cred) return { api_key: cred.apiKey || "", base_url: cred.baseUrl || "", api: cred.api || "" };
    return { api_key: "", base_url: "", api: "" };
  };
  return engine;
}

describe("model sync related routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("provider-only config updates trigger model registry sync", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const saveProvider = vi.fn();
    const reload = vi.fn();
    const engine = {
      config: {},
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      providerRegistry: { saveProvider, removeProvider: vi.fn(), reload },
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          dashscope: {
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            api: "openai-completions",
            api_key: "sk-test",
            models: ["qwen-plus"],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledTimes(1);
    expect(saveProvider).toHaveBeenCalledWith("dashscope", {
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      api: "openai-completions",
      api_key: "sk-test",
      models: ["qwen-plus"],
    });
    expect(clearConfigCache).toHaveBeenCalledTimes(1);
    expect(engine.updateConfig).toHaveBeenCalledWith({});
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
  });

  it("editor typography config updates emit an app event", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const editor = { markdown: { bodyFontSize: 17 } };
    const engine = {
      config: {},
      setEditor: vi.fn(),
      getEditor: vi.fn(() => editor),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      providerRegistry: { saveProvider: vi.fn(), removeProvider: vi.fn(), getAllProvidersRaw: vi.fn(() => ({})), get: vi.fn() },
      emitEvent: vi.fn(),
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editor }),
    });

    expect(res.status).toBe(200);
    expect(engine.emitEvent).toHaveBeenCalledWith(
      {
        type: "app_event",
        event: {
          type: "editor-typography-changed",
          payload: { editor },
          source: "server",
        },
      },
      null,
    );
  });

  it("shared model preference updates trigger model registry sync", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          utility: "test-model",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.setSharedModels).toHaveBeenCalledWith({ utility: "test-model" });
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("PWA sessions cannot mutate model-related global config fields", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const engine = {
      config: {},
      setLocale: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      providerRegistry: { saveProvider: vi.fn(), removeProvider: vi.fn(), getAllProvidersRaw: vi.fn(() => ({})), get: vi.fn() },
    };
    const route = new Hono();
    route.use("*", async (c, next) => {
      c.set("pwaSession", { userId: "BoshiPOC" });
      await next();
    });
    route.route("/api", createConfigRoute(engine));
    app.route("", route);

    const blocked = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: { chat: { id: "gpt-4o", provider: "openai" } } }),
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "pwa_model_locked" });

    const allowed = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "zh-CN" }),
    });
    expect(allowed.status).toBe(200);
  });

  it("shared model preference update returns 400 for malformed JSON", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn(),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
    expect(engine.setSharedModels).not.toHaveBeenCalled();
    expect(engine.syncModelsAndRefresh).not.toHaveBeenCalled();
  });

  it("shared vision model preference accepts models marked with vision flag", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      resolveModelWithCredentials: vi.fn(() => ({
        model: { id: "vision-model", provider: "test-provider", vision: true },
      })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          vision: { id: "vision-model", provider: "test-provider" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.resolveModelWithCredentials).toHaveBeenCalledWith({ id: "vision-model", provider: "test-provider" });
    expect(engine.setSharedModels).toHaveBeenCalledWith({ vision: { id: "vision-model", provider: "test-provider" } });
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("shared vision model preference can be cleared", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({ vision: { id: "vision-model", provider: "test-provider" } })),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      resolveModelWithCredentials: vi.fn(),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          vision: null,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.resolveModelWithCredentials).not.toHaveBeenCalled();
    expect(engine.setSharedModels).toHaveBeenCalledWith({ vision: null });
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("shared vision model preference accepts image support from availableModels when resolved metadata is stale", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();
    const engine = {
      availableModels: [
        { id: "vision-model", provider: "test-provider", input: ["text", "image"] },
      ],
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      resolveModelWithCredentials: vi.fn(() => ({
        model: { id: "vision-model", provider: "test-provider", input: ["text"] },
      })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          vision: { id: "vision-model", provider: "test-provider" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.setSharedModels).toHaveBeenCalledWith({ vision: { id: "vision-model", provider: "test-provider" } });
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("shared vision model preference accepts image support from raw provider config", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();
    const engine = {
      availableModels: [],
      providerRegistry: {
        getAllProvidersRaw: vi.fn(() => ({
          "test-provider": {
            models: [
              { id: "vision-model", image: true },
            ],
          },
        })),
      },
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      resolveModelWithCredentials: vi.fn(() => ({
        model: { id: "vision-model", provider: "test-provider", input: ["text"] },
      })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          vision: { id: "vision-model", provider: "test-provider" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.providerRegistry.getAllProvidersRaw).toHaveBeenCalledTimes(1);
    expect(engine.setSharedModels).toHaveBeenCalledWith({ vision: { id: "vision-model", provider: "test-provider" } });
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("shared vision model preference still rejects text-only models", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      resolveModelWithCredentials: vi.fn(() => ({
        model: { id: "text-model", provider: "test-provider", input: ["text"], vision: false },
      })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          vision: { id: "text-model", provider: "test-provider" },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "vision model must support image input" });
    expect(engine.setSharedModels).not.toHaveBeenCalled();
    expect(engine.syncModelsAndRefresh).not.toHaveBeenCalled();
  });

  it("inline 凭证缺少显式 provider 时返回 400", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      getHomeFolder: vi.fn(() => null),
      getThinkingLevel: vi.fn(() => "medium"),
      getSandbox: vi.fn(() => "workspace-write"),
      getLocale: vi.fn(() => "zh-CN"),
      getTimezone: vi.fn(() => "Asia/Shanghai"),
      getLearnSkills: vi.fn(() => false),
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: {
          api_key: "sk-test",
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("api.provider is required");
  });

  it("inline 空 api_key 也会同步到 provider 配置，用于真正清空凭证", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const saveProvider = vi.fn();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      providerRegistry: {
        saveProvider,
        removeProvider: vi.fn(),
      },
      getHomeFolder: vi.fn(() => null),
      getThinkingLevel: vi.fn(() => "medium"),
      getSandbox: vi.fn(() => "workspace-write"),
      getLocale: vi.fn(() => "zh-CN"),
      getTimezone: vi.fn(() => "Asia/Shanghai"),
      getLearnSkills: vi.fn(() => false),
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: {
          provider: "openai",
          api_key: "",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("openai", { api_key: "" });
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
  });

  it("model routes expose stable ids and readable display names", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      availableModels: [
        {
          id: "gpt-5.4",
          name: "Gpt 5.4",
          provider: "openai-codex",
          input: ["text", "image"],
          reasoning: true,
        },
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          input: ["text"],
          reasoning: true,
        },
        {
          id: "gpt-image-1",
          name: "GPT Image 1",
          provider: "openai",
          type: "image",
        },
      ],
      currentModel: { id: "gpt-5.4", name: "Gpt 5.4" },
      config: {},
      providerRegistry: { get: () => ({}) },
    };

    app.route("/api", createModelsRoute(engine));

    const allRes = await app.request("/api/models");
    const allData = await allRes.json();
    expect(allRes.status).toBe(200);
    expect(allData.models[0].id).toBe("gpt-5.4");
    expect(allData.models[0].name).toBe("Gpt 5.4");
    expect(allData.models[0].input).toEqual(["text", "image"]);
    expect(allData.models[0].image).toBe(true);
    expect(allData.models[0].vision).toBe(true);
    expect(allData.models.find(m => m.id === "gpt-5.5")?.xhigh).toBe(true);
    expect(allData.models.map(m => m.id)).not.toContain("gpt-image-1");
  });

  it("model routes expose image-capable models for the vision settings picker", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      availableModels: [
        { id: "gpt-4o", name: "GPT-4o", provider: "openai", input: ["text", "image"] },
        { id: "text-only", name: "Text Only", provider: "openai", input: ["text"] },
        { id: "custom-vision", name: "Custom Vision", provider: "custom", type: "image", input: ["text", "image"] },
        { id: "gpt-image-1", name: "GPT Image 1", provider: "openai", type: "image" },
      ],
      currentModel: { id: "text-only", provider: "openai" },
      config: {},
    };

    app.route("/api", createModelsRoute(engine));

    const defaultRes = await app.request("/api/models");
    const defaultData = await defaultRes.json();
    expect(defaultData.models.map(m => m.id)).toEqual(["gpt-4o", "text-only"]);

    const visionRes = await app.request("/api/models?include=vision");
    const visionData = await visionRes.json();
    expect(visionRes.status).toBe(200);
    expect(visionData.models.map(m => m.id)).toEqual(["gpt-4o", "custom-vision"]);
    expect(visionData.models.find(m => m.id === "custom-vision")).toMatchObject({
      provider: "custom",
      image: true,
      vision: true,
    });
    expect(visionData.models.map(m => m.id)).not.toContain("gpt-image-1");
  });

  it("model routes keep known vision models selectable when runtime metadata is missing image input", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      availableModels: [
        { id: "gpt-4o", name: "GPT-4o", provider: "openai", input: ["text"] },
        { id: "text-only", name: "Text Only", provider: "openai", input: ["text"] },
      ],
      currentModel: { id: "text-only", provider: "openai" },
      config: {},
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models?include=vision");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.models.map(m => m.id)).toEqual(["gpt-4o"]);
    expect(data.models[0]).toMatchObject({
      id: "gpt-4o",
      provider: "openai",
      image: true,
      vision: true,
      input: ["text", "image"],
    });
  });

  it("model routes expose known MiniMax M2.7 models as image-capable", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      availableModels: [
        { id: "MiniMax-M2.7", name: "MiniMax M2.7", provider: "minimax", input: ["text"] },
        { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", provider: "minimax", input: ["text"] },
      ],
      currentModel: { id: "MiniMax-M2.7", provider: "minimax" },
      config: {},
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.models).toEqual([
      expect.objectContaining({
        id: "MiniMax-M2.7",
        provider: "minimax",
        image: true,
        vision: true,
        input: ["text", "image"],
      }),
      expect.objectContaining({
        id: "MiniMax-M2.7-highspeed",
        provider: "minimax",
        image: true,
        vision: true,
        input: ["text", "image"],
      }),
    ]);
  });

  it("model routes do not expose known MiniMax text-only models as image-capable", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      availableModels: [
        {
          id: "MiniMax-M2.5",
          name: "MiniMax M2.5",
          provider: "minimax",
          input: ["text", "image"],
          vision: true,
          compat: { supportsImageInput: true },
        },
        { id: "MiniMax-M2.7", name: "MiniMax M2.7", provider: "minimax", input: ["text"] },
      ],
      currentModel: { id: "MiniMax-M2.5", provider: "minimax" },
      config: {},
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models?include=vision");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.models.map(m => m.id)).toEqual(["MiniMax-M2.7"]);
    expect(data.models[0]).toMatchObject({
      id: "MiniMax-M2.7",
      provider: "minimax",
      input: ["text", "image"],
      image: true,
      vision: true,
    });
  });

  it("POST /api/models/switch rejects non-chat models before switching sessions", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      config: {},
      availableModels: [
        { id: "gpt-image-1", provider: "openai", type: "image" },
      ],
      isSessionStreaming: vi.fn(() => false),
      switchSessionModel: vi.fn(),
      getSessionByPath: vi.fn(),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionPath: "/sessions/demo.jsonl",
        modelId: "gpt-image-1",
        provider: "openai",
      }),
    });

    expect(res.status).toBe(400);
    expect(engine.switchSessionModel).not.toHaveBeenCalled();
    expect((await res.json()).error).toContain("not a chat model");
  });

  it("GET /api/models only exposes the fixed current model for PWA sessions", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      config: {},
      currentModel: { id: "gpt-4o", name: "GPT-4o", provider: "openai", type: "chat", input: ["text", "image"] },
      activeSessionModel: { id: "gpt-4o", provider: "openai" },
      availableModels: [
        { id: "gpt-4o", name: "GPT-4o", provider: "openai", type: "chat", input: ["text", "image"] },
        { id: "qwen-plus", name: "Qwen Plus", provider: "dashscope", type: "chat", input: ["text"] },
      ],
    };

    const route = new Hono();
    route.use("*", async (c, next) => {
      c.set("pwaSession", { userId: "BoshiPOC" });
      await next();
    });
    route.route("/api", createModelsRoute(engine));
    app.route("", route);

    const res = await app.request("/api/models");
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.models).toHaveLength(1);
    expect(data.models[0]).toMatchObject({ id: "gpt-4o", provider: "openai", isCurrent: true });
  });

  it("POST /api/models/switch switches the target session model and returns normalized model info", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const switchSessionModel = vi.fn().mockResolvedValue({ adaptations: ["compacted"] });
    const getSessionByPath = vi.fn().mockReturnValue({
      model: {
        id: "gpt-4o",
        name: "GPT-4o SDK",
        provider: "openai",
        input: ["text", "image", "video"],
        video: false,
        reasoning: true,
        thinkingLevels: ["off", "medium", "high"],
        defaultThinkingLevel: "medium",
        contextWindow: 128000,
      },
    });
    const engine = {
      config: {
        models: {
          overrides: {
            "gpt-4o": {
              displayName: "GPT-4o Vision",
            },
          },
        },
      },
      availableModels: [
        { id: "gpt-4o", provider: "openai", type: "chat" },
      ],
      isSessionStreaming: vi.fn(() => false),
      switchSessionModel,
      getSessionByPath,
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionPath: "/sessions/demo.jsonl",
        modelId: "gpt-4o",
        provider: "openai",
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.isSessionStreaming).toHaveBeenCalledWith("/sessions/demo.jsonl");
    expect(switchSessionModel).toHaveBeenCalledWith("/sessions/demo.jsonl", "gpt-4o", "openai");
    expect(getSessionByPath).toHaveBeenCalledWith("/sessions/demo.jsonl");

    const data = await res.json();
    expect(data).toEqual({
      ok: true,
      model: {
        id: "gpt-4o",
        name: "GPT-4o Vision",
        provider: "openai",
        input: ["text", "image"],
        video: false,
        reasoning: true,
        thinkingLevels: ["off", "medium", "high"],
        defaultThinkingLevel: "medium",
        contextWindow: 128000,
      },
      adaptations: ["compacted"],
    });
  });

  it("POST /api/models/switch accepts stable sessionId without exposing jsonl paths", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const switchSessionModel = vi.fn().mockResolvedValue({ adaptations: [] });
    const getSessionByPath = vi.fn().mockReturnValue({
      model: {
        id: "qwen-plus",
        provider: "dashscope",
        input: ["text"],
      },
    });
    const engine = {
      config: {},
      availableModels: [
        { id: "qwen-plus", provider: "dashscope", type: "chat" },
      ],
      listSessions: vi.fn(async () => [
        { id: "demo", path: "/sessions/demo.jsonl" },
      ]),
      isSessionStreaming: vi.fn(() => false),
      switchSessionModel,
      getSessionByPath,
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "demo",
        modelId: "qwen-plus",
        provider: "dashscope",
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.listSessions).toHaveBeenCalledTimes(1);
    expect(engine.isSessionStreaming).toHaveBeenCalledWith("/sessions/demo.jsonl");
    expect(switchSessionModel).toHaveBeenCalledWith("/sessions/demo.jsonl", "qwen-plus", "dashscope");
    expect(getSessionByPath).toHaveBeenCalledWith("/sessions/demo.jsonl");
  });

  it("POST /api/models/switch returns 404 for unknown sessionId", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      config: {},
      listSessions: vi.fn(async () => []),
      isSessionStreaming: vi.fn(),
      switchSessionModel: vi.fn(),
      getSessionByPath: vi.fn(),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "missing",
        modelId: "qwen-plus",
        provider: "dashscope",
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
    expect(engine.isSessionStreaming).not.toHaveBeenCalled();
    expect(engine.switchSessionModel).not.toHaveBeenCalled();
  });

  it("POST /api/models/switch returns 409 while the session is streaming", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      config: {},
      isSessionStreaming: vi.fn(() => true),
      switchSessionModel: vi.fn(),
      getSessionByPath: vi.fn(),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionPath: "/sessions/streaming.jsonl",
        modelId: "gpt-4o",
        provider: "openai",
      }),
    });

    expect(res.status).toBe(409);
    expect(engine.switchSessionModel).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ error: "cannot switch model while streaming" });
  });

  it("POST /api/models/switch validates required params before calling engine", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      config: {},
      isSessionStreaming: vi.fn(),
      switchSessionModel: vi.fn(),
      getSessionByPath: vi.fn(),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelId: "gpt-4o",
        provider: "openai",
      }),
    });

    expect(res.status).toBe(400);
    expect(engine.isSessionStreaming).not.toHaveBeenCalled();
    expect(engine.switchSessionModel).not.toHaveBeenCalled();

    const data = await res.json();
    expect(typeof data.error).toBe("string");
    expect(data.error.length).toBeGreaterThan(0);
  });

  it("POST /api/models/switch returns 400 for malformed JSON", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      config: {},
      isSessionStreaming: vi.fn(),
      switchSessionModel: vi.fn(),
      getSessionByPath: vi.fn(),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
    expect(engine.isSessionStreaming).not.toHaveBeenCalled();
    expect(engine.switchSessionModel).not.toHaveBeenCalled();
  });

  it("oauth provider with empty baseUrl falls back to registry", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          provider: "openai-codex",
          contextWindow: 272000,
          maxOutputTokens: 128000,
        },
      ]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "openai-codex-responses" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex" }),
    });

    expect(res.status).toBe(200);
    expect(engine.getRegistryModelsForProvider).toHaveBeenCalledWith("openai-codex");
    const data = await res.json();
    expect(data.source).toBe("registry");
    expect(data.models[0].id).toBe("gpt-5.4");
    expect(data.models[0].type).toBe("chat");
  });

  it("oauth provider with empty registry falls back to defaults", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "openai-codex-responses" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "openai-codex" ? ["gpt-5.4", "gpt-5.3-codex"] : [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toContain("gpt-5.4");
    expect(data.models.every(m => m.type === "chat")).toBe(true);
  });

  it("uncredentialed api-key providers use registry defaults instead of probing remote catalogs", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "https://api.openai.com/v1", api: "openai-completions" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "openai" ? ["gpt-5.5", "gpt-5.4"] : [],
        allowsMissingApiKey: () => false,
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toEqual(["gpt-5.5", "gpt-5.4"]);
  });

  it("provider with explicit api_key uses remote catalog", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "MiniMax-M2.5", context_length: 1000000, max_output_tokens: 80000 },
          { id: "MiniMax-M2", context_length: 1000000, max_output_tokens: 80000 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "minimax",
        base_url: "https://api.minimaxi.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.models).toHaveLength(2);
    expect(data.models[0].id).toBe("MiniMax-M2.5");
    expect(data.models[0].type).toBe("chat");
  });

  it("video model discovery for OpenAI-compatible gateways uses the remote catalog", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5.5", type: "chat" },
          { id: "motion-plus", type: "video" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "video-gateway",
        base_url: "https://toapis.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        model_type: "video",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://toapis.com/v1/models");
    const data = await res.json();
    expect(data.models).toEqual([
      expect.objectContaining({ id: "motion-plus", type: "video" }),
    ]);
  });

  it("offers GPT Image candidates when an OpenAI-compatible catalog omits image models", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-6.1-sol", type: "chat" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "custom-openai-gateway",
        base_url: "https://gateway.example.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        model_type: "image",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-image-1", type: "image" }),
      expect.objectContaining({ id: "gpt-image-2.5-sunburst", type: "image" }),
      expect.objectContaining({ id: "gpt-image-2.5-flare", type: "image" }),
      expect.objectContaining({ id: "chatgpt-image-latest", type: "image" }),
    ]));
    expect(data.models.some((model) => model.id === "gpt-6.1-sol")).toBe(false);
  });

  it("keeps GPT Image candidates visible in an all-model scan for image-capable gateways", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-6.1-sol", type: "chat" },
          { id: "grok-imagine-image", type: "image" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "image-capable-gateway",
        base_url: "https://gateway.example.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-6.1-sol", type: "chat" }),
      expect.objectContaining({ id: "grok-imagine-image", type: "image" }),
      expect.objectContaining({ id: "gpt-image-2.5-sunburst", type: "image" }),
      expect.objectContaining({ id: "chatgpt-image-latest", type: "image" }),
    ]));
  });

  it("ToAPIs-compatible gateways use the remote catalog when no media type is requested", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-5.5", type: "chat" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "video-gateway",
        base_url: "https://toapis.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://toapis.com/v1/models");
    const data = await res.json();
    expect(data.models).toEqual([
      expect.objectContaining({ id: "gpt-5.5", type: "chat" }),
    ]);
  });

  it("OpenAI-compatible yh.m7ai gateways keep remote discovery and custom headers for all-model scans", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-5.5", type: "chat" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "imges2",
        base_url: "https://yh.m7ai.com/v1",
        api: "openai-completions",
        headers: {
          Authorization: "Bearer token",
          "X-Corp-Auth": "secret",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://yh.m7ai.com/v1/models");
    expect(init.headers.Authorization).toBe("Bearer token");
    expect(init.headers["X-Corp-Auth"]).toBe("secret");
    const data = await res.json();
    expect(data.models).toEqual([
      expect.objectContaining({ id: "gpt-5.5", type: "chat" }),
    ]);
  });

  it("remote model discovery accepts custom gateway models arrays", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          "gpt-4o",
          { name: "qwen-plus", context_length: 131072, max_output_tokens: 8192 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "custom-gateway",
        base_url: "https://gateway.example.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models).toEqual([
      expect.objectContaining({ id: "gpt-4o", type: "chat" }),
      expect.objectContaining({ id: "qwen-plus", type: "chat", context: 131072, maxOutput: 8192 }),
    ]);
  });

  it("remote model discovery accepts custom gateway object maps", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          "deepseek-chat": { context_window: 64000 },
          "gpt-image-1": { type: "image" },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "custom-gateway",
        base_url: "https://gateway.example.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models).toEqual([
      expect.objectContaining({ id: "deepseek-chat", type: "chat", context: 64000 }),
      expect.objectContaining({ id: "gpt-image-1", type: "image" }),
    ]);
  });

  it("remote model discovery accepts pasted OpenAI chat completion endpoints", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4o" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "custom-gateway",
        base_url: "https://gateway.example.com/v1/chat/completions",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.example.com/v1/models");
    const data = await res.json();
    expect(data.models[0]).toMatchObject({ id: "gpt-4o", type: "chat" });
  });

  it("remote model discovery preserves non-chat model types", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-4o", context_length: 128000, max_output_tokens: 16384 },
          { id: "gpt-image-1" },
          { id: "tts-1" },
          { id: "music-01" },
          { id: "doubao-seedance-2-0-260128" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "openai",
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Object.fromEntries(data.models.map(m => [m.id, m.type]))).toEqual({
      "gpt-4o": "chat",
      "gpt-image-1": "image",
      "tts-1": "audio",
      "music-01": "music",
      "doubao-seedance-2-0-260128": "video",
    });
  });

  it("remote model discovery keeps chat-capable full-modal models switchable", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-4o-audio-preview", type: "audio" },
          { id: "gpt-audio", type: "audio" },
          { id: "gemini-2.5-flash-native-audio-preview-12-2025" },
          { id: "qwen3.5-omni-plus" },
          { id: "mimo-v2-omni" },
          { id: "tts-1" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "omni-test",
        base_url: "https://api.example.com/v1",
        api: "openai-completions",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Object.fromEntries(data.models.map(m => [m.id, m.type]))).toEqual({
      "gpt-4o-audio-preview": "chat",
      "gpt-audio": "chat",
      "gemini-2.5-flash-native-audio-preview-12-2025": "chat",
      "qwen3.5-omni-plus": "chat",
      "mimo-v2-omni": "chat",
      "tts-1": "audio",
    });
  });

  it("model routes keep cached full-modal models in the chat switcher", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const switchSessionModel = vi.fn().mockResolvedValue({ adaptations: [] });
    const getSessionByPath = vi.fn().mockReturnValue({
      model: {
        id: "gpt-audio",
        name: "GPT Audio",
        provider: "openai",
        input: ["text", "audio"],
      },
    });
    const engine = {
      config: {},
      currentModel: { id: "gpt-audio", provider: "openai" },
      availableModels: [
        { id: "gpt-audio", name: "GPT Audio", provider: "openai", type: "audio", input: ["text", "audio"] },
        { id: "tts-1", provider: "openai", type: "audio" },
      ],
      isSessionStreaming: vi.fn(() => false),
      switchSessionModel,
      getSessionByPath,
    };

    app.route("/api", createModelsRoute(engine));

    const allRes = await app.request("/api/models");
    expect(allRes.status).toBe(200);
    const allData = await allRes.json();
    expect(allData.models.map(m => m.id)).toEqual(["gpt-audio"]);

    const switchRes = await app.request("/api/models/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionPath: "/sessions/demo.jsonl",
        modelId: "gpt-audio",
        provider: "openai",
      }),
    });

    expect(switchRes.status).toBe(200);
    expect(switchSessionModel).toHaveBeenCalledWith("/sessions/demo.jsonl", "gpt-audio", "openai");
  });

  it("api-key provider with saved credentials uses remote catalog", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "qwen3.5-flash", context_length: 131072, max_output_tokens: 16384 },
          { id: "qwen3.5-plus", context_length: 1048576, max_output_tokens: 65536 },
          { id: "qwen3-max", context_length: 262144, max_output_tokens: 32768 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "dashscope",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.models).toHaveLength(3);
  });

  it("SGLang/no-auth provider fetches remote catalog without Authorization", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "qwen3-32b" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({
          apiKey: "",
          baseUrl: "https://sglang.example.test/v1",
          api: "openai-completions",
          authType: "none",
        }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "sglang" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    const data = await res.json();
    expect(data.models[0].id).toBe("qwen3-32b");
  });

  it("provider fetch-models applies provider-specific URL normalization to inline Ollama endpoints", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "qwen3:32b" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ollama",
        base_url: "http://localhost:11434",
        api: "openai-completions",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:11434/v1/models");
  });

  it("provider fetch-models keeps MiniMax Anthropic inline endpoints on the regional catalog and x-api-key auth", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "MiniMax-M2.5" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "minimax-token-plan",
        base_url: "https://api.minimaxi.com/v1",
        api: "anthropic-messages",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.minimaxi.com/anthropic/v1/models?limit=1000");
    expect(init.headers["x-api-key"]).toBe("sk-test");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("provider fetch-models can fall back to registry media models for requested image providers", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn());

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
        getMediaModels: (id, capability) => {
          if (id !== "volcengine" || capability !== "image_generation") return [];
          return [
            {
              id: "doubao-seedream-5-0-lite-260128",
              displayName: "Seedream 5.0 Lite",
              protocolId: "volcengine-images",
            },
          ];
        },
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "volcengine", model_type: "image" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("media");
    expect(data.models).toEqual([
      expect.objectContaining({
        id: "doubao-seedream-5-0-lite-260128",
        type: "image",
        protocolId: "volcengine-images",
      }),
    ]);
  });

  it("zhipu model discovery supplements incomplete remote catalogs with curated current GLM defaults", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "glm-5", context_length: 200000, max_output_tokens: 128000 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({
          apiKey: "zhipu-key",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          api: "openai-completions",
        }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "zhipu" ? ["glm-5.1", "glm-5", "glm-4.7-flash"] : [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zhipu" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models.slice(0, 3).map(m => m.id)).toEqual(["glm-5", "glm-5.1", "glm-4.7-flash"]);
    expect(data.models.map(m => m.id)).toEqual(expect.arrayContaining(["glm-5-turbo", "glm-4-flash"]));
  });

  it("configured providers fall back to saved models when remote discovery is unavailable", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({
          apiKey: "saved-key",
          baseUrl: "https://custom.example.test/v1",
          api: "openai-completions",
        }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
        getAllProvidersRaw: () => ({
          custom: {
            base_url: "https://custom.example.test/v1",
            api: "openai-completions",
            api_key: "saved-key",
            models: [
              { id: "saved-chat", name: "Saved Chat", context: 131072, maxOutput: 8192 },
            ],
          },
        }),
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "custom", model_type: "chat" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("saved");
    expect(data.models).toEqual([
      expect.objectContaining({
        id: "saved-chat",
        name: "Saved Chat",
        type: "chat",
        context: 131072,
        maxOutput: 8192,
      }),
    ]);
  });

  it("providers summary marks no-auth providers with models as configured", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const providerEntry = {
      displayName: "SGLang",
      authType: "none",
      baseUrl: "https://sglang.example.test/v1",
      api: "openai-completions",
    };
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({
          sglang: {
            auth_type: "none",
            base_url: "https://sglang.example.test/v1",
            api: "openai-completions",
            models: ["qwen3-32b"],
          },
        }),
        get: () => providerEntry,
        isOAuth: () => false,
        getAuthJsonKey: (id) => id,
        getAuthType: () => "none",
        allowsMissingApiKey: () => true,
        getOAuthProviderIds: () => [],
        getAll: () => new Map([["sglang", providerEntry]]),
      },
      authStorage: { getOAuthProviders: () => [] },
      preferences: { getOAuthCustomModels: () => ({}) },
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.providers.sglang).toMatchObject({
      auth_type: "none",
      has_credentials: true,
      config_status: "ok",
      missing_fields: [],
    });
  });

  it("providers summary reports malformed provider configs without crashing", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({
          broken: { _config_error: "malformed_provider_config" },
        }),
        get: () => null,
        isOAuth: () => false,
        getAuthJsonKey: (id) => id,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      authStorage: { getOAuthProviders: () => [] },
      preferences: { getOAuthCustomModels: () => ({}) },
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.providers.broken).toMatchObject({
      config_status: "invalid",
      config_error: "malformed_provider_config",
      missing_fields: ["base_url", "api_key", "models"],
    });
  });

  it("remote 404 falls back to registry", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }));

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex", contextWindow: 272000, maxOutputTokens: 128000 },
      ]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "oauth-token", baseUrl: "https://api.openai.com/v1", api: "openai-codex-responses" }),
        getAuthJsonKey: () => "openai-codex",
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex-oauth" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("registry");
    expect(data.models[0].id).toBe("gpt-5.4");
    expect(data.models[0].type).toBe("chat");
  });

  it("remote 401 returns error without fallback", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" }));

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn(),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "bad-key", baseUrl: "https://api.example.com/v1", api: "openai-completions" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "some-provider" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toContain("401");
    expect(data.models).toEqual([]);
    expect(engine.getRegistryModelsForProvider).not.toHaveBeenCalled();
  });

  it("remote 401 without credentials falls back to builtin provider models", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" }));

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "deepseek" ? ["deepseek-v4-pro", "deepseek-v4-flash"] : [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
  });

  it("defaults fallback uses authJsonKey when provider ID has no defaults", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "openai-codex-responses" }),
        getAuthJsonKey: () => "openai-codex",
        getDefaultModels: (id) => {
          if (id === "openai-codex") return ["gpt-5.4", "gpt-5.3-codex"];
          return null;
        },
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex-oauth" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toEqual(["gpt-5.4", "gpt-5.3-codex"]);
    expect(data.models.every(m => m.type === "chat")).toBe(true);
  });

  it("anthropic-messages fetches remote model catalog from /v1/models", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "claude-opus-4-7", display_name: "Claude Opus 4.7", max_input_tokens: 200000, max_tokens: 64000 },
          { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", max_input_tokens: 200000, max_tokens: 64000 },
        ],
        has_more: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "anthropic" }),
    });

    expect(res.status).toBe(200);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const data = await res.json();
    expect(data.models).toEqual([
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", type: "chat", context: 200000, maxOutput: 64000, input: ["text", "image"], image: true, vision: true },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", type: "chat", context: 200000, maxOutput: 64000, input: ["text", "image"], image: true, vision: true },
    ]);
  });

  it("google-generative-ai hits native Gemini /models with x-goog-api-key and normalizes fields", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            name: "models/gemini-3.1-pro-preview",
            baseModelId: "gemini-3.1-pro-preview",
            displayName: "Gemini 3.1 Pro Preview",
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({
          apiKey: "gemini-key",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          api: "google-generative-ai",
        }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "gemini" }),
    });

    expect(res.status).toBe(200);
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(fetchCall[1].headers["x-goog-api-key"]).toBe("gemini-key");
    expect(fetchCall[1].headers.Authorization).toBeUndefined();

    const data = await res.json();
    expect(data.models).toEqual([
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        type: "chat",
        context: 1048576,
        maxOutput: 65536,
        input: ["text", "image", "video"],
        image: true,
        video: true,
        vision: true,
      },
    ]);
  });

  it("MiniMax Anthropic model discovery keeps the regional Anthropic catalog URL", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "MiniMax-M2.7", display_name: "MiniMax-M2.7", max_input_tokens: 204800, max_tokens: 131072 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.minimaxi.com/anthropic", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "minimax" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.minimaxi.com/anthropic/v1/models?limit=1000");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("sk-test");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();

    const data = await res.json();
    expect(data.models[0]).toMatchObject({ id: "MiniMax-M2.7", type: "chat" });
  });

  it("initial setup model discovery with a MiniMax provider id uses the provider-specific endpoint and x-api-key auth", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "MiniMax-M2.7", display_name: "MiniMax-M2.7", max_input_tokens: 204800, max_tokens: 131072 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "minimax-token-plan",
        base_url: "https://api.minimaxi.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.minimaxi.com/anthropic/v1/models?limit=1000");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("sk-test");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();

    const data = await res.json();
    expect(data.models[0]).toMatchObject({ id: "MiniMax-M2.7", type: "chat" });
  });

  it("Anthropic-compatible model discovery retries with Bearer auth after x-api-key auth is rejected", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: "gateway-model", display_name: "Gateway Model", max_input_tokens: 128000, max_tokens: 8192 },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://anthropic-gateway.example/v1", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "gateway-provider" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("sk-test");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers["x-api-key"]).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer sk-test");
    const data = await res.json();
    expect(data.models[0]).toMatchObject({ id: "gateway-model", type: "chat" });
  });

  it("MiniMax Anthropic connection test uses x-api-key auth on the messages endpoint", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.minimaxi.com/anthropic", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "minimax-token-plan" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.minimaxi.com/anthropic/v1/messages");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("sk-test");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("Anthropic-compatible connection test uses provider defaults instead of a placeholder model", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.minimaxi.com/anthropic", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "minimax-token-plan" ? ["MiniMax-M2.7"] : [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "minimax-token-plan" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 200 });
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.model).toBe("MiniMax-M2.7");
  });

  it("initial setup Anthropic-compatible connection test discovers a real model before probing", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "claude-compatible-chat" }] }),
      })
      .mockResolvedValueOnce({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "custom-anthropic",
        base_url: "https://anthropic-compatible.example",
        api: "anthropic-messages",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://anthropic-compatible.example/v1/models?limit=1000");
    expect(fetchMock.mock.calls[1][0]).toBe("https://anthropic-compatible.example/v1/messages");
    const requestBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(requestBody.model).toBe("claude-compatible-chat");
  });

  it("Anthropic-compatible connection test retries with Bearer auth after x-api-key auth is rejected", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://anthropic-gateway.example/v1", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "gateway-provider" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("sk-test");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers["x-api-key"]).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer sk-test");
  });

  it("initial setup Anthropic-compatible connection test does not infer MiniMax provider auth from URL alone", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: "https://api.minimaxi.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.minimaxi.com/anthropic/v1/messages");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("sk-test");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("initial setup OpenAI-compatible connection test accepts a bare API host", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "chat-model" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: "https://llm.example.com",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://llm.example.com/v1/models");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-test");
  });

  it("anthropic-messages falls back to defaults when remote 404s", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }));

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.kimi.com/coding", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "kimi-coding" ? ["kimi-k2.6", "kimi-k2.5"] : [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "kimi-coding" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toEqual(["kimi-k2.6", "kimi-k2.5"]);
  });

  it("request body api_key overrides saved credentials", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "test-model" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "saved-key", baseUrl: "https://api.example.com/v1", api: "openai-completions" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      codiaHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-provider",
        api_key: "body-key中文",
      }),
    });

    expect(res.status).toBe(200);
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall[1].headers["Authorization"]).toBe("Bearer body-key");
  });
});
