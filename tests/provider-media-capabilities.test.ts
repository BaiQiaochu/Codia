import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderRegistry } from "../core/provider-registry.js";

let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codia-provider-media-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("ProviderRegistry media capabilities", () => {
  it("exposes user media.image_generation models through the by-type model listing", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "custom-media": {
          api_key: "local",
          base_url: "http://127.0.0.1:1234/v1",
          api: "openai-completions",
          models: ["chat-model"],
          media: {
            image_generation: {
              models: [{ id: "gptimage2", name: "GPT Image 2" }],
            },
          },
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);

    expect(registry.getModelsByType("custom-media", "image")).toEqual([
      { id: "gptimage2", name: "GPT Image 2", type: "image", protocolId: "openai-images" },
    ]);
    expect(registry.getAllModelsByType("image")).toEqual([
      { provider: "custom-media", id: "gptimage2", name: "GPT Image 2", type: "image", protocolId: "openai-images" },
    ]);
    expect(registry.getModelsByType("custom-media", "chat")).toEqual([
      { id: "chat-model", name: "chat-model", type: "chat" },
    ]);
  });

  it("infers OpenAI image protocol for custom OpenAI-compatible image providers", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "custom-openai-images": {
          api_key: "local",
          base_url: "http://127.0.0.1:1234/v1",
          api: "openai-completions",
          models: ["chat-model"],
          media: {
            image_generation: {
              models: [{ id: "flux-1.1-pro", name: "FLUX 1.1 Pro" }],
            },
          },
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);

    expect(registry.getMediaModels("custom-openai-images", "image_generation")).toEqual([
      expect.objectContaining({
        id: "flux-1.1-pro",
        displayName: "FLUX 1.1 Pro",
        protocolId: "openai-images",
      }),
    ]);
    expect(registry.resolveMediaModel({
      providerId: "custom-openai-images",
      modelId: "flux-1.1-pro",
      capability: "image_generation",
    })).toMatchObject({
      providerId: "custom-openai-images",
      model: { protocolId: "openai-images" },
    });
  });

  it("keeps image-only models in media.image_generation when model metadata is updated", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "custom-media": {
          api_key: "local",
          base_url: "http://127.0.0.1:1234/v1",
          api: "openai-completions",
          models: ["chat-model"],
          media: {
            image_generation: {
              models: [{ id: "gptimage2", name: "GPT Image 2" }],
            },
          },
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.updateModelEntry("custom-media", "gptimage2", {
      type: "image",
      name: "GPT Image 2 Plus",
    });

    const raw = registry.getAllProvidersRaw() as Record<string, any>;
    expect(raw["custom-media"].models).toEqual(["chat-model"]);
    expect(raw["custom-media"].media.image_generation.models).toEqual([
      { id: "gptimage2", name: "GPT Image 2 Plus" },
    ]);

    const reloaded = new ProviderRegistry(tmpHome);
    expect(reloaded.getModelsByType("custom-media", "image")).toEqual([
      { id: "gptimage2", name: "GPT Image 2 Plus", type: "image", protocolId: "openai-images" },
    ]);
  });

  it("exposes explicit speech and music media models through by-type listings", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "custom-media": {
          api_key: "local",
          base_url: "http://127.0.0.1:1234/v1",
          api: "openai-completions",
          models: ["mimo-v2.5-tts", "music-2.6"],
          media: {
            speech_generation: {
              models: [{ id: "voice-plus", name: "Voice Plus", protocolId: "openai-audio-speech" }],
            },
            music_generation: {
              models: [{ id: "song-plus", name: "Song Plus", protocolId: "openai-compatible-music" }],
            },
          },
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);

    expect(registry.getModelsByType("custom-media", "audio")).toEqual([
      { id: "voice-plus", name: "Voice Plus", type: "audio", protocolId: "openai-audio-speech" },
    ]);
    expect(registry.getModelsByType("custom-media", "music")).toEqual([
      { id: "song-plus", name: "Song Plus", type: "music", protocolId: "openai-compatible-music" },
    ]);
  });

  it("removes image-only models from media.image_generation so media defaults cannot resurrect them", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        minimax: {
          api_key: "sk-minimax",
          base_url: "https://api.minimax.io",
          api: "anthropic-messages",
          models: ["minimax-m2"],
          media: {
            image_generation: {
              models: [{ id: "image-01", name: "MiniMax Image 01" }],
            },
          },
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.removeModel("minimax", "image-01");

    const raw = registry.getAllProvidersRaw() as Record<string, any>;
    expect(raw.minimax.models).toEqual(["minimax-m2"]);
    expect(raw.minimax.media.image_generation.models).toEqual([]);
    expect(registry.getModelsByType("minimax", "image")).toEqual([]);
    expect(registry.getAllModelsByType("image")).toEqual([]);
  });

  it("exposes OAuth GPT Image 2 as image_generation without projecting the OAuth alias into chat", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const mediaProviders = registry.getMediaProviders("image_generation");
    const codex = mediaProviders.find((provider) => provider.providerId === "openai-codex-oauth");

    expect(codex).toMatchObject({
      providerId: "openai-codex-oauth",
      displayName: "OpenAI Codex (OAuth)",
    });
    expect(codex.models).toContainEqual(expect.objectContaining({
      id: "gpt-image-2",
      displayName: "GPT Image 2",
      protocolId: "openai-codex-responses-image",
    }));
    expect(registry.resolveChatProvider("openai-codex-oauth")).toMatchObject({
      originalProviderId: "openai-codex-oauth",
      providerId: "openai-codex",
      projection: "sdk-auth-alias",
    });
  });

  it("keeps Volcengine Seedream image models from the built-in provider registry", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const models = registry.getMediaModels("volcengine", "image_generation");

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "doubao-seedream-5-0-lite-260128",
        displayName: "Seedream 5.0 Lite",
        protocolId: "volcengine-images",
      }),
      expect.objectContaining({
        id: "doubao-seedream-4-5-251128",
        displayName: "Seedream 4.5",
        protocolId: "volcengine-images",
      }),
    ]));
  });

  it("keeps Gemini image models from the built-in provider registry", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const models = registry.getMediaModels("gemini", "image_generation");

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "gemini-3.1-flash-image-preview",
        displayName: "Gemini 3.1 Flash Image Preview",
        protocolId: "gemini-generate-content-image",
      }),
      expect.objectContaining({
        id: "gemini-3-pro-image-preview",
        displayName: "Gemini 3 Pro Image Preview",
        protocolId: "gemini-generate-content-image",
      }),
    ]));
  });

  it("keeps MiniMax image models from the built-in provider registry", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const models = registry.getMediaModels("minimax", "image_generation");

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "image-01",
        displayName: "MiniMax Image 01",
        protocolId: "minimax-images",
      }),
      expect.objectContaining({
        id: "image-01-live",
        displayName: "MiniMax Image 01 Live",
        protocolId: "minimax-images",
      }),
    ]));
  });

  it("keeps Agnes image and video models from the built-in provider registry", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    expect(registry.get("agnes")).toMatchObject({
      id: "agnes",
      displayName: "Agnes AI",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      api: "openai-completions",
    });
    expect(registry.getMediaModels("agnes", "image_generation")).toEqual([
      expect.objectContaining({
        id: "agnes-image-2.1-flash",
        displayName: "Agnes Image 2.1 Flash",
        protocolId: "agnes-images",
        inputs: ["text", "image"],
        outputs: ["image"],
      }),
    ]);
    expect(registry.getMediaModels("agnes", "video_generation")).toEqual([
      expect.objectContaining({
        id: "agnes-video-v2.0",
        displayName: "Agnes Video V2.0",
        protocolId: "agnes-videos",
        inputs: ["text", "image"],
        outputs: ["video"],
        supportsAsync: true,
      }),
    ]);
  });

  it("keeps Zhipu Coding Plan as a separate OpenAI-compatible provider lane", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    expect(registry.get("zhipu-coding")).toMatchObject({
      id: "zhipu-coding",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      api: "openai-completions",
    });
    expect(registry.getDefaultModels("zhipu-coding")).toEqual([
      "glm-5.2",
      "glm-5-turbo",
      "glm-4.7",
      "glm-4.5-air",
    ]);
  });

  it("normalizes plugin-contributed CLI media providers into the same registry", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.registerProviderContribution({
      id: "jimeng-cli",
      displayName: "Jimeng CLI",
      authType: "none",
      _pluginId: "jimeng",
      runtime: {
        kind: "browser-cli",
        protocolId: "browser-cli-media",
        command: {
          executable: "opencli",
          args: [
            { literal: "jimeng" },
            { literal: "generate" },
            { option: "--prompt", from: "prompt" },
            { option: "--model", from: "modelId" },
            { option: "--output", from: "outputDir" },
          ],
          timeoutMs: 120000,
          output: { kind: "file_glob", directory: "outputDir", pattern: "*.png" },
        },
      },
      capabilities: {
        chat: {
          projection: "none",
          runtimeProviderId: "jimeng-cli",
          displayProviderId: "jimeng-cli",
        },
        media: {
          imageGeneration: {
            models: [{
              id: "high_aes_general_v50",
              displayName: "Jimeng 5.0 Lite",
              protocolId: "browser-cli-media",
              inputs: ["text", "image"],
              outputs: ["image"],
            }],
          },
        },
      },
    });
    registry.reload();

    expect(registry.get("jimeng-cli")).toMatchObject({
      id: "jimeng-cli",
      source: { kind: "plugin", pluginId: "jimeng" },
      runtime: expect.objectContaining({ kind: "browser-cli" }),
    });
    expect(registry.getMediaModels("jimeng-cli", "image_generation")).toEqual([
      expect.objectContaining({
        id: "high_aes_general_v50",
        displayName: "Jimeng 5.0 Lite",
        protocolId: "browser-cli-media",
      }),
    ]);
    expect(registry.resolveMediaModel({
      providerId: "jimeng-cli",
      modelId: "high_aes_general_v50",
      capability: "image_generation",
    })).toMatchObject({
      providerId: "jimeng-cli",
      runtime: expect.objectContaining({ kind: "browser-cli" }),
      model: expect.objectContaining({ id: "high_aes_general_v50" }),
    });
    expect(registry.resolveChatProvider("jimeng-cli")).toMatchObject({
      providerId: "jimeng-cli",
      projection: "none",
    });
  });
});
