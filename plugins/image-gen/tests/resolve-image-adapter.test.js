import { describe, it, expect } from "vitest";
import { AdapterRegistry } from "../lib/adapter-registry.js";
import { resolveImageAdapter } from "../lib/resolve-image-adapter.js";

const directAdapter = {
  id: "openai",
  name: "OpenAI",
  types: ["image"],
};

describe("resolveImageAdapter", () => {
  it("prefers a directly registered adapter", async () => {
    const registry = new AdapterRegistry();
    registry.register(directAdapter);

    const resolved = await resolveImageAdapter({
      registry,
      bus: { request: async () => ({ error: "unused" }) },
      inputProvider: "openai",
      defaultImageModel: null,
    });

    expect(resolved.adapter).toBe(directAdapter);
    expect(resolved.providerId).toBe("openai");
    expect(resolved.source).toBe("direct");
  });

  it("falls back to openai-compatible adapter for custom providers", async () => {
    const registry = new AdapterRegistry();

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async ({ providerId }) => ({
          providerId,
          api: "openai-completions",
          apiKey: "sk-test",
        }),
      },
      inputProvider: "custom-image",
      defaultImageModel: null,
    });

    expect(resolved.adapter?.id).toBe("openai-compatible");
    expect(resolved.providerId).toBe("custom-image");
    expect(resolved.source).toBe("openai-compatible");
  });

  it("uses default image provider when no explicit provider is passed", async () => {
    const registry = new AdapterRegistry();

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async () => ({
          api: "openai-completions",
          apiKey: "sk-test",
        }),
      },
      inputProvider: "",
      defaultImageModel: { id: "img-pro", provider: "custom-image" },
    });

    expect(resolved.adapter?.id).toBe("openai-compatible");
    expect(resolved.providerId).toBe("custom-image");
  });

  it("returns missing adapter for unsupported explicit providers", async () => {
    const registry = new AdapterRegistry();

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async () => ({
          api: "anthropic-messages",
          apiKey: "sk-test",
        }),
      },
      inputProvider: "custom-image",
      defaultImageModel: null,
    });

    expect(resolved).toEqual({
      adapter: null,
      providerId: "custom-image",
      modelId: null,
      source: "missing",
    });
  });

  it("does not route image generation to direct adapters that do not support images", async () => {
    const registry = new AdapterRegistry();
    registry.register({ id: "minimax", name: "MiniMax Media", types: ["audio", "music"] });

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async () => ({
          api: "anthropic-messages",
          apiKey: "sk-test",
        }),
      },
      inputProvider: "minimax",
      defaultImageModel: null,
    });

    expect(resolved).toEqual({
      adapter: null,
      providerId: "minimax",
      modelId: null,
      source: "missing",
    });
  });

  it("keeps MiniMax out of image generation even if credentials look OpenAI compatible", async () => {
    const registry = new AdapterRegistry();

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async () => ({
          api: "openai",
          apiKey: "sk-test",
        }),
      },
      inputProvider: "minimax",
      defaultImageModel: null,
    });

    expect(resolved).toEqual({
      adapter: null,
      providerId: "minimax",
      modelId: null,
      source: "missing",
    });
  });

  it("auto-selects a configured image model when no default is set", async () => {
    const registry = new AdapterRegistry();

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async (type, payload) => {
          if (type === "provider:models-by-type" && payload.type === "image") {
            return { models: [{ provider: "sglang", id: "image-model", type: "image" }] };
          }
          if (type === "provider:credentials" && payload.providerId === "sglang") {
            return {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:30000/v1",
            };
          }
          return {};
        },
      },
      inputProvider: "",
      defaultImageModel: null,
    });

    expect(resolved.adapter?.id).toBe("openai-compatible");
    expect(resolved.providerId).toBe("sglang");
    expect(resolved.modelId).toBe("image-model");
    expect(resolved.source).toBe("image-model");
  });

  it("uses an explicit model-only image request before a stale default provider", async () => {
    const registry = new AdapterRegistry();

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async (type, payload) => {
          if (type === "provider:models-by-type" && payload.type === "image") {
            return { models: [{ provider: "image2", id: "gptimage2", type: "image" }] };
          }
          if (type === "provider:credentials" && payload.providerId === "image2") {
            return {
              api: "openai-completions",
              apiKey: "sk-test",
              baseUrl: "https://image2.example/v1",
            };
          }
          return { error: "no_credentials" };
        },
      },
      inputProvider: "",
      inputModel: "gptimage2",
      defaultImageModel: { provider: "minimax", id: "image-01" },
    });

    expect(resolved.adapter?.id).toBe("openai-compatible");
    expect(resolved.providerId).toBe("image2");
    expect(resolved.modelId).toBe("gptimage2");
    expect(resolved.source).toBe("input-model");
  });

  it("falls back to configured image models when the stored default provider is stale", async () => {
    const registry = new AdapterRegistry();

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async (type, payload) => {
          if (type === "provider:models-by-type" && payload.type === "image") {
            return { models: [{ provider: "kskooo", id: "gpt-image-2", type: "image" }] };
          }
          if (type === "provider:credentials" && payload.providerId === "kskooo") {
            return { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://example.com/v1" };
          }
          return { error: "no_credentials" };
        },
      },
      inputProvider: "",
      inputModel: "",
      defaultImageModel: { provider: "minimax", id: "image-01" },
    });

    expect(resolved.adapter?.id).toBe("openai-compatible");
    expect(resolved.providerId).toBe("kskooo");
    expect(resolved.modelId).toBe("gpt-image-2");
    expect(resolved.source).toBe("image-model");
  });

  it("does not treat provider catalog chat models as image generation models", async () => {
    const registry = new AdapterRegistry();

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async (type, payload) => {
          if (type === "provider:models-by-type") return { models: [] };
          if (type === "provider:catalog") {
            return {
              providers: [{
                id: "sglang",
                api: "openai-completions",
                models: [{ id: "local-image-model" }],
              }],
            };
          }
          if (type === "provider:credentials" && payload.providerId === "sglang") {
            return {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:30000/v1",
            };
          }
          return {};
        },
      },
      inputProvider: "",
      defaultImageModel: null,
    });

    expect(resolved).toEqual({
      adapter: null,
      providerId: null,
      modelId: null,
      source: "missing",
    });
  });

  it("does not auto-select known OpenAI image presets without an added image model", async () => {
    const registry = new AdapterRegistry();

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async (type, payload) => {
          if (type === "provider:models-by-type") return { models: [] };
          if (type === "provider:catalog") return { providers: [] };
          if (type === "provider:credentials" && payload.providerId === "openai") {
            return {
              api: "openai-completions",
              apiKey: "sk-test",
              baseUrl: "https://api.openai.com/v1",
            };
          }
          return { error: "no_credentials" };
        },
      },
      inputProvider: "",
      defaultImageModel: null,
    });

    expect(resolved).toEqual({
      adapter: null,
      providerId: null,
      modelId: null,
      source: "missing",
    });
  });

  it("does not auto-select direct local image adapters without an added image model", async () => {
    const registry = new AdapterRegistry();
    const comfyAdapter = { id: "comfyui", name: "ComfyUI", types: ["image"] };
    registry.register(comfyAdapter);

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async (type, payload) => {
          if (type === "provider:models-by-type") return { models: [] };
          if (type === "provider:catalog") return { providers: [] };
          if (type === "provider:credentials" && payload.providerId === "comfyui") {
            return {
              api: "",
              baseUrl: "http://127.0.0.1:8188",
            };
          }
          return { error: "no_credentials" };
        },
      },
      inputProvider: "",
      defaultImageModel: null,
    });

    expect(resolved).toEqual({
      adapter: null,
      providerId: null,
      modelId: null,
      source: "missing",
    });
  });

  it("does not auto-select unconfigured remote known providers", async () => {
    const registry = new AdapterRegistry();
    registry.register(directAdapter);

    const resolved = await resolveImageAdapter({
      registry,
      bus: {
        request: async (type) => {
          if (type === "provider:models-by-type") return { models: [] };
          if (type === "provider:catalog") return { providers: [] };
          return { error: "no_credentials" };
        },
      },
      inputProvider: "",
      defaultImageModel: null,
    });

    expect(resolved).toEqual({
      adapter: null,
      providerId: null,
      modelId: null,
      source: "missing",
    });
  });
});
