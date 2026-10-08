import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minimaxMediaAdapter } from "../adapters/minimax-media.js";

function createCtx(tmpDir, providerDefaults = {}, baseUrl = "https://api.minimaxi.com/anthropic") {
  return {
    dataDir: tmpDir,
    config: {
      get: (key) => {
        if (key === "providerDefaults") return providerDefaults;
        return null;
      },
    },
    bus: {
      request: vi.fn(async (eventName) => {
        if (eventName === "provider:credentials") {
          return {
            apiKey: "test-key",
            baseUrl,
          };
        }
        return {};
      }),
    },
  };
}

describe("minimaxMediaAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the MiniMax media endpoint when credentials inherit a chat base URL", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-audio-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          audio: Buffer.from("fake-audio").toString("hex"),
        },
        base_resp: { status_code: 0 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await minimaxMediaAdapter.submit(
      { type: "audio", text: "hello", format: "mp3" },
      createCtx(tmpDir),
    );

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.minimax.io/v1/t2a_v2");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.output_format).toBe("hex");
    expect(body.audio_setting.format).toBe("mp3");
    expect(result.files).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, "generated", result.files[0]))).toBe(true);
  });

  it("falls back to the media endpoint when credentials inherit a legacy MiniMax API host", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-audio-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          audio: Buffer.from("fake-audio").toString("hex"),
        },
        base_resp: { status_code: 0 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await minimaxMediaAdapter.submit(
      { type: "audio", text: "hello", format: "mp3" },
      createCtx(tmpDir, {}, "https://api.minimaxi.com/v1"),
    );

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.minimax.io/v1/t2a_v2");
  });

  it("rejects image generation because MiniMax is audio and music only", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-image-"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(minimaxMediaAdapter.submit(
      { type: "image", prompt: "a glass fox", size: "landscape", count: 12, seed: 123 },
      createCtx(tmpDir),
    )).rejects.toThrow("MiniMax image generation is not supported.");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps MiniMax music response format separate from audio encoding format", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-music-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          audio: Buffer.from("fake-music").toString("hex"),
        },
        base_resp: { status_code: 0 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await minimaxMediaAdapter.submit(
      { type: "music", prompt: "ambient loop", format: "mp3", output_format: "url" },
      createCtx(tmpDir),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.minimax.io/v1/music_generation");
    expect(body.output_format).toBe("url");
    expect(body.audio_setting.format).toBe("mp3");
  });

  it("applies music defaults for format, response format, and duration", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-music-defaults-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          audio: Buffer.from("fake-music").toString("hex"),
        },
        base_resp: { status_code: 0 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await minimaxMediaAdapter.submit(
      { type: "music", prompt: "driving synth", duration: 15 },
      createCtx(tmpDir, {
        minimax: {
          musicFormat: "wav",
          musicResponseFormat: "hex",
          duration: "15",
        },
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.audio_setting.format).toBe("wav");
    expect(body.output_format).toBe("hex");
    expect(body.duration).toBe(15);
  });

  it("applies audio defaults for format and response format", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-audio-defaults-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          audio: Buffer.from("fake-audio").toString("hex"),
        },
        base_resp: { status_code: 0 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await minimaxMediaAdapter.submit(
      { type: "audio", text: "hello" },
      createCtx(tmpDir, {
        minimax: {
          audioFormat: "flac",
          audioResponseFormat: "url",
        },
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.audio_setting.format).toBe("flac");
    expect(body.output_format).toBe("url");
  });
});
