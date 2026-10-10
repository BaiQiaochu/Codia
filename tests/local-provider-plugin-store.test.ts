import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  isSafeLocalProviderPluginId,
  isSafeLocalProviderPluginProviderId,
  localProviderPluginStorageId,
  LocalProviderPluginStore,
  providerConfigHasLocalDefinition,
  splitLocalProviderConfig,
} from "../core/local-provider-plugin-store.ts";

let tmpDir: string;

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

describe("LocalProviderPluginStore", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-local-provider-plugin-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates local provider plugin ids as path-safe segments", () => {
    expect(isSafeLocalProviderPluginId("openai-compatible.local")).toBe(true);
    expect(isSafeLocalProviderPluginId("provider_1")).toBe(true);
    expect(isSafeLocalProviderPluginId("../escape")).toBe(false);
    expect(isSafeLocalProviderPluginId("bad\\path")).toBe(false);
    expect(isSafeLocalProviderPluginId("")).toBe(false);
  });

  it("allows provider ids that are safe names but not safe storage segments", () => {
    expect(isSafeLocalProviderPluginProviderId("硅基流动")).toBe(true);
    expect(isSafeLocalProviderPluginProviderId("bad/path")).toBe(false);

    const storageId = localProviderPluginStorageId("硅基流动");
    expect(storageId).toMatch(/^provider-[a-f0-9]{16}$/);
    expect(storageId).not.toBe("硅基流动");
  });

  it("splits provider definition fields from credential overlay fields", () => {
    const { plugin, overlay } = splitLocalProviderConfig("custom", {
      display_name: "Custom API",
      auth_type: "optional",
      base_url: "https://example.test/v1",
      api: "openai-completions",
      models: [{ id: "chat-model" }],
      runtime: { kind: "http", protocolId: "custom-images" },
      capabilities: {
        media: {
          imageGeneration: {
            models: [{ id: "image-model", protocolId: "custom-images" }],
          },
        },
      },
      api_key: "sk-secret",
      headers: { "X-Test": "1" },
    });

    expect(plugin).toMatchObject({
      id: "custom",
      displayName: "Custom API",
      authType: "optional",
      defaultBaseUrl: "https://example.test/v1",
      defaultApi: "openai-completions",
      models: [{ id: "chat-model" }],
      runtime: { kind: "http", protocolId: "custom-images" },
    });
    expect(overlay).toEqual({
      api_key: "sk-secret",
      headers: { "X-Test": "1" },
    });
  });

  it("detects provider definitions in mixed provider config", () => {
    expect(providerConfigHasLocalDefinition({ base_url: "https://example.test/v1" })).toBe(true);
    expect(providerConfigHasLocalDefinition({ api_key: "sk-secret" })).toBe(false);
    expect(providerConfigHasLocalDefinition(null)).toBe(false);
  });

  it("writes and reads provider plugin files", () => {
    const store = new LocalProviderPluginStore(tmpDir);
    const written = store.writeProvider("custom", {
      displayName: "Custom API",
      authType: "api-key",
      defaultBaseUrl: "https://example.test/v1",
      defaultApi: "openai-completions",
      models: ["chat-model"],
      media: {
        imageGeneration: {
          models: [{ id: "image-model", protocolId: "custom-images" }],
        },
      },
    });

    expect(written).toMatchObject({
      id: "custom",
      source: { kind: "local-provider-plugin" },
      capabilities: {
        media: {
          imageGeneration: {
            models: [{ id: "image-model", protocolId: "custom-images" }],
          },
        },
      },
    });

    expect(readJson(store.manifestPath("custom"))).toMatchObject({
      id: "custom",
      type: "provider-plugin",
      schemaVersion: 1,
      provider: "custom",
    });
    expect(readJson(store.providerPath("custom"))).toMatchObject({
      id: "custom",
      displayName: "Custom API",
      models: ["chat-model"],
    });
    expect(store.readAll()).toEqual([
      expect.objectContaining({
        id: "custom",
        source: { kind: "local-provider-plugin" },
      }),
    ]);
  });

  it("stores non-path-safe provider ids under a stable safe storage id", () => {
    const store = new LocalProviderPluginStore(tmpDir);
    const providerId = "硅基流动";
    const storageId = localProviderPluginStorageId(providerId);

    const written = store.writeProvider(providerId, {
      displayName: "硅基流动",
      defaultBaseUrl: "https://api.siliconflow.cn/v1",
      defaultApi: "openai-completions",
      models: ["deepseek-ai/DeepSeek-V3.2"],
    });

    expect(written.id).toBe(providerId);
    expect(readJson(store.manifestPath(providerId))).toMatchObject({
      id: storageId,
      provider: providerId,
    });
    expect(readJson(store.providerPath(providerId))).toMatchObject({
      id: providerId,
      displayName: "硅基流动",
    });
    expect(store.readAll()).toEqual([
      expect.objectContaining({
        id: providerId,
        displayName: "硅基流动",
        source: { kind: "local-provider-plugin" },
      }),
    ]);
  });

  it("removes provider plugin directories", () => {
    const store = new LocalProviderPluginStore(tmpDir);
    store.writeProvider("custom", { displayName: "Custom API" });

    store.removeProvider("custom");

    expect(fs.existsSync(store.providerDir("custom"))).toBe(false);
  });
});
