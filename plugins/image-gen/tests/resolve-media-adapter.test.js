import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../lib/adapter-registry.js";
import { resolveMediaAdapter } from "../lib/resolve-media-adapter.js";

describe("resolveMediaAdapter", () => {
  it("routes OpenAI-compatible video providers through the generic media adapter", async () => {
    const registry = new AdapterRegistry();
    const toapisVideoAdapter = { id: "toapis-video", types: ["video"] };
    const genericMediaAdapter = { id: "openai-compatible-media", types: ["audio", "music", "video"] };
    registry.register(toapisVideoAdapter);
    registry.register(genericMediaAdapter);

    const result = await resolveMediaAdapter({
      registry,
      type: "video",
      inputProvider: "custom-toapis",
      bus: {
        request: async (type, payload) => {
          if (type === "provider:credentials" && payload.providerId === "custom-toapis") {
            return {
              api: "openai-completions",
              apiKey: "sk-test",
              baseUrl: "https://toapis.com/v1",
            };
          }
          return { error: "not_found" };
        },
      },
    });

    expect(result).toEqual({
      adapter: genericMediaAdapter,
      providerId: "custom-toapis",
      modelId: null,
      model: null,
    });
  });

  it("routes yh.m7ai.com video gateways through the generic media adapter", async () => {
    const registry = new AdapterRegistry();
    const toapisVideoAdapter = { id: "toapis-video", types: ["video"] };
    const genericMediaAdapter = { id: "openai-compatible-media", types: ["audio", "music", "video"] };
    registry.register(toapisVideoAdapter);
    registry.register(genericMediaAdapter);

    const result = await resolveMediaAdapter({
      registry,
      type: "video",
      inputProvider: "video-gateway",
      bus: {
        request: async (type, payload) => {
          if (type === "provider:credentials" && payload.providerId === "video-gateway") {
            return {
              api: "openai-completions",
              apiKey: "sk-test",
              baseUrl: "https://yh.m7ai.com/v1",
            };
          }
          return { error: "not_found" };
        },
      },
    });

    expect(result).toEqual({
      adapter: genericMediaAdapter,
      providerId: "video-gateway",
      modelId: null,
      model: null,
    });
  });

  it.each([
    ["audio", "custom-audio", "tts-plus"],
    ["music", "custom-music", "song-plus"],
    ["video", "custom-video", "motion-plus"],
  ])("falls back to configured %s models when the stored default provider is stale", async (mediaType, providerId, modelId) => {
    const registry = new AdapterRegistry();
    const genericMediaAdapter = { id: "openai-compatible-media", types: ["audio", "music", "video"] };
    registry.register(genericMediaAdapter);

    const result = await resolveMediaAdapter({
      registry,
      type: mediaType,
      inputProvider: "",
      defaultModel: { provider: "legacy-provider", id: "legacy-model" },
      bus: {
        request: async (type, payload) => {
          if (type === "provider:models-by-type" && payload.type === mediaType) {
            return { models: [{ provider: providerId, id: modelId, type: mediaType }] };
          }
          if (type === "provider:credentials" && payload.providerId === providerId) {
            return {
              api: "openai-completions",
              apiKey: "sk-test",
              baseUrl: "https://example.com/v1",
            };
          }
          return { error: "not_found" };
        },
      },
    });

    expect(result).toEqual({
      adapter: genericMediaAdapter,
      providerId,
      modelId,
      model: { provider: providerId, id: modelId, type: mediaType },
    });
  });

  it("does not auto-select a bundled adapter when no media provider is configured", async () => {
    const registry = new AdapterRegistry();
    const genericMediaAdapter = { id: "openai-compatible-media", types: ["audio", "music", "video"] };
    const bundledVideoAdapter = { id: "volcengine-video", types: ["video"] };
    registry.register(genericMediaAdapter);
    registry.register(bundledVideoAdapter);

    const result = await resolveMediaAdapter({
      registry,
      type: "video",
      inputProvider: "",
      defaultModel: null,
      bus: {
        request: async (type) => {
          if (type === "provider:models-by-type") return { models: [] };
          if (type === "provider:catalog") return { providers: [] };
          return { error: "not_found" };
        },
      },
    });

    expect(result).toEqual({
      adapter: null,
      providerId: null,
      modelId: null,
      model: null,
    });
  });
});
