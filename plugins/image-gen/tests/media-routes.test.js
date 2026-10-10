import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerMediaRoutes from "../routes/media.js";

let tempDirs = [];

function makeApp(bus, extraCtx = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-image-media-"));
  tempDirs.push(dataDir);
  const app = new Hono();
  registerMediaRoutes(app, {
    dataDir,
    bus,
    log: { warn() {} },
    ...extraCtx,
  });
  return app;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("image-gen media routes", () => {
  it("does not invent media providers when provider catalog events are unavailable", async () => {
    const app = makeApp({
      request: async () => {
        throw new Error("no provider handler");
      },
    });

    const res = await app.request("/providers?agentId=agent-1");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.providers).toEqual({});
  });

  it("persists and clears default media model values for the selected agent", async () => {
    const app = makeApp({
      request: vi.fn(async () => ({ models: [], providers: [] })),
    });

    const saveDefaults = await app.request("/config?agentId=agent-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        values: {
          defaultImageModel: { provider: "openai", id: "gpt-image-1" },
          defaultAudioModel: { provider: "minimax", id: "speech-default" },
          defaultMusicModel: { provider: "minimax", id: "music-default" },
          defaultVideoModel: { provider: "volcengine", id: "seedance-default" },
        },
      }),
    });
    expect(saveDefaults.status).toBe(200);

    let res = await app.request("/providers?agentId=agent-1");
    let data = await res.json();
    expect(data.config.defaultImageModel).toEqual({ provider: "openai", id: "gpt-image-1" });
    expect(data.config.defaultAudioModel).toEqual({ provider: "minimax", id: "speech-default" });
    expect(data.config.defaultMusicModel).toEqual({ provider: "minimax", id: "music-default" });
    expect(data.config.defaultVideoModel).toEqual({ provider: "volcengine", id: "seedance-default" });

    const clearDefaults = await app.request("/config?agentId=agent-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        values: {
          defaultImageModel: null,
          defaultAudioModel: null,
          defaultMusicModel: null,
          defaultVideoModel: null,
        },
      }),
    });
    expect(clearDefaults.status).toBe(200);

    res = await app.request("/providers?agentId=agent-1");
    data = await res.json();
    expect(data.config.defaultImageModel).toBeNull();
    expect(data.config.defaultAudioModel).toBeNull();
    expect(data.config.defaultMusicModel).toBeNull();
    expect(data.config.defaultVideoModel).toBeNull();
  });

  it("rejects unavailable default image models when the media runtime can validate them", async () => {
    const app = makeApp({
      request: vi.fn(async (type) => {
        if (type === "provider:resolve-media-model") {
          return { error: "Media model \"openai/missing-image\" not found" };
        }
        return { models: [], providers: {} };
      }),
    }, {
      _mediaGen: {
        registry: {
          getProtocol: vi.fn(),
          get: vi.fn(),
        },
      },
    });

    const res = await app.request("/config?agentId=agent-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        values: {
          defaultImageModel: { provider: "openai", id: "missing-image" },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Media model \"openai/missing-image\" not found" });
  });

  it("exposes the generated media open route with normal file safety checks", async () => {
    const app = makeApp({
      request: vi.fn(async () => ({ models: [], providers: {} })),
    });

    const missing = await app.request("/media/open/missing.png", { method: "POST" });
    expect(missing.status).toBe(404);

    const invalid = await app.request("/media/open/..%2Fsecret.png", { method: "POST" });
    expect(invalid.status).toBe(400);
  });

  it("uses imported media models for provider summaries without preset candidates", async () => {
    const app = makeApp({
      request: vi.fn(async (type, payload) => {
        if (type === "provider:catalog") {
          return {
            providers: [
              {
                id: "custom-media",
                displayName: "Custom Media",
                api: "openai-completions",
                isBuiltin: false,
                isConfigured: true,
                hasCredentials: true,
                models: [
                  { id: "preset-image", name: "Preset Image", type: "image" },
                  { id: "preset-video", name: "Preset Video", type: "video" },
                ],
              },
            ],
          };
        }
        if (type === "provider:models-by-type") {
          const mediaType = payload?.type;
          if (mediaType === "image") {
            return { models: [{ provider: "custom-media", id: "actual-image", name: "Actual Image" }] };
          }
          if (mediaType === "video") {
            return { models: [{ provider: "custom-media", id: "actual-video", name: "Actual Video" }] };
          }
          return { models: [] };
        }
        if (type === "provider:media-providers") {
          return { providers: {} };
        }
        return {};
      }),
    });

    const res = await app.request("/providers?agentId=agent-1");
    expect(res.status).toBe(200);
    const data = await res.json();
    const provider = data.providers["custom-media"];

    expect(provider.imageModels.map((model) => model.id)).toEqual(["actual-image"]);
    expect(provider.videoModels.map((model) => model.id)).toEqual(["actual-video"]);
    expect(provider.availableImageModels.map((model) => model.id)).not.toContain("preset-image");
    expect(provider.availableVideoModels.map((model) => model.id)).not.toContain("preset-video");
  });

  it("does not promote capability models into imported image defaults", async () => {
    const app = makeApp({
      request: vi.fn(async (type) => {
        if (type === "provider:media-providers") {
          return {
            providers: {
              mixed: {
                providerId: "mixed",
                displayName: "Mixed Provider",
                hasCredentials: true,
                models: [
                  { id: "qwen3.5", name: "Qwen 3.5" },
                  { id: "gpt-image-2", name: "GPT Image 2", type: "image" },
                ],
                availableModels: [
                  { id: "preset-chat", name: "Preset Chat" },
                  { id: "seedream-v5", name: "Seedream V5" },
                ],
              },
            },
          };
        }
        if (type === "provider:catalog") return { providers: [] };
        if (type === "provider:models-by-type") return { models: [] };
        return {};
      }),
    });

    const res = await app.request("/providers?agentId=agent-1");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.providers.mixed).toBeUndefined();
  });

  it("does not expose capability providers that only have candidate media models", async () => {
    const app = makeApp({
      request: vi.fn(async (type) => {
        if (type === "provider:media-providers") {
          return {
            providers: {
              candidatesOnly: {
                providerId: "candidatesOnly",
                displayName: "Candidates Only",
                hasCredentials: true,
                models: [],
                availableModels: [
                  { id: "seedream-v5", name: "Seedream V5" },
                  { id: "gpt-image-2", name: "GPT Image 2", type: "image" },
                ],
              },
            },
          };
        }
        if (type === "provider:catalog") return { providers: [] };
        if (type === "provider:models-by-type") return { models: [] };
        return {};
      }),
    });

    const res = await app.request("/providers?agentId=agent-1");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.providers.candidatesOnly).toBeUndefined();
  });

  it("does not expose built-in capability catalog models as imported defaults", async () => {
    const app = makeApp({
      request: vi.fn(async (type) => {
        if (type === "provider:media-providers") {
          return {
            providers: {
              openai: {
                providerId: "openai",
                displayName: "OpenAI",
                hasCredentials: true,
                models: [
                  { id: "gpt-image-2", name: "GPT Image 2", type: "image", protocolId: "openai-images" },
                  { id: "gpt-image-1", name: "GPT Image 1", type: "image", protocolId: "openai-images" },
                ],
              },
              volcengine: {
                providerId: "volcengine",
                displayName: "Volcengine",
                hasCredentials: true,
                models: [
                  { id: "doubao-seedream-3-0-t2i", name: "Seedream 3.0", type: "image", protocolId: "volcengine-images" },
                ],
              },
            },
          };
        }
        if (type === "provider:models-by-type") return { models: [] };
        if (type === "provider:catalog") return { providers: [] };
        return {};
      }),
    }, {
      _mediaGen: {
        registry: {
          getProtocol: () => ({ id: "adapter" }),
          get: () => null,
        },
      },
    });

    const res = await app.request("/providers?agentId=agent-1");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.providers.openai).toBeUndefined();
    expect(data.providers.volcengine).toBeUndefined();
  });
});
