import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMediaRoute } from "../server/routes/media.ts";

describe("native media route", () => {
  it("returns image providers from the native media manager", async () => {
    const app = new Hono();
    const listImageProviders = vi.fn(async () => ({
      providers: {
        openai: {
          providerId: "openai",
          displayName: "OpenAI",
          hasCredentials: true,
          models: [{ id: "gpt-image-1.5", name: "GPT Image 1.5", protocolId: "openai-images" }],
        },
      },
      config: { defaultImageModel: { provider: "openai", id: "gpt-image-1.5" } },
    }));
    app.route("/api", createMediaRoute({
      media: { listImageProviders },
    }));

    const res = await app.request("/api/media/image/providers");

    expect(res.status).toBe(200);
    expect(listImageProviders).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({
      providers: {
        openai: {
          providerId: "openai",
          displayName: "OpenAI",
          hasCredentials: true,
          models: [{ id: "gpt-image-1.5", name: "GPT Image 1.5", protocolId: "openai-images" }],
        },
      },
      config: { defaultImageModel: { provider: "openai", id: "gpt-image-1.5" } },
    });
  });

  it("returns video providers from the native media manager", async () => {
    const app = new Hono();
    const listVideoProviders = vi.fn(async () => ({
      providers: {
        agnes: {
          providerId: "agnes",
          displayName: "Agnes AI",
          hasCredentials: true,
          models: [{ id: "agnes-video-v2.0", name: "Agnes Video V2.0", protocolId: "agnes-videos" }],
        },
      },
      config: { defaultVideoModel: { provider: "agnes", id: "agnes-video-v2.0" } },
    }));
    app.route("/api", createMediaRoute({
      media: { listVideoProviders },
    }));

    const res = await app.request("/api/media/video/providers");

    expect(res.status).toBe(200);
    expect(listVideoProviders).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({
      providers: {
        agnes: {
          providerId: "agnes",
          displayName: "Agnes AI",
          hasCredentials: true,
          models: [{ id: "agnes-video-v2.0", name: "Agnes Video V2.0", protocolId: "agnes-videos" }],
        },
      },
      config: { defaultVideoModel: { provider: "agnes", id: "agnes-video-v2.0" } },
    });
  });

  it("saves image generation config through the native media manager", async () => {
    const app = new Hono();
    const setImageConfig = vi.fn(() => ({ providerDefaults: { openai: { size: "1024x1024" } } }));
    app.route("/api", createMediaRoute({
      media: {
        listImageProviders: async () => ({ providers: {}, config: {} }),
        setImageConfig,
      },
    }));

    const res = await app.request("/api/media/image/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        values: {
          defaultImageModel: null,
          providerDefaults: { openai: { size: "1024x1024" } },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(setImageConfig).toHaveBeenCalledWith({
      defaultImageModel: undefined,
      providerDefaults: { openai: { size: "1024x1024" } },
    });
    expect(await res.json()).toEqual({
      ok: true,
      config: { providerDefaults: { openai: { size: "1024x1024" } } },
      values: { providerDefaults: { openai: { size: "1024x1024" } } },
    });
  });

  it("saves video generation config through the native media manager", async () => {
    const app = new Hono();
    const setVideoConfig = vi.fn(() => ({ providerDefaults: { agnes: { duration: 5 } } }));
    app.route("/api", createMediaRoute({
      media: {
        listVideoProviders: async () => ({ providers: {}, config: {} }),
        setVideoConfig,
      },
    }));

    const res = await app.request("/api/media/video/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        values: {
          defaultVideoModel: null,
          providerDefaults: { agnes: { duration: 5 } },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(setVideoConfig).toHaveBeenCalledWith({
      defaultVideoModel: undefined,
      providerDefaults: { agnes: { duration: 5 } },
    });
    expect(await res.json()).toEqual({
      ok: true,
      config: { providerDefaults: { agnes: { duration: 5 } } },
      values: { providerDefaults: { agnes: { duration: 5 } } },
    });
  });

  it("submits image generation through the native media manager", async () => {
    const app = new Hono();
    const generateImageFromBus = vi.fn(async (payload) => ({
      ok: true,
      kind: "image",
      batchId: "batch_1",
      tasks: [{ taskId: "task_1" }],
      received: payload,
    }));
    app.route("/api", createMediaRoute({
      media: { generateImageFromBus },
    }));

    const res = await app.request("/api/media/image/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionPath: "/sessions/a.jsonl",
        prompt: "draw a quiet notebook cover",
        referenceImages: [
          { kind: "session_file", fileId: "sf_ref_a" },
          { kind: "session_file", fileId: "sf_ref_b" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(generateImageFromBus).toHaveBeenCalledWith({
      sessionPath: "/sessions/a.jsonl",
      prompt: "draw a quiet notebook cover",
      referenceImages: [
        { kind: "session_file", fileId: "sf_ref_a" },
        { kind: "session_file", fileId: "sf_ref_b" },
      ],
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      kind: "image",
      batchId: "batch_1",
      tasks: [{ taskId: "task_1" }],
    });
  });

  it("submits video generation through the native media manager", async () => {
    const app = new Hono();
    const generateVideoFromBus = vi.fn(async (payload) => ({
      ok: true,
      kind: "video",
      batchId: "batch_v",
      tasks: [{ taskId: "task_v" }],
      received: payload,
    }));
    app.route("/api", createMediaRoute({
      media: { generateVideoFromBus },
    }));

    const res = await app.request("/api/media/video/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionPath: "/sessions/a.jsonl",
        prompt: "animate the notebook cover",
        duration: 5,
      }),
    });

    expect(res.status).toBe(200);
    expect(generateVideoFromBus).toHaveBeenCalledWith({
      sessionPath: "/sessions/a.jsonl",
      prompt: "animate the notebook cover",
      duration: 5,
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      kind: "video",
      batchId: "batch_v",
      tasks: [{ taskId: "task_v" }],
    });
  });

  it("dispatches generic media generation by kind", async () => {
    const app = new Hono();
    const generateMedia = vi.fn(async (payload) => ({
      ok: true,
      kind: payload.kind,
      batchId: "batch_any",
    }));
    app.route("/api", createMediaRoute({
      media: { generateMedia },
    }));

    const res = await app.request("/api/media/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "image",
        sessionPath: "/sessions/a.jsonl",
        prompt: "draw",
      }),
    });

    expect(res.status).toBe(200);
    expect(generateMedia).toHaveBeenCalledWith({
      kind: "image",
      sessionPath: "/sessions/a.jsonl",
      prompt: "draw",
    });
    expect(await res.json()).toEqual({
      ok: true,
      kind: "image",
      batchId: "batch_any",
    });
  });

  it("transcribes audio through the native media manager", async () => {
    const app = new Hono();
    const transcribeAudio = vi.fn(async (payload) => ({
      ok: true,
      transcription: {
        status: "ready",
        text: "hello",
        received: payload,
      },
    }));
    app.route("/api", createMediaRoute({
      media: { transcribeAudio },
    }));

    const res = await app.request("/api/media/asr/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionPath: "/sessions/a.jsonl",
        fileId: "file_audio",
        language: "zh",
      }),
    });

    expect(res.status).toBe(200);
    expect(transcribeAudio).toHaveBeenCalledWith({
      sessionPath: "/sessions/a.jsonl",
      fileId: "file_audio",
      language: "zh",
    });
    expect(await res.json()).toEqual({
      ok: true,
      transcription: {
        status: "ready",
        text: "hello",
        received: {
          sessionPath: "/sessions/a.jsonl",
          fileId: "file_audio",
          language: "zh",
        },
      },
    });
  });
});
