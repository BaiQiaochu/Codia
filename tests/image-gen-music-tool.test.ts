// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let execute;
const tempDirs = [];

beforeEach(async () => {
  vi.resetModules();
  ({ execute } = await import("../plugins/image-gen/tools/generate-music.js"));
});

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeAdapter(overrides = {}) {
  return {
    id: "minimax",
    types: ["music"],
    checkAuth: vi.fn(async () => ({ ok: true })),
    submit: vi.fn(async () => ({ taskId: "music-task-1" })),
    ...overrides,
  };
}

function makeCtx(adapter = makeAdapter()) {
  return {
    _mediaGen: {
      registry: {
        get: vi.fn((id) => (id === adapter.id ? adapter : null)),
        getByType: vi.fn(() => [adapter]),
      },
      store: { add: vi.fn(), update: vi.fn() },
      poller: { add: vi.fn() },
    },
    dataDir: "/tmp/data",
    sessionPath: "/sessions/main.jsonl",
    bus: { request: vi.fn(async () => ({})) },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
}

function makeTempDataDir(config = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-music-tool-"));
  tempDirs.push(dir);
  if (config) fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf-8");
  return dir;
}

describe("generate-music tool preflight", () => {
  it("classifies missing music providers", async () => {
    const ctx = makeCtx();
    ctx._mediaGen.registry.getByType.mockReturnValue([]);

    const result = await execute({ prompt: "ambient piano" }, ctx);

    expect(result.details.error).toMatchObject({
      code: "missing_model",
      mediaType: "music",
    });
  });

  it("requires an imported music model before checking credentials", async () => {
    const adapter = makeAdapter({
      checkAuth: vi.fn(async () => ({ ok: false, message: 'Provider "minimax" has no API key configured.' })),
    });

    const result = await execute({ prompt: "ambient piano" }, makeCtx(adapter));

    expect(adapter.submit).not.toHaveBeenCalled();
    expect(result.details.error).toMatchObject({
      code: "missing_model",
      mediaType: "music",
    });
  });

  it("classifies missing music credentials after an actual music model is configured", async () => {
    const adapter = makeAdapter({
      checkAuth: vi.fn(async () => ({ ok: false, message: 'Provider "minimax" has no API key configured.' })),
    });
    const ctx = makeCtx(adapter);
    ctx.dataDir = makeTempDataDir({
      defaultMusicModel: { provider: "minimax", id: "music-2.6" },
    });
    ctx.bus.request = vi.fn(async (type, payload) => {
      if (type === "provider:models-by-type" && payload?.type === "music") {
        return { models: [{ provider: "minimax", id: "music-2.6", type: "music" }] };
      }
      return {};
    });

    const result = await execute({ prompt: "ambient piano" }, ctx);

    expect(adapter.submit).not.toHaveBeenCalled();
    expect(result.details.error).toMatchObject({
      code: "missing_credentials",
      mediaType: "music",
    });
  });

  it("uses the OpenAI-compatible media adapter for a configured third-party music model", async () => {
    const adapter = {
      id: "openai-compatible-media",
      types: ["audio", "music", "video"],
      submit: vi.fn(async () => ({ taskId: "music-task-1" })),
    };
    const ctx = makeCtx(adapter);
    ctx.dataDir = makeTempDataDir({
      defaultMusicModel: { provider: "custom-music", id: "song-plus" },
    });
    ctx._mediaGen.registry.get.mockImplementation((id) => (id === adapter.id ? adapter : null));
    ctx._mediaGen.registry.getByType.mockReturnValue([]);
    ctx.bus.request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "custom-music") {
        return { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://music.example.test/v1" };
      }
      return {};
    });

    await execute({ prompt: "ambient piano" }, ctx);

    expect(ctx._mediaGen.registry.get).toHaveBeenCalledWith("custom-music");
    expect(ctx._mediaGen.registry.get).toHaveBeenCalledWith("openai-compatible-media");
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.submit.mock.calls[0][0]).toMatchObject({
      type: "music",
      prompt: "ambient piano",
      provider: "custom-music",
      providerId: "custom-music",
      model: "song-plus",
    });
  });
});
