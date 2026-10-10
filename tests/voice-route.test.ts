// @ts-nocheck
/* global File, FormData, Response */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceRoute } from "../server/routes/voice.js";

let tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-voice-route-"));
  tempDirs.push(dir);
  return dir;
}

function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createVoiceRoute(engine));
  return app;
}

function writeImageGenConfig(dataDir, config) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({ schemaVersion: 1, global: config, agents: {}, sessions: {} }, null, 2),
    "utf8",
  );
}

function makeEngine({ dataDir, defaultAudioModel, creds } = {}) {
  if (dataDir && defaultAudioModel) {
    writeImageGenConfig(dataDir, { defaultAudioModel });
  }
  return {
    pluginManager: {
      getPlugin: vi.fn((id) => (id === "image-gen" && dataDir
        ? { status: "loaded", ctx: { dataDir } }
        : null)),
    },
    resolveProviderCredentials: vi.fn((provider) => (
      provider === creds?.provider
        ? { api_key: creds.api_key, base_url: creds.base_url, api: creds.api }
        : { api_key: "", base_url: "", api: "" }
    )),
  };
}

function audioForm() {
  const body = new FormData();
  body.append("audio", new File([new Uint8Array([1, 2, 3])], "voice.webm", { type: "audio/webm" }));
  body.append("lang", "zh-CN");
  return body;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("voice transcription route", () => {
  it("returns a clear error when no audio file is uploaded", async () => {
    const app = makeApp(makeEngine());
    const res = await app.request("/api/voice/transcribe", {
      method: "POST",
      body: new FormData(),
    });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("audio file is required");
  });

  it("returns a clear error when no STT model is configured", async () => {
    const app = makeApp(makeEngine());
    const res = await app.request("/api/voice/transcribe", {
      method: "POST",
      body: audioForm(),
    });
    const data = await res.json();

    expect(res.status).toBe(501);
    expect(data.error).toContain("speech-to-text model is not configured");
  });

  it("posts selected audio to the configured OpenAI-compatible transcription endpoint", async () => {
    const dataDir = makeTempDir();
    const fetchMock = vi.fn(async (_url, _init) => new Response(JSON.stringify({ text: "你好，世界" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const app = makeApp(makeEngine({
      dataDir,
      defaultAudioModel: { provider: "openai", id: "whisper-1" },
      creds: {
        provider: "openai",
        api_key: "sk-test",
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
      },
    }));

    const res = await app.request("/api/voice/transcribe?agentId=agent-1", {
      method: "POST",
      body: audioForm(),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.text).toBe("你好，世界");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer sk-test" },
    });
    const providerBody = fetchMock.mock.calls[0][1].body;
    expect(providerBody).toBeInstanceOf(FormData);
    expect(providerBody.get("model")).toBe("whisper-1");
    expect(providerBody.get("language")).toBe("zh-CN");
  });
});
