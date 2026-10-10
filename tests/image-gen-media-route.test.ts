import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerMediaRoutes from "../plugins/image-gen/routes/media.js";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeApp(dataDir) {
  const app = new Hono();
  registerMediaRoutes(app, {
    dataDir,
    bus: {
      request: vi.fn(async (type) => {
        if (type === "provider:catalog") return { providers: [] };
        if (type === "provider:models-by-type") return { models: [] };
        return {};
      }),
    },
    log: { warn: vi.fn() },
    pluginId: "image-gen",
  });
  return app;
}

function makeAppWithBus(dataDir, request) {
  const app = new Hono();
  registerMediaRoutes(app, {
    dataDir,
    bus: { request },
    log: { warn: vi.fn() },
    pluginId: "image-gen",
  });
  return app;
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-image-gen-route-"));
  tempDirs.push(dir);
  return dir;
}

describe("image-gen media routes", () => {
  it("does not treat OpenAI-compatible chat models as image models", async () => {
    const dataDir = makeTempDir();
    const app = makeAppWithBus(dataDir, vi.fn(async (type, payload) => {
      if (type === "provider:catalog") {
        return {
          providers: [{
            id: "relay",
            displayName: "Relay",
            api: "openai-completions",
            hasCredentials: true,
            models: ["gpt-5.5"],
          }],
        };
      }
      if (type === "provider:models-by-type") {
        if (payload?.type === "image") return { models: [] };
        return { models: [] };
      }
      if (type === "provider:media-providers") return { providers: {} };
      return {};
    }));

    const res = await app.request("/providers");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers.relay).toBeUndefined();
  });

  it("keeps explicitly configured OpenAI-compatible image models in media providers", async () => {
    const dataDir = makeTempDir();
    const app = makeAppWithBus(dataDir, vi.fn(async (type, payload) => {
      if (type === "provider:catalog") {
        return {
          providers: [{
            id: "relay",
            displayName: "Relay",
            api: "openai-completions",
            hasCredentials: true,
            models: ["gpt-5.5"],
          }],
        };
      }
      if (type === "provider:models-by-type" && payload?.type === "image") {
        return { models: [{ provider: "relay", id: "gptimage2", name: "GPT Image 2", type: "image" }] };
      }
      if (type === "provider:models-by-type") return { models: [] };
      if (type === "provider:media-providers") return { providers: {} };
      return {};
    }));

    const res = await app.request("/providers");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers.relay.imageModels).toEqual([
      { id: "gptimage2", name: "GPT Image 2", type: "image" },
    ]);
    expect(body.providers.relay.imageModels.map((model) => model.id)).not.toContain("gpt-5.5");
  });

  it("unwraps values payloads when saving media defaults", async () => {
    const dataDir = makeTempDir();
    const app = makeApp(dataDir);

    const putRes = await app.request("/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        values: {
          defaultVideoModel: { provider: "volcengine", id: "doubao-seedance-2-0-260128" },
          providerDefaults: {
            volcengine: { videoDuration: "15", ratio: "16:9" },
          },
        },
      }),
    });

    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ ok: true });

    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf-8"));
    expect(saved).toMatchObject({
      defaultVideoModel: { provider: "volcengine", id: "doubao-seedance-2-0-260128" },
      providerDefaults: {
        volcengine: { videoDuration: "15", ratio: "16:9" },
      },
    });
    expect(saved.values).toBeUndefined();

    const getRes = await app.request("/providers");
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.config.defaultVideoModel).toEqual({
      provider: "volcengine",
      id: "doubao-seedance-2-0-260128",
    });
    expect(body.config.providerDefaults).toEqual({
      volcengine: { videoDuration: "15", ratio: "16:9" },
    });
  });
});
