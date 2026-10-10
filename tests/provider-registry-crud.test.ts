/**
  *
 *
  *
 * addModel, removeModel, saveProvider, removeProvider
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { ProviderRegistry } from "../core/provider-registry.js";

const tmpDir = path.join(os.tmpdir(), "codia-test-pr-crud-" + Date.now());

function writeAddedModels(providers) {
  const ymlPath = path.join(tmpDir, "added-models.yaml");
  fs.writeFileSync(ymlPath, YAML.dump({ providers }), "utf-8");
}

function readProviderCatalog() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, "provider-catalog.json"), "utf-8"));
}

function readProviderCatalogMeta() {
  return readProviderCatalog().meta || {};
}

function readAddedModels() {
  const catalogPath = path.join(tmpDir, "provider-catalog.json");
  if (fs.existsSync(catalogPath)) return readProviderCatalog().providers || {};
  const ymlPath = path.join(tmpDir, "added-models.yaml");
  const raw = YAML.load(fs.readFileSync(ymlPath, "utf-8"));
  return raw?.providers || {};
}

function readAddedModelsDocument() {
  const catalogPath = path.join(tmpDir, "provider-catalog.json");
  if (fs.existsSync(catalogPath)) return readProviderCatalog();
  const ymlPath = path.join(tmpDir, "added-models.yaml");
  return YAML.load(fs.readFileSync(ymlPath, "utf-8")) || {};
}

function writeProviderCatalog(catalog) {
  fs.writeFileSync(
    path.join(tmpDir, "provider-catalog.json"),
    JSON.stringify(catalog, null, 2) + "\n",
    "utf-8",
  );
}

function readLocalProviderPlugin(providerId) {
  return JSON.parse(fs.readFileSync(
    path.join(tmpDir, "provider-plugins", providerId, "providers", `${providerId}.json`),
    "utf-8",
  ));
}

function readLocalProviderManifest(providerId) {
  return JSON.parse(fs.readFileSync(
    path.join(tmpDir, "provider-plugins", providerId, "manifest.json"),
    "utf-8",
  ));
}

function readOnlyLocalProviderPluginDir() {
  const root = path.join(tmpDir, "provider-plugins");
  const dirs = fs.readdirSync(root).filter((entry) => fs.statSync(path.join(root, entry)).isDirectory());
  expect(dirs).toHaveLength(1);
  return dirs[0];
}

/** */
function makeRegistry(pluginOverrides = {}) {
  const reg = new ProviderRegistry(tmpDir);
  //
  reg._plugins.clear();
  reg._entries.clear();

  const testPlugin = {
    id: "test-provider",
    displayName: "Test Provider",
    authType: "api-key",
    defaultBaseUrl: "https://api.test.com/v1",
    defaultApi: "openai-completions",
    ...pluginOverrides,
  };
  reg._plugins.set(testPlugin.id, testPlugin);
  return reg;
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── getCredentials ───────────────────────────────────────────────────────────

describe("built-in provider catalog", () => {
  it("does not ship ToAPIs as a built-in provider", () => {
    const reg = new ProviderRegistry(tmpDir);

    expect(reg.get("toapis")).toBeNull();
  });

  it("ships MiniMax Token Plan as a separate Anthropic-compatible provider", () => {
    const reg = new ProviderRegistry(tmpDir);
    const entry = reg.get("minimax-token-plan");

    expect(entry).toMatchObject({
      id: "minimax-token-plan",
      displayName: "MiniMax Token Plan",
      authType: "api-key",
      baseUrl: "https://api.minimaxi.com/anthropic",
      api: "anthropic-messages",
      isBuiltin: true,
    });
  });

  it("ships Xiaomi MiMo Token Plan as a separate OpenAI-compatible provider", () => {
    const reg = new ProviderRegistry(tmpDir);
    const entry = reg.get("mimo-token-plan");

    expect(entry).toMatchObject({
      id: "mimo-token-plan",
      displayName: "Xiaomi MiMo Token Plan",
      authType: "api-key",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      api: "openai-completions",
      isBuiltin: true,
    });
    expect(reg.getDefaultModels("mimo-token-plan")).toEqual(expect.arrayContaining([
      "mimo-v2.5-pro",
      "mimo-v2.5",
    ]));
  });

  it("keeps default model additions from the 0.306.1 provider catalog", () => {
    const reg = new ProviderRegistry(tmpDir);

    expect(reg.getDefaultModels("minimax")).toEqual(expect.arrayContaining([
      "MiniMax-M3",
      "MiniMax-M2.1-highspeed",
    ]));
    expect(reg.getDefaultModels("minimax-token-plan")).toEqual(expect.arrayContaining([
      "MiniMax-M3",
      "MiniMax-M2.1-highspeed",
    ]));
    expect(reg.getDefaultModels("gemini")).toEqual(expect.arrayContaining([
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
    ]));
    expect(reg.getDefaultModels("zhipu")).toEqual(expect.arrayContaining([
      "glm-5.1",
      "glm-4.7-flash",
    ]));
  });
});

describe("getCredentials", () => {
  it("migrates legacy added-models.yaml to provider-catalog.json and uses v2 as the live provider source", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-test-123",
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        models: ["model-a"],
      },
    });
    const legacyPath = path.join(tmpDir, "added-models.yaml");
    const legacyBefore = fs.readFileSync(legacyPath, "utf-8");

    const reg = makeRegistry();

    expect(reg.getCredentials("test-provider")).toMatchObject({
      apiKey: "sk-test-123",
      baseUrl: "https://custom.api.com/v1",
      api: "openai-completions",
    });
    expect(readProviderCatalog().providers["test-provider"].models).toEqual(["model-a"]);

    reg.updateModelEntry("test-provider", "model-a", { image: true });

    expect(fs.readFileSync(legacyPath, "utf-8")).toBe(legacyBefore);
    expect(readProviderCatalog().providers["test-provider"].models[0]).toMatchObject({
      id: "model-a",
      image: true,
    });
  });

  it("OAuth provider can resolve credentials through authJsonKey alias", () => {
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-oauth": {
        type: "oauth",
        access: "oauth-access-token-abc",
        resourceUrl: "https://resource.test.com/v1",
        accountId: "acct_123",
      },
    }), "utf-8");

    writeAddedModels({
      "test-oauth": {
        api: "openai-completions",
        models: [{ id: "model-a" }],
      },
    });

    const reg = new ProviderRegistry(tmpDir);
    reg._plugins.clear();
    reg._entries.clear();
    reg._plugins.set("test-oauth-plugin", {
      id: "test-oauth-plugin",
      displayName: "Test OAuth",
      authType: "oauth",
      defaultBaseUrl: "",
      defaultApi: "openai-completions",
      authJsonKey: "test-oauth",
    });

    const creds = reg.getCredentials("test-oauth-plugin");
    expect(creds).toEqual({
      apiKey: "oauth-access-token-abc",
      baseUrl: "https://resource.test.com/v1",
      api: "openai-completions",
      authType: "oauth",
      accountId: "acct_123",
    });
  });

  it("OAuth-only provider can read auth.json without an added-models entry", () => {
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-oauth": {
        type: "oauth",
        access: "oauth-access-token-abc",
      },
    }), "utf-8");

    writeAddedModels({});

    const reg = new ProviderRegistry(tmpDir);
    reg._plugins.clear();
    reg._entries.clear();
    reg._plugins.set("test-oauth-plugin", {
      id: "test-oauth-plugin",
      displayName: "Test OAuth",
      authType: "oauth",
      defaultBaseUrl: "https://oauth.test.com/backend-api",
      defaultApi: "openai-codex-responses",
      authJsonKey: "test-oauth",
    });

    const creds = reg.getCredentials("test-oauth-plugin");
    expect(creds).toEqual({
      apiKey: "oauth-access-token-abc",
      baseUrl: "https://oauth.test.com/backend-api",
      api: "openai-codex-responses",
      authType: "oauth",
    });
  });
  it("returns configured provider apiKey, baseUrl, and api", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-test-123",
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
      },
    });
    const reg = makeRegistry();
    const creds = reg.getCredentials("test-provider");
    expect(creds).toEqual({
      apiKey: "sk-test-123",
      baseUrl: "https://custom.api.com/v1",
      api: "openai-completions",
      authType: "api-key",
    });
  });

  it("returns null for an unconfigured provider", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    const creds = reg.getCredentials("nonexistent");
    expect(creds).toBeNull();
  });

  it("falls back to plugin defaults when added-models.yaml lacks baseUrl or api", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-fallback",
      },
    });
    const reg = makeRegistry();
    const creds = reg.getCredentials("test-provider");
    expect(creds.apiKey).toBe("sk-fallback");
    expect(creds.baseUrl).toBe("https://api.test.com/v1");
    expect(creds.api).toBe("openai-completions");
  });

  it("reads OAuth access token from auth.json when api_key is absent", () => {
    //
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-oauth-key": {
        type: "oauth",
        access: "oauth-access-token-abc",
        refresh: "refresh-xyz",
        expires: Date.now() + 3600_000,
      },
    }), "utf-8");

    writeAddedModels({
      "test-oauth": {
        models: [{ id: "model-a" }],
      },
    });

    const reg = new ProviderRegistry(tmpDir);
    reg._plugins.clear();
    reg._entries.clear();
    reg._plugins.set("test-oauth", {
      id: "test-oauth",
      displayName: "Test OAuth",
      authType: "oauth",
      defaultBaseUrl: "https://api.test.com/v1",
      defaultApi: "openai-completions",
      authJsonKey: "test-oauth-key",
    });

    const creds = reg.getCredentials("test-oauth");
    expect(creds.apiKey).toBe("oauth-access-token-abc");
    expect(creds.baseUrl).toBe("https://api.test.com/v1");
    expect(creds.api).toBe("openai-completions");
  });

  it("does not use auth.json for API key providers", () => {
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-provider": { access: "should-not-use-this" },
    }), "utf-8");

    writeAddedModels({
      "test-provider": {
        api_key: "sk-real-key",
      },
    });

    const reg = makeRegistry(); // authType: "api-key"
    const creds = reg.getCredentials("test-provider");
    expect(creds.apiKey).toBe("sk-real-key");
  });

  it("does not fill API key providers from auth.json when api_key is missing", () => {
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-provider": { access: "leaked-token" },
    }), "utf-8");

    writeAddedModels({
      "test-provider": {
        // No api_key.
        models: ["m1"],
      },
    });

    const reg = makeRegistry(); // authType: "api-key"
    const creds = reg.getCredentials("test-provider");
    expect(creds.apiKey).toBe(""); // 不会读到 auth.json 的 leaked-token
  });

  it("uses an empty apiKey when OAuth auth.json has no matching entry", () => {
    //
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({}), "utf-8");

    writeAddedModels({ "test-oauth": { models: ["m1"] } });

    const reg = new ProviderRegistry(tmpDir);
    reg._plugins.clear();
    reg._entries.clear();
    reg._plugins.set("test-oauth", {
      id: "test-oauth",
      displayName: "Test OAuth",
      authType: "oauth",
      defaultBaseUrl: "https://api.test.com/v1",
      defaultApi: "openai-completions",
      authJsonKey: "test-oauth-key",
    });

    const creds = reg.getCredentials("test-oauth");
    expect(creds.apiKey).toBe("");
  });
});

// ── getProviderModels ────────────────────────────────────────────────────────

describe("auth policy", () => {
  it("normalizes auth types and allows optional providers without API keys", () => {
    writeAddedModels({
      "test-provider": {
        auth_type: "optional",
        base_url: "https://models.example.test/v1",
        models: ["m1"],
      },
      "invalid-provider": {
        auth_type: "invalid",
        base_url: "https://invalid.example.test/v1",
      },
    });

    const reg = makeRegistry();

    expect(reg.getAuthType("test-provider")).toBe("optional");
    expect(reg.allowsMissingApiKey("test-provider")).toBe(true);
    expect(reg.getAuthType("invalid-provider")).toBe("api-key");
    expect(reg.allowsMissingApiKey("invalid-provider")).toBe(false);
  });
});

describe("provider catalog capabilities", () => {
  it("exposes non-chat capability providers from provider-catalog.json", () => {
    writeProviderCatalog({
      catalogVersion: 2,
      providers: {},
      capabilities: {
        "web.search": {
          providers: [
            { id: "brave", source: "api", requiresApiKey: true },
            { id: "duckduckgo_browser", source: "browser", requiresApiKey: false },
          ],
        },
      },
      meta: {},
    });
    const reg = makeRegistry();

    const providers = reg.getCapabilityProviders("web.search");
    providers.push({ id: "polluted", source: "test" });

    expect(reg.getCapabilityProviders("web.search")).toEqual([
      { id: "brave", source: "api", requiresApiKey: true },
      { id: "duckduckgo_browser", source: "browser", requiresApiKey: false },
    ]);
    expect(reg.getCapabilityProviders("missing.capability")).toEqual([]);
  });
});

describe("getProviderModels", () => {
  it("returns string-format model IDs", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a", "model-b", "model-c"],
      },
    });
    const reg = makeRegistry();
    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("extracts ids from object-format model entries", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: [
          "model-a",
          { id: "model-b", name: "Model B", context: 128000 },
          "model-c",
        ],
      },
    });
    const reg = makeRegistry();
    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("returns an empty array when models are missing", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
    });
    const reg = makeRegistry();
    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual([]);
  });

  it("returns an empty array for missing providers", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    const models = reg.getProviderModels("nonexistent");
    expect(models).toEqual([]);
  });
});

// ── getAllProvidersRaw ────────────────────────────────────────────────────────

describe("getAllProvidersRaw", () => {
  it("returns raw added-models.yaml data", () => {
    const data = {
      "test-provider": {
        api_key: "sk-x",
        base_url: "https://api.test.com/v1",
        models: ["model-a"],
      },
      "other-provider": {
        api_key: "sk-y",
      },
    };
    writeAddedModels(data);
    const reg = makeRegistry();
    const raw = reg.getAllProvidersRaw();
    expect(raw["test-provider"].api_key).toBe("sk-x");
    expect(raw["other-provider"].api_key).toBe("sk-y");
    expect(raw["test-provider"].models).toEqual(["model-a"]);
  });

  it("returns an empty object when added-models.yaml is missing", () => {
    // 不写文件
    const reg = makeRegistry();
    const raw = reg.getAllProvidersRaw();
    expect(raw).toEqual({});
  });
});

// ── addModel ─────────────────────────────────────────────────────────────────

describe("addModel", () => {
  it("adds a model to an existing provider and persists it", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", "model-b");

    // 验证内存
    const models = reg.getProviderModels("test-provider");
    expect(models).toContain("model-b");

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toContain("model-b");
  });

  it("does not add duplicate models", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", "model-a");

    const persisted = readAddedModels();
    const count = persisted["test-provider"].models.filter(
      (m) => m === "model-a",
    ).length;
    expect(count).toBe(1);
  });

  it("creates models field when provider has no models field", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", "new-model");

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["new-model"]);
  });

  it("can add object-format models", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x", models: [] },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", { id: "model-obj", name: "Model Obj", context: 32000 });

    const persisted = readAddedModels();
    const entry = persisted["test-provider"].models.find(
      (m) => (typeof m === "object" ? m.id : m) === "model-obj",
    );
    expect(entry).toBeTruthy();
  });

  it("does not duplicate object-format models with the same id", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x", models: ["model-obj"] },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", { id: "model-obj", name: "Model Obj" });

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toHaveLength(1);
  });
});

// ── removeModel ──────────────────────────────────────────────────────────────

describe("removeModel", () => {
  it("removes a model and persists it", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a", "model-b", "model-c"],
      },
    });
    const reg = makeRegistry();
    reg.removeModel("test-provider", "model-b");

    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual(["model-a", "model-c"]);

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["model-a", "model-c"]);
  });

  it("removes object-format model entries by id", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: [
          "model-a",
          { id: "model-b", name: "Model B" },
        ],
      },
    });
    const reg = makeRegistry();
    reg.removeModel("test-provider", "model-b");

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["model-a"]);
  });

  it("does not throw when removing a missing model", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    expect(() => reg.removeModel("test-provider", "nonexistent")).not.toThrow();
    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["model-a"]);
  });
});

// ── saveProvider ─────────────────────────────────────────────────────────────

describe("saveProvider", () => {
  it("rejects unsafe API keys and header values before persistence", () => {
    writeAddedModels({});
    const reg = makeRegistry();

    for (const data of [
      { api_key: "sk-中文" },
      { headers: { Authorization: "Bearer safe\r\nX-Evil: injected" } },
    ]) {
      expect(() => reg.saveProvider("test-provider", data)).toThrow(
        expect.objectContaining({ statusCode: 400, code: "invalid_provider_credential_value" }),
      );
    }

    expect(readAddedModels()["test-provider"]).toBeUndefined();
  });

  it("creates a new provider entry", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    reg.saveProvider("new-provider", {
      api_key: "sk-new",
      base_url: "https://new.api.com/v1",
      api: "openai-completions",
    });

    const persisted = readAddedModels();
    expect(persisted["new-provider"]).toBeDefined();
    expect(persisted["new-provider"].api_key).toBe("sk-new");
  });

  it("persists new custom provider definitions as local provider plugins with catalog credential overlays", () => {
    writeAddedModels({});
    const reg = makeRegistry();

    reg.saveProvider("custom-openai", {
      display_name: "Custom OpenAI",
      auth_type: "optional",
      base_url: "https://custom.example/v1",
      api: "openai-completions",
      models: [{ id: "chat-a" }],
      api_key: "sk-custom",
      headers: { "X-Custom": "1" },
    });
    reg.reload();

    expect(readLocalProviderManifest("custom-openai")).toMatchObject({
      id: "custom-openai",
      type: "provider-plugin",
      provider: "custom-openai",
    });
    expect(readLocalProviderPlugin("custom-openai")).toMatchObject({
      id: "custom-openai",
      displayName: "Custom OpenAI",
      authType: "optional",
      defaultBaseUrl: "https://custom.example/v1",
      defaultApi: "openai-completions",
      models: [{ id: "chat-a" }],
    });
    expect(readAddedModels()["custom-openai"]).toEqual({
      api_key: "sk-custom",
      headers: { "X-Custom": "1" },
    });
    expect(reg.get("custom-openai")).toMatchObject({
      id: "custom-openai",
      displayName: "Custom OpenAI",
      baseUrl: "https://custom.example/v1",
      source: { kind: "local-provider-plugin" },
    });
    expect(reg.getAllProvidersRaw()["custom-openai"]).toMatchObject({
      display_name: "Custom OpenAI",
      auth_type: "optional",
      base_url: "https://custom.example/v1",
      api: "openai-completions",
      api_key: "sk-custom",
      headers: { "X-Custom": "1" },
      models: [{ id: "chat-a" }],
    });
  });

  it("migrates non-path-safe catalog provider ids to safe storage while preserving the provider id", () => {
    const providerId = "硅基流动";
    writeProviderCatalog({
      catalogVersion: 2,
      providers: {
        [providerId]: {
          display_name: "硅基流动",
          auth_type: "api-key",
          api_key: "sk-silicon",
          base_url: "https://api.siliconflow.cn/v1",
          api: "openai-completions",
          models: ["deepseek-ai/DeepSeek-V3.2"],
        },
      },
      capabilities: {},
      meta: {},
    });

    const reg = new ProviderRegistry(tmpDir);
    const entry = reg.get(providerId);

    expect(entry).toMatchObject({
      id: providerId,
      displayName: "硅基流动",
      baseUrl: "https://api.siliconflow.cn/v1",
      api: "openai-completions",
      source: { kind: "local-provider-plugin" },
    });

    const storageId = readOnlyLocalProviderPluginDir();
    expect(storageId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(storageId).not.toBe(providerId);

    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, "provider-plugins", storageId, "manifest.json"), "utf-8"));
    expect(manifest).toMatchObject({
      id: storageId,
      provider: providerId,
    });
    const providerFile = JSON.parse(fs.readFileSync(
      path.join(tmpDir, "provider-plugins", storageId, "providers", `${storageId}.json`),
      "utf-8",
    ));
    expect(providerFile).toMatchObject({
      id: providerId,
      displayName: "硅基流动",
      defaultBaseUrl: "https://api.siliconflow.cn/v1",
    });
    expect(readProviderCatalog().providers[providerId]).toEqual({
      api_key: "sk-silicon",
    });
  });

  it("merges local provider plugin model metadata when catalog overlay only has bare ids", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);

    reg.saveProvider("custom-vl", {
      display_name: "Custom VL",
      auth_type: "api-key",
      api_key: "sk-vl",
      base_url: "https://vl.example/v1",
      api: "openai-completions",
      models: [{
        id: "vl-model",
        name: "VL Model",
        context: 128000,
        maxOutput: 16000,
        image: true,
        video: true,
        audio: true,
        reasoning: true,
      }],
    });

    const catalog = readProviderCatalog();
    catalog.providers["custom-vl"].models = ["vl-model"];
    writeProviderCatalog(catalog);

    const reloaded = new ProviderRegistry(tmpDir);
    const model = reloaded.getAllProvidersRaw()["custom-vl"].models[0];
    expect(model).toMatchObject({
      id: "vl-model",
      name: "VL Model",
      context: 128000,
      maxOutput: 16000,
      image: true,
      video: true,
      audio: true,
      reasoning: true,
    });
  });

  it("merges updates into existing provider config", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-old",
        base_url: "https://old.api.com/v1",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.saveProvider("test-provider", {
      api_key: "sk-new",
      base_url: "https://new.api.com/v1",
    });

    const persisted = readAddedModels();
    expect(persisted["test-provider"].api_key).toBe("sk-new");
    expect(persisted["test-provider"].base_url).toBe("https://new.api.com/v1");
    //
    expect(persisted["test-provider"].models).toEqual(["model-a"]);
  });

  it("invalidates cache after writes so the next get reflects new values", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    reg.saveProvider("test-provider", {
      api_key: "sk-saved",
      base_url: "https://saved.api.com/v1",
    });
    // 触发 reload
    const entry = reg.get("test-provider");
    expect(entry).toBeTruthy();
    expect(entry.baseUrl).toBe("https://saved.api.com/v1");
  });
});

// ── updateModelEntry type field ───────────────────────────────────────────────

describe("builtin MiMo default models", () => {
  it("seeds only chat defaults for first-time provider setup", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);

    reg.saveProvider("mimo", {
      api_key: "sk-mimo",
      base_url: "https://api.xiaomimimo.com/v1",
      api: "openai-completions",
      seed_default_models: true,
    });

    const persisted = readAddedModels();
    expect(persisted.mimo.models).toEqual(expect.arrayContaining([
      "mimo-v2.5-pro",
      "mimo-v2.5",
    ]));
    expect(persisted.mimo.models).not.toEqual(expect.arrayContaining([
      "mimo-v2.5-tts",
      "mimo-v2.5-tts-voicedesign",
      "mimo-v2.5-tts-voiceclone",
      "mimo-v2-asr",
    ]));
    expect(persisted.mimo.seed_default_models).toBeUndefined();
    expect(reg.getModelsByType("mimo", "audio")).toEqual([]);
  });
});

describe("updateModelEntry type field", () => {
  it("accepts type in updateModelEntry whitelist", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.updateModelEntry("test-provider", "model-a", { type: "image" });

    const raw = readAddedModels();
    const entry = raw["test-provider"].models.find(
      m => (typeof m === "object" ? m.id : m) === "model-a"
    );
    expect(entry).toEqual({ id: "model-a", type: "image" });
  });

  it("persists audio and normalizes context/max output aliases in updateModelEntry", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.updateModelEntry("test-provider", "model-a", {
      audio: true,
      contextWindow: 32768,
      maxTokens: 8192,
    });

    const raw = readAddedModels();
    const entry = raw["test-provider"].models.find(
      m => (typeof m === "object" ? m.id : m) === "model-a"
    );
    expect(entry).toEqual({
      id: "model-a",
      audio: true,
      context: 32768,
      maxOutput: 8192,
    });
  });

  it("persists chat model video capability metadata", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.updateModelEntry("test-provider", "model-a", { image: true, video: true, reasoning: true });

    const raw = readAddedModels();
    const entry = raw["test-provider"].models.find(
      m => (typeof m === "object" ? m.id : m) === "model-a"
    );
    expect(entry).toMatchObject({ id: "model-a", image: true, video: true, reasoning: true });
  });
});

// ── getModelsByType ───────────────────────────────────────────────────────────

describe("getModelsByType", () => {
  it("returns only image models for a provider", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: [
          "chat-model",
          { id: "image-model", type: "image" },
        ],
      },
    });
    const reg = makeRegistry();
    const imageModels = reg.getModelsByType("test-provider", "image");
    expect(imageModels).toHaveLength(1);
    expect(imageModels[0].id).toBe("image-model");
  });

  it("returns explicit video models and ignores untyped video-like ids in generic models", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: [
          "chat-model",
          { id: "custom-video-model", type: "video" },
          "doubao-seedance-2-0-260128",
          { id: "untyped-video-model" },
        ],
      },
    });
    const reg = makeRegistry();
    const videoModels = reg.getModelsByType("test-provider", "video");
    expect(videoModels.map((model) => model.id)).toEqual(["custom-video-model"]);
  });

  it("does not infer image type for untyped image-generation ids in generic models", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: [
          "gptimage2",
          { id: "flux-1-dev", name: "Flux 1 Dev" },
          "chat-model",
        ],
      },
    });
    const reg = makeRegistry();
    expect(reg.getModelsByType("test-provider", "image")).toEqual([]);
  });

  it("does not treat legacy media-like string model ids as imported media models", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: [
          "gpt-image-1",
          "mimo-v2.5-tts",
          "music-2.6",
          "doubao-seedance-2-0-260128",
        ],
      },
    });
    const reg = makeRegistry();

    expect(reg.getModelsByType("test-provider", "image")).toEqual([]);
    expect(reg.getModelsByType("test-provider", "audio")).toEqual([]);
    expect(reg.getModelsByType("test-provider", "music")).toEqual([]);
    expect(reg.getModelsByType("test-provider", "video")).toEqual([]);
  });

  it("keeps explicitly typed generic media model objects", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: [
          { id: "gpt-image-1", type: "image", name: "GPT Image 1" },
          { id: "mimo-v2.5-tts", type: "audio", name: "MiMo TTS" },
          { id: "music-2.6", type: "music", name: "Music 2.6" },
          { id: "doubao-seedance-2-0-260128", type: "video", name: "Seedance" },
        ],
      },
    });
    const reg = makeRegistry();

    expect(reg.getModelsByType("test-provider", "image")).toEqual([
      { id: "gpt-image-1", name: "GPT Image 1", type: "image" },
    ]);
    expect(reg.getModelsByType("test-provider", "audio")).toEqual([
      { id: "mimo-v2.5-tts", name: "MiMo TTS", type: "audio" },
    ]);
    expect(reg.getModelsByType("test-provider", "music")).toEqual([
      { id: "music-2.6", name: "Music 2.6", type: "music" },
    ]);
    expect(reg.getModelsByType("test-provider", "video")).toEqual([
      { id: "doubao-seedance-2-0-260128", name: "Seedance", type: "video" },
    ]);
  });

  it("keeps explicitly configured media models", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["chat-model"],
        media: {
          image_generation: {
            models: [{ id: "gpt-image-1", name: "GPT Image 1" }],
          },
          video_generation: {
            models: [{ id: "doubao-seedance-2-0-260128", name: "Seedance" }],
          },
        },
      },
    });
    const reg = makeRegistry();

    expect(reg.getModelsByType("test-provider", "image")).toEqual([
      { id: "gpt-image-1", name: "GPT Image 1", type: "image", protocolId: "openai-images" },
    ]);
    expect(reg.getModelsByType("test-provider", "video")).toEqual([
      { id: "doubao-seedance-2-0-260128", name: "Seedance", type: "video" },
    ]);
  });

  it("keeps explicitly configured top-level media model fields", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["chat-model"],
        imageModels: [{ id: "gpt-image-1", name: "GPT Image 1" }],
        speechModels: [{ id: "mimo-v2.5-tts", name: "MiMo TTS" }],
        musicModels: [{ id: "music-2.6", name: "Music 2.6" }],
        videoModels: [{ id: "doubao-seedance-2-0-260128", name: "Seedance" }],
      },
    });
    const reg = makeRegistry();

    expect(reg.getModelsByType("test-provider", "image")).toEqual([
      { id: "gpt-image-1", name: "GPT Image 1", type: "image", protocolId: "openai-images" },
    ]);
    expect(reg.getModelsByType("test-provider", "audio")).toEqual([
      { id: "mimo-v2.5-tts", name: "MiMo TTS", type: "audio" },
    ]);
    expect(reg.getModelsByType("test-provider", "music")).toEqual([
      { id: "music-2.6", name: "Music 2.6", type: "music" },
    ]);
    expect(reg.getModelsByType("test-provider", "video")).toEqual([
      { id: "doubao-seedance-2-0-260128", name: "Seedance", type: "video" },
    ]);
  });

  it("returns empty array for provider with no image models", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["chat-model"],
      },
    });
    const reg = makeRegistry();
    expect(reg.getModelsByType("test-provider", "image")).toEqual([]);
  });
});

// ── getAllModelsByType ─────────────────────────────────────────────────────────

describe("getAllModelsByType", () => {
  it("aggregates image models across providers", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-a",
        models: [{ id: "img-a", type: "image" }],
      },
      "other-provider": {
        api_key: "key-b",
        models: [{ id: "img-b", type: "image" }, "chat-b"],
      },
    });
    const reg = makeRegistry();
    reg._plugins.set("other-provider", {
      id: "other-provider", displayName: "Other", authType: "api-key",
      defaultBaseUrl: "https://other.com", defaultApi: "openai-completions",
    });

    const all = reg.getAllModelsByType("image");
    expect(all).toHaveLength(2);
    expect(all.map(m => m.id).sort()).toEqual(["img-a", "img-b"]);
    expect(all.every(m => m.provider)).toBe(true);
  });
});

// ── removeProvider ───────────────────────────────────────────────────────────

describe("removeProvider", () => {
  it("deletes a provider entry", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
      "keep-me": { api_key: "sk-y" },
    });
    const reg = makeRegistry();
    reg.removeProvider("test-provider");

    const persisted = readAddedModels();
    expect(persisted["test-provider"]).toBeUndefined();
    expect(persisted["keep-me"]).toBeDefined();
  });

  it("keeps explicitly deleted built-in providers hidden until they are saved again", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
    });
    const reg = makeRegistry();

    reg.removeProvider("test-provider");
    reg.reload();

    expect(reg.get("test-provider")).toBeNull();
    expect([...reg.getAll().keys()]).not.toContain("test-provider");
    expect(readProviderCatalogMeta().deletedProviders).toContain("test-provider");

    reg.saveProvider("test-provider", { api_key: "sk-new" });
    reg.reload();

    expect(reg.get("test-provider")).toMatchObject({
      id: "test-provider",
      api: "openai-completions",
    });
    expect(readProviderCatalogMeta().deletedProviders || []).not.toContain("test-provider");
  });

  it("does not throw when deleting a missing provider", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    expect(() => reg.removeProvider("nonexistent")).not.toThrow();
  });
});
