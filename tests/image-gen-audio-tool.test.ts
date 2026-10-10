// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let execute;
const tempDirs = [];

beforeEach(async () => {
  vi.resetModules();
  ({ execute } = await import("../plugins/image-gen/tools/generate-audio.js"));
});

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeTempDataDir(config = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-audio-tool-"));
  tempDirs.push(dir);
  if (config) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf-8");
  }
  return dir;
}

function makeGenericAdapter() {
  return {
    id: "openai-compatible-media",
    types: ["audio", "music", "video"],
    submit: vi.fn(async () => ({ taskId: "audio-task-1" })),
  };
}

function makeCtx({ adapter = makeGenericAdapter(), dataDir = makeTempDataDir(), request = vi.fn(async () => ({})) } = {}) {
  return {
    _mediaGen: {
      registry: {
        get: vi.fn((id) => (id === adapter.id ? adapter : null)),
        getByType: vi.fn(() => []),
      },
      store: { add: vi.fn(), update: vi.fn() },
      poller: { add: vi.fn() },
    },
    dataDir,
    sessionPath: "/sessions/main.jsonl",
    bus: { request },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
}

describe("generate-audio custom provider routing", () => {
  it("uses the OpenAI-compatible media adapter for a configured third-party audio model", async () => {
    const adapter = makeGenericAdapter();
    const dataDir = makeTempDataDir({
      defaultAudioModel: { provider: "custom-tts", id: "voice-plus" },
    });
    const request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "custom-tts") {
        return { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://tts.example.test/v1" };
      }
      return {};
    });
    const ctx = makeCtx({ adapter, dataDir, request });

    await execute({ text: "hello", voice: "alloy" }, ctx);

    expect(ctx._mediaGen.registry.get).toHaveBeenCalledWith("custom-tts");
    expect(ctx._mediaGen.registry.get).toHaveBeenCalledWith("openai-compatible-media");
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.submit.mock.calls[0][0]).toMatchObject({
      type: "audio",
      text: "hello",
      provider: "custom-tts",
      providerId: "custom-tts",
      model: "voice-plus",
      voice: "alloy",
    });
  });
});
