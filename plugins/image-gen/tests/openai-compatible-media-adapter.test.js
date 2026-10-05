import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiCompatibleMediaAdapter } from "../adapters/openai-compatible-media.js";

const tempDirs = [];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-openai-media-"));
  tempDirs.push(dir);
  return dir;
}

function makeCtx({ dataDir = makeTempDir(), providerDefaults = {}, creds = {} } = {}) {
  return {
    dataDir,
    config: {
      get(key) {
        if (key === "providerDefaults") return providerDefaults;
        if (key === "defaultAudioModel") return { provider: "custom-media", id: "tts-plus" };
        if (key === "defaultVideoModel") return { provider: "custom-media", id: "video-plus" };
        return undefined;
      },
    },
    bus: {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:credentials" && payload.providerId === "custom-media") {
          return {
            api: "openai-completions",
            apiKey: "sk-test",
            baseUrl: "https://media.example.test/v1",
            ...creds,
          };
        }
        if (type === "provider:models-by-type") return { models: [] };
        return {};
      }),
    },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
}

function makeResponse(body, { status = 200, contentType = "application/json" } = {}) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    headers: { get: vi.fn(() => contentType) },
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
    arrayBuffer: vi.fn(async () => Buffer.isBuffer(body) ? body : Buffer.from(String(body))),
  };
}

describe("openai-compatible media adapter", () => {
  it("posts audio speech requests to the configured OpenAI-compatible endpoint and saves binary audio", async () => {
    const audioBuffer = Buffer.from("audio-bytes");
    const fetchMock = vi.fn(async () => makeResponse(audioBuffer, { contentType: "audio/mpeg" }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx();

    const result = await openaiCompatibleMediaAdapter.submit({
      type: "audio",
      providerId: "custom-media",
      text: "hello",
      voice: "alloy",
      format: "mp3",
    }, ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://media.example.test/v1/audio/speech");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: "tts-plus",
      input: "hello",
      voice: "alloy",
      response_format: "mp3",
    });
    expect(result.files).toHaveLength(1);
    expect(fs.existsSync(path.join(ctx.dataDir, "generated", result.files[0]))).toBe(true);
  });

  it("posts video requests to a custom endpoint and downloads returned media URLs", async () => {
    const videoBuffer = Buffer.from("video-bytes");
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith("/custom/videos")) {
        return makeResponse({ data: [{ url: "https://cdn.example.test/out.mp4" }] });
      }
      return makeResponse(videoBuffer, { contentType: "video/mp4" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({
      providerDefaults: {
        "custom-media": { videoEndpoint: "/custom/videos" },
      },
    });

    const result = await openaiCompatibleMediaAdapter.submit({
      type: "video",
      providerId: "custom-media",
      prompt: "ocean",
      ratio: "16:9",
    }, ctx);

    expect(fetchMock.mock.calls[0][0]).toBe("https://media.example.test/v1/custom/videos");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: "video-plus",
      prompt: "ocean",
      aspect_ratio: "16:9",
    });
    expect(fetchMock.mock.calls[1][0]).toBe("https://cdn.example.test/out.mp4");
    expect(result.files).toHaveLength(1);
    expect(fs.existsSync(path.join(ctx.dataDir, "generated", result.files[0]))).toBe(true);
  });

  it("preserves ordered video reference images as image_urls", async () => {
    const fetchMock = vi.fn(async () => makeResponse({ id: "video-task-refs", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx();

    const result = await openaiCompatibleMediaAdapter.submit({
      type: "video",
      providerId: "custom-media",
      prompt: "animate references",
      images: ["https://cdn.example.test/pose.png", "https://cdn.example.test/style.png"],
      image: "https://cdn.example.test/pose.png",
    }, ctx);

    expect(result.taskId).toMatch(/^ocm_/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: "video-plus",
      prompt: "animate references",
      image_urls: ["https://cdn.example.test/pose.png", "https://cdn.example.test/style.png"],
    });
  });

  it("converts local video reference images to data URLs before submitting", async () => {
    const fetchMock = vi.fn(async () => makeResponse({ id: "video-task-local-ref", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx();
    const refPath = path.join(ctx.dataDir, "ref.png");
    fs.writeFileSync(refPath, Buffer.from("png"));

    await openaiCompatibleMediaAdapter.submit({
      type: "video",
      providerId: "custom-media",
      prompt: "animate local image",
      image: refPath,
    }, ctx);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.image_url).toMatch(/^data:image\/png;base64,/);
    expect(body.image_url).not.toContain(refPath);
  });

  it("supports provider configured images[].image_url schema for video reference images", async () => {
    const fetchMock = vi.fn(async () => makeResponse({ id: "video-task-schema", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({
      providerDefaults: {
        "custom-media": { videoInputField: "images[].image_url" },
      },
    });

    await openaiCompatibleMediaAdapter.submit({
      type: "video",
      providerId: "custom-media",
      prompt: "animate references",
      images: ["https://cdn.example.test/pose.png", "https://cdn.example.test/style.png"],
    }, ctx);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.images).toEqual([
      { image_url: "https://cdn.example.test/pose.png" },
      { image_url: "https://cdn.example.test/style.png" },
    ]);
    expect(body).not.toHaveProperty("image_url");
    expect(body).not.toHaveProperty("image_urls");
  });

  it("falls back to images[].image_url when a video provider rejects image_urls", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(
        { error: { message: "Invalid request: images[].image_url is required" } },
        { status: 400 },
      ))
      .mockResolvedValueOnce(makeResponse({ id: "video-task-fallback", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx();

    await openaiCompatibleMediaAdapter.submit({
      type: "video",
      providerId: "custom-media",
      prompt: "animate references",
      images: ["https://cdn.example.test/pose.png", "https://cdn.example.test/style.png"],
    }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.images).toEqual([
      { image_url: "https://cdn.example.test/pose.png" },
      { image_url: "https://cdn.example.test/style.png" },
    ]);
    expect(secondBody).not.toHaveProperty("image_urls");
  });

  it("rejects providers that are not OpenAI-compatible", async () => {
    const ctx = makeCtx({ creds: { api: "anthropic-messages" } });

    await expect(openaiCompatibleMediaAdapter.submit({
      type: "audio",
      providerId: "custom-media",
      text: "hello",
    }, ctx)).rejects.toThrow("not an OpenAI-compatible API");
  });
});
