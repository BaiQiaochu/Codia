import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MASKED_SECRET } from "../shared/secret-custody.ts";

vi.mock("../lib/pi-sdk/index.js", () => ({
  formatSkillsForPrompt: () => "",
}));

describe("secret custody across HTTP routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("masks provider secrets in summary responses", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://api.deepseek.com",
            api: "openai-completions",
            api_key: "sk-provider-secret",
            models: ["deepseek-chat"],
          },
        }),
        get: () => ({ authType: "api-key", baseUrl: "", api: "openai-completions" }),
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      authStorage: { getOAuthProviders: () => [] },
      preferences: { getOAuthCustomModels: () => ({}) },
      gsapHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.providers.deepseek.api_key).toBe(MASKED_SECRET);
    expect(JSON.stringify(body)).not.toContain("sk-provider-secret");
  });

  it("resolves runtime provider API key refs before revealing saved keys", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({
          net: {
            base_url: "http://137.220.151.198:8080/v1",
            api: "openai-completions",
            api_key: "gsap-runtime-api-key:net",
            models: ["GPT-5.5"],
          },
        }),
        get: () => ({ authType: "api-key", baseUrl: "", api: "openai-completions" }),
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      authStorage: {
        getOAuthProviders: () => [],
        getApiKey: vi.fn(async (providerId) => providerId === "net" ? "sk-real-net-key" : ""),
      },
      resolveProviderCredentials: () => ({
        api_key: "gsap-runtime-api-key:net",
        base_url: "http://137.220.151.198:8080/v1",
        api: "openai-completions",
      }),
      preferences: { getOAuthCustomModels: () => ({}) },
      gsapHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const summaryRes = await app.request("/api/providers/summary");
    const summaryBody = await summaryRes.json();
    expect(summaryBody.providers.net.api_key).toBe(MASKED_SECRET);
    expect(JSON.stringify(summaryBody)).not.toContain("gsap-runtime-api-key:net");

    const revealRes = await app.request("/api/providers/net/api-key");
    const revealBody = await revealRes.json();
    expect(revealRes.status).toBe(200);
    expect(revealBody.api_key).toBe("sk-real-net-key");
    expect(JSON.stringify(revealBody)).not.toContain("gsap-runtime-api-key:net");
  });

  it("preserves saved provider secrets when a masked config patch is submitted", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const saveProvider = vi.fn();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      currentAgentId: "gsap",
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://old.example/v1",
            api_key: "sk-saved-provider",
          },
        }),
        saveProvider,
      },
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          deepseek: {
            base_url: "https://new.example/v1",
            api_key: MASKED_SECRET,
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("deepseek", {
      base_url: "https://new.example/v1",
      api_key: "sk-saved-provider",
    });
  });

  it("preserves saved provider secrets when a masked inline API patch is submitted", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const saveProvider = vi.fn();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      currentAgentId: "gsap",
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://old.example/v1",
            api_key: "sk-saved-provider",
          },
        }),
        saveProvider,
      },
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: {
          provider: "deepseek",
          base_url: "https://new.example/v1",
          api_key: MASKED_SECRET,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("deepseek", {
      base_url: "https://new.example/v1",
      api_key: "sk-saved-provider",
    });
  });

  it("masks global preference secrets and resolves masked updates back to saved values", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const setSearchConfig = vi.fn();
    const setUtilityApi = vi.fn();
    const engine = {
      getSharedModels: () => ({}),
      getSearchConfig: () => ({ provider: "tavily", api_key: "tvly-secret", api_keys: { brave: "brave-secret" } }),
      getUtilityApi: () => ({ provider: "openai", base_url: "https://api.example/v1", api_key: "sk-utility" }),
      setSearchConfig,
      setUtilityApi,
      emitEvent: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine));

    const readRes = await app.request("/api/preferences/models");
    const readBody = await readRes.json();
    expect(readBody.search.api_key).toBe(MASKED_SECRET);
    expect(readBody.search.api_keys.brave).toBe(MASKED_SECRET);
    expect(readBody.utility_api.api_key).toBe(MASKED_SECRET);
    expect(JSON.stringify(readBody)).not.toContain("tvly-secret");
    expect(JSON.stringify(readBody)).not.toContain("sk-utility");

    const writeRes = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        search: { provider: "tavily", api_key: MASKED_SECRET, api_keys: { brave: MASKED_SECRET } },
        utility_api: { provider: "openai", base_url: "https://new.example/v1", api_key: MASKED_SECRET },
      }),
    });

    expect(writeRes.status).toBe(200);
    expect(setSearchConfig).toHaveBeenCalledWith({
      provider: "tavily",
      api_key: "tvly-secret",
      api_keys: { brave: "brave-secret" },
    });
    expect(setUtilityApi).toHaveBeenCalledWith({
      provider: "openai",
      base_url: "https://new.example/v1",
      api_key: "sk-utility",
    });
  });

  it("masks bridge secrets in status and preserves masked config updates", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.js");
    const agent = {
      id: "gsap",
      config: {
        bridge: {
          telegram: { token: "tg-secret", enabled: true },
          feishu: { appId: "cli-id", appSecret: "fs-secret" },
          qq: { appID: "qq-id", appSecret: "qq-secret" },
          wechat: { botToken: "wx-secret" },
        },
      },
      updateConfig: vi.fn(),
    };
    const engine = {
      currentAgentId: "gsap",
      getAgent: (id) => id === "gsap" ? agent : null,
      getBridgeIndex: () => ({}),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const bridgeManager = {
      getStatus: () => ({}),
      stopPlatform: vi.fn(),
      startPlatformFromConfig: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, bridgeManager));

    const readRes = await app.request("/api/bridge/status");
    const readBody = await readRes.json();
    expect(readBody.telegram.token).toBe(MASKED_SECRET);
    expect(readBody.feishu.appSecret).toBe(MASKED_SECRET);
    expect(readBody.qq.appSecret).toBe(MASKED_SECRET);
    expect(readBody.wechat.token).toBe(MASKED_SECRET);
    expect(JSON.stringify(readBody)).not.toContain("tg-secret");
    expect(JSON.stringify(readBody)).not.toContain("fs-secret");

    const writeRes = await app.request("/api/bridge/config?agentId=gsap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "telegram",
        credentials: { token: MASKED_SECRET },
        enabled: false,
      }),
    });

    expect(writeRes.status).toBe(200);
    expect(agent.updateConfig).toHaveBeenCalledWith({
      bridge: {
        telegram: { token: "tg-secret", enabled: false },
      },
    });
  });
});
