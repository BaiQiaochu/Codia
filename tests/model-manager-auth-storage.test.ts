// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { ModelManager } from "../core/model-manager.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-model-manager-auth-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAddedModels(providers) {
  fs.writeFileSync(
    path.join(tmpDir, "added-models.yaml"),
    YAML.dump({ providers }),
    "utf-8",
  );
}

function writeAuth(data) {
  fs.writeFileSync(
    path.join(tmpDir, "auth.json"),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

function writeModelsJson(data) {
  fs.writeFileSync(
    path.join(tmpDir, "models.json"),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

function deepseekProvider(apiKey) {
  const provider = {
    base_url: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: ["deepseek-v4-pro"],
  };
  if (apiKey !== undefined) provider.api_key = apiKey;
  return provider;
}

function chatgptProvider(apiKey) {
  const provider = {
    base_url: "https://api.openai.com/v1",
    api: "openai-completions",
    models: ["gpt-managed"],
  };
  if (apiKey !== undefined) provider.api_key = apiKey;
  return provider;
}

async function getModelApiKey(manager, provider, modelId) {
  const model = manager.modelRegistry.find(provider, modelId);
  expect(model).toBeTruthy();
  const auth = await manager.modelRegistry.getApiKeyAndHeaders(model);
  expect(auth.ok).toBe(true);
  return auth.apiKey;
}

async function getModelAuth(manager, provider, modelId) {
  const model = manager.modelRegistry.find(provider, modelId);
  expect(model).toBeTruthy();
  const auth = await manager.modelRegistry.getApiKeyAndHeaders(model);
  expect(auth.ok).toBe(true);
  return auth;
}

async function getDeepseekApiKey(manager) {
  const model = manager.modelRegistry.find("deepseek", "deepseek-v4-pro");
  expect(model).toBeTruthy();
  const auth = await manager.modelRegistry.getApiKeyAndHeaders(model);
  expect(auth.ok).toBe(true);
  return auth.apiKey;
}

describe("ModelManager ModelRuntime credential ownership", () => {
  it("uses only the selected provider credentials across provider A -> B -> A", async () => {
    writeAuth({});
    writeAddedModels({
      "provider-a": {
        base_url: "https://a.example/v1",
        api: "openai-completions",
        api_key: "sk-provider-a",
        headers: { "X-Provider-Credential": "header-a" },
        models: ["shared-model"],
      },
      "provider-b": {
        base_url: "https://b.example/v1",
        api: "openai-completions",
        api_key: "sk-provider-b",
        headers: { "X-Provider-Credential": "header-b" },
        models: ["shared-model"],
      },
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    await manager.init();
    await manager.syncAndRefresh();

    const sequence = ["provider-a", "provider-b", "provider-a"];
    const observed = [];
    for (const provider of sequence) {
      const auth = await getModelAuth(manager, provider, "shared-model");
      observed.push({
        provider,
        apiKey: auth.apiKey,
        headers: auth.headers,
      });
    }

    expect(observed).toEqual([
      { provider: "provider-a", apiKey: "sk-provider-a", headers: { "X-Provider-Credential": "header-a" } },
      { provider: "provider-b", apiKey: "sk-provider-b", headers: { "X-Provider-Credential": "header-b" } },
      { provider: "provider-a", apiKey: "sk-provider-a", headers: { "X-Provider-Credential": "header-a" } },
    ]);
  });

  it("quarantines unsafe credentials loaded from legacy provider config", async () => {
    writeAuth({});
    writeAddedModels({
      legacy: {
        base_url: "https://legacy.example/v1",
        api: "openai-completions",
        api_key: "sk-中文-legacy",
        headers: {
          "X-Safe": "safe-value",
          "X-Legacy": "历史脏数据",
          "X-Injected": "safe\r\nX-Evil: injected",
        },
        models: ["legacy-model"],
      },
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    await manager.init();
    await manager.syncAndRefresh();

    expect(manager.resolveProviderCredentials("legacy")).toEqual(expect.objectContaining({
      api_key: "",
      headers: { "X-Safe": "safe-value" },
    }));
    const projected = fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8");
    expect(projected).not.toContain("中文");
    expect(projected).not.toContain("历史脏数据");
    expect(projected).not.toContain("X-Evil");

    const auth = await getModelAuth(manager, "legacy", "legacy-model");
    expect(auth.apiKey).toBeUndefined();
    expect(auth.headers).toEqual({ "X-Safe": "safe-value" });
    expect(() => new Headers(auth.headers)).not.toThrow();
  });

  it("injects added-models API keys as runtime overrides before Pi SDK env resolution", async () => {
    const originalPublic = process.env.PUBLIC;
    process.env.PUBLIC = "C:\\Users\\Public";
    try {
      writeAuth({});
      writeAddedModels({
        deepseek: deepseekProvider("public"),
      });

      const manager = new ModelManager({ gsapHome: tmpDir });
      await manager.init();
      await manager.syncAndRefresh();

      await expect(getDeepseekApiKey(manager)).resolves.toBe("public");
      const projected = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8"));
      expect(projected.providers.deepseek.apiKey).toBeUndefined();
    } finally {
      if (originalPublic === undefined) delete process.env.PUBLIC;
      else process.env.PUBLIC = originalPublic;
    }
  });

  it("resolves managed provider runtime API key refs from current provider credentials", async () => {
    writeAuth({});
    writeAddedModels({
      chatgpt: chatgptProvider("sk-chatgpt-old"),
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    await manager.init();
    await manager.syncAndRefresh();

    const projected = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8"));
    expect(projected.providers.chatgpt.apiKey).toBeUndefined();

    await manager.modelRuntime.removeRuntimeApiKey("chatgpt");
    await expect(manager.modelRuntime.getAuth(manager.modelRuntime.getModel("chatgpt", "gpt-managed")))
      .rejects.toMatchObject({ code: "auth" });

    manager.providerRegistry.saveProvider("chatgpt", chatgptProvider("sk-chatgpt-new"));
    await manager.modelRuntime.setRuntimeApiKey("chatgpt", "sk-chatgpt-old");
    await manager.syncAndRefresh();
    await expect(getModelApiKey(manager, "chatgpt", "gpt-managed")).resolves.toBe("sk-chatgpt-new");
  });

  it("does not overwrite a real runtime API key with a projected runtime reference", async () => {
    writeAuth({});
    writeAddedModels({
      chatgpt: chatgptProvider("gsap-runtime-api-key:chatgpt"),
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    await manager.init();
    await manager.syncAndRefresh();

    await manager.modelRuntime.setRuntimeApiKey("chatgpt", "sk-chatgpt-real");

    await expect(getModelApiKey(manager, "chatgpt", "gpt-managed")).resolves.toBe("sk-chatgpt-real");
  });

  it("migrates legacy API-key auth into added-models before clearing auth.json", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-legacy-4d2a" },
    });
    writeAddedModels({
      deepseek: deepseekProvider(undefined),
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    await manager.init();
    await manager.syncAndRefresh();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-legacy-4d2a");
    const persistedProviders = YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8")).providers;
    expect(persistedProviders.deepseek.api_key).toBe("sk-legacy-4d2a");
    const persistedAuth = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    expect(persistedAuth.deepseek).toBeUndefined();
  });

  it("recovers a legacy API key from models.json when auth.json was already cleaned", async () => {
    writeAuth({});
    writeAddedModels({
      deepseek: deepseekProvider(undefined),
    });
    writeModelsJson({
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          api: "openai-completions",
          apiKey: "sk-projected-6ad1",
          models: [{ id: "deepseek-v4-pro" }],
        },
      },
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    await manager.init();
    await manager.syncAndRefresh();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-projected-6ad1");
    const persistedProviders = YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8")).providers;
    expect(persistedProviders.deepseek.api_key).toBe("sk-projected-6ad1");
  });

  it("API-key provider runtime lookup uses added-models credentials over stale auth.json", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-old-3ffa" },
    });
    writeAddedModels({
      deepseek: deepseekProvider("sk-new-999c"),
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    await manager.init();
    await manager.syncAndRefresh();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-new-999c");
    const persistedAuth = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    expect(persistedAuth.deepseek).toBeUndefined();
  });

  it("does not resurrect an explicitly cleared added-models API key", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-old-3ffa" },
    });
    writeAddedModels({
      deepseek: deepseekProvider(""),
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    await manager.init();
    await manager.syncAndRefresh();

    const persistedProviders = YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8")).providers;
    expect(persistedProviders.deepseek.api_key).toBe("");
    const persistedAuth = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    expect(persistedAuth.deepseek).toBeUndefined();
    expect(manager.availableModels.filter((m) => m.provider === "deepseek")).toHaveLength(0);
  });

  it("reloadAndSync clears stale in-memory API-key auth before refreshing models", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-old-3ffa" },
    });
    writeAddedModels({
      deepseek: deepseekProvider("sk-new-999c"),
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    await manager.init();
    writeAuth({});

    await manager.reloadAndSync();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-new-999c");
  });

  it("refreshes OAuth credentials before resolving provider credentials for media adapters", async () => {
    writeAddedModels({
      "openai-codex-oauth": {
        models: ["gpt-5.5"],
      },
    });
    writeAuth({
      "openai-codex": {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-token",
        expires: Date.now() - 10_000,
        resourceUrl: "https://chatgpt.com/backend-api",
        accountId: "acct_123",
      },
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    manager.providerRegistry.reload();
    manager._modelRuntime = {
      getModels: () => [{ id: "gpt-5.5", provider: "openai-codex-oauth" }],
      getAuth: vi.fn(async () => ({ auth: { apiKey: "fresh-token" } })),
    };

    const creds = await manager.resolveProviderCredentialsFresh("openai-codex-oauth");

    expect(manager._modelRuntime.getAuth).toHaveBeenCalled();
    expect(creds).toEqual(expect.objectContaining({
      api_key: "fresh-token",
      base_url: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      accountId: "acct_123",
    }));
  });

  it("does not return a stale OAuth token when refresh fails", async () => {
    writeAddedModels({
      "openai-codex-oauth": {
        models: ["gpt-5.5"],
      },
    });
    writeAuth({
      "openai-codex": {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-token",
        expires: Date.now() - 10_000,
      },
    });

    const manager = new ModelManager({ gsapHome: tmpDir });
    manager.providerRegistry.reload();
    manager._modelRuntime = {
      getModels: () => [{ id: "gpt-5.5", provider: "openai-codex-oauth" }],
      getAuth: vi.fn(async () => undefined),
    };

    const creds = await manager.resolveProviderCredentialsFresh("openai-codex-oauth");

    expect(creds.api_key).toBe("");
  });
});
