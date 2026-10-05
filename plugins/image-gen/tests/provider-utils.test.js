import { describe, it, expect } from "vitest";
import {
  buildMediaProviders,
  normalizeProviderModels,
  isOpenAICompatibleApi,
} from "../lib/provider-utils.js";

describe("provider-utils", () => {
  it("hides custom openai-compatible providers until media models are imported", () => {
    const providers = buildMediaProviders({
      catalog: [
        {
          id: "custom-image",
          displayName: "Custom Image",
          api: "openai-completions",
          isBuiltin: false,
          isConfigured: true,
          hasCredentials: true,
          models: [],
        },
      ],
      imageModels: [],
    });

    expect(providers["custom-image"]).toBeUndefined();
  });

  it("shows imported provider models without merging preset candidates", () => {
    const providers = buildMediaProviders({
      catalog: [
        {
          id: "openrouter",
          displayName: "OpenRouter",
          api: "openai-completions",
          isBuiltin: true,
          isConfigured: true,
          hasCredentials: true,
          models: [
            { id: "img-alpha", name: "IMG Alpha" },
            "img-beta",
          ],
        },
      ],
      imageModels: [
        { provider: "openrouter", id: "img-alpha", name: "IMG Alpha" },
        { provider: "openrouter", id: "img-beta", name: "img-beta" },
      ],
    });

    expect(providers.openrouter).toBeDefined();
    expect(providers.openrouter.imageModels.map((model) => model.id)).toEqual([
      "img-alpha",
      "img-beta",
    ]);
    expect(providers.openrouter.availableModels.map((model) => model.id)).toEqual([]);
  });

  it("keeps imported image models actual-only for providers that have known presets", () => {
    const providers = buildMediaProviders({
      catalog: [
        {
          id: "openai",
          displayName: "OpenAI",
          api: "openai-completions",
          isBuiltin: true,
          isConfigured: true,
          hasCredentials: true,
          models: [
            { id: "gptimage2", name: "GPT Image 2 Alias" },
            { id: "flux-1-dev" },
            { id: "gpt-4.1" },
          ],
        },
      ],
      imageModels: [
        { provider: "openai", id: "gptimage2", name: "GPT Image 2 Alias" },
        { provider: "openai", id: "flux-1-dev" },
      ],
    });

    const ids = providers.openai.imageModels.map((model) => model.id);
    expect(ids).toContain("gptimage2");
    expect(ids).toContain("flux-1-dev");
    expect(ids).not.toContain("gpt-4.1");
    expect(providers.openai.availableImageModels.map((model) => model.id)).not.toContain("gpt-image-2");
  });

  it("does not expose inferred image candidates before they are imported", () => {
    const providers = buildMediaProviders({
      catalog: [
        {
          id: "openai",
          displayName: "OpenAI",
          api: "openai-completions",
          isBuiltin: false,
          isConfigured: true,
          hasCredentials: true,
          models: [
            { id: "text-to-image-pro" },
            { id: "txt2img-xl" },
            { id: "img2img-edit" },
            { id: "chat-model" },
          ],
        },
      ],
      imageModels: [],
    });

    expect(providers.openai).toBeUndefined();
  });

  it("does not inject preset providers before models are imported", () => {
    const providers = buildMediaProviders({ catalog: [], imageModels: [] });
    expect(providers).toEqual({});
  });

  it("marks local openai-compatible providers as credential-ready when models are imported", () => {
    const providers = buildMediaProviders({
      catalog: [
        {
          id: "local-image",
          displayName: "Local Image",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:7860/v1",
          isBuiltin: false,
          isConfigured: true,
          hasCredentials: false,
          models: [{ id: "local-image-model", type: "image" }],
        },
      ],
      imageModels: [{ provider: "local-image", id: "local-image-model", name: "Local Image Model" }],
    });

    expect(providers["local-image"]).toBeDefined();
    expect(providers["local-image"].hasCredentials).toBe(true);
    expect(providers["local-image"].imageModels.map((model) => model.id)).toEqual(["local-image-model"]);
    expect(providers["local-image"].availableModels).toEqual([]);
  });

  it("normalizes mixed provider model entries", () => {
    expect(normalizeProviderModels([
      "model-a",
      { id: "model-b", name: "Model B" },
      null,
      { id: "" },
    ])).toEqual([
      { id: "model-a", name: "model-a" },
      { id: "model-b", name: "Model B" },
    ]);
  });

  it("preserves explicit media model types and dedupes by type", () => {
    const providers = buildMediaProviders({
      catalog: [
        {
          id: "minimax",
          displayName: "MiniMax",
          api: "anthropic-messages",
          isBuiltin: true,
          isConfigured: true,
          hasCredentials: true,
          models: [
            { id: "image-01", type: "image" },
            { id: "speech-2.8-hd", type: "audio" },
            { id: "music-2.6", type: "music" },
            { id: "doubao-seedance-2-0-260128", type: "video" },
            { id: "MiniMax-M2.7" },
          ],
        },
      ],
      imageModels: [{ provider: "minimax", id: "image-01", name: "MiniMax Image 01" }],
      audioModels: [{ provider: "minimax", id: "speech-2.8-hd", name: "MiniMax Speech 2.8 HD" }],
      musicModels: [{ provider: "minimax", id: "music-2.6", name: "MiniMax Music 2.6" }],
      videoModels: [{ provider: "minimax", id: "doubao-seedance-2-0-260128", name: "Seedance 2.0" }],
    });

    expect(providers.minimax.imageModels).toEqual([]);
    expect(providers.minimax.audioModels).toEqual([
      { id: "speech-2.8-hd", name: "MiniMax Speech 2.8 HD", type: "audio" },
    ]);
    expect(providers.minimax.musicModels).toEqual([
      { id: "music-2.6", name: "MiniMax Music 2.6", type: "music" },
    ]);
    expect(providers.minimax.videoModels).toEqual([
      { id: "doubao-seedance-2-0-260128", name: "Seedance 2.0", type: "video" },
    ]);
    expect(providers.minimax.availableImageModels.map((model) => model.id)).not.toContain("MiniMax-M2.7");
    expect(providers.minimax.availableImageModels.map((model) => model.id)).not.toContain("image-01");
  });

  it("keeps imported video models separate from imported image models", () => {
    const providers = buildMediaProviders({
      catalog: [
        {
          id: "custom-media",
          displayName: "Custom Media",
          api: "openai-completions",
          isBuiltin: false,
          isConfigured: true,
          hasCredentials: true,
          models: [
            { id: "doubao-seedance-2-0-260128" },
            { id: "local-unknown-model" },
          ],
        },
      ],
      imageModels: [{ provider: "custom-media", id: "local-unknown-model" }],
      videoModels: [{ provider: "custom-media", id: "doubao-seedance-2-0-260128" }],
    });

    expect(providers["custom-media"].videoModels.map((model) => model.id)).toContain("doubao-seedance-2-0-260128");
    expect(providers["custom-media"].imageModels.map((model) => model.id)).toContain("local-unknown-model");
    expect(providers["custom-media"].imageModels.map((model) => model.id)).not.toContain("doubao-seedance-2-0-260128");
  });

  it("allows the same model id in different media types", () => {
    const providers = buildMediaProviders({
      catalog: [
        {
          id: "custom-media",
          displayName: "Custom Media",
          api: "openai-completions",
          isBuiltin: false,
          isConfigured: true,
          hasCredentials: true,
          models: [
            { id: "shared-model", type: "image" },
            { id: "shared-model", type: "audio" },
          ],
        },
      ],
      imageModels: [{ provider: "custom-media", id: "shared-model" }],
      audioModels: [{ provider: "custom-media", id: "shared-model" }],
    });

    expect(providers["custom-media"].imageModels).toHaveLength(1);
    expect(providers["custom-media"].audioModels).toHaveLength(1);
  });

  it("recognizes openai-compatible api format", () => {
    expect(isOpenAICompatibleApi("openai-completions")).toBe(true);
    expect(isOpenAICompatibleApi("anthropic-messages")).toBe(false);
  });
});
