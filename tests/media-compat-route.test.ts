import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMediaRoute } from "../server/routes/media.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-media-compat-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp({ bus, engine = {}, mediaOptions = {} }: { bus?: any; engine?: any; mediaOptions?: any } = {}) {
  const app = new Hono();
  app.route("/api", createMediaRoute(engine, { eventBus: bus }, mediaOptions));
  return app;
}

describe("legacy /api/media compatibility route", () => {
  it("forwards legacy image generation requests to the media bus with response delivery", async () => {
    const request = vi.fn(async () => ({ ok: true, id: "task-1" }));
    const app = makeApp({ bus: { request } });

    const res = await app.request("/api/media/image/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "draw a moon", provider: "openai", model: "gpt-image-2" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "task-1" });
    expect(request).toHaveBeenCalledWith("media:generate-image", {
      prompt: "draw a moon",
      provider: "openai",
      model: "gpt-image-2",
      delivery: { mode: "response" },
    });
  });

  it("maps legacy provider and model management URLs to current provider bus capabilities", async () => {
    const request = vi.fn(async (type, payload) => {
      if (type === "provider:media-providers") return { providers: { openai: { models: [] } } };
      if (type === "provider:add-media-model") return { ok: true, payload };
      if (type === "provider:remove-media-model") return { ok: true, payload };
      return { ok: true };
    });
    const app = makeApp({ bus: { request } });

    const providers = await app.request("/api/media/image/providers");
    expect(providers.status).toBe(200);
    expect(await providers.json()).toEqual({ providers: { openai: { models: [] } } });
    expect(request).toHaveBeenCalledWith("provider:media-providers", { capability: "image_generation" });

    const add = await app.request("/api/media/video/providers/jimeng-cli/models", {
      method: "POST",
      body: JSON.stringify({ model: { id: "jimeng-video-5.0" } }),
      headers: { "content-type": "application/json" },
    });
    expect(add.status).toBe(200);
    expect(request).toHaveBeenCalledWith("provider:add-media-model", {
      providerId: "jimeng-cli",
      capability: "video_generation",
      model: { id: "jimeng-video-5.0" },
    });

    const remove = await app.request("/api/media/video/providers/jimeng-cli/models/jimeng-video-5.0", {
      method: "DELETE",
    });
    expect(remove.status).toBe(200);
    expect(request).toHaveBeenCalledWith("provider:remove-media-model", {
      providerId: "jimeng-cli",
      capability: "video_generation",
      modelId: "jimeng-video-5.0",
    });
  });

  it("maps legacy task URLs to media-gen task handlers", async () => {
    const request = vi.fn(async (type, payload) => {
      if (type === "media-gen:get-tasks") return { tasks: [{ taskId: "t1", batchId: "b1" }] };
      if (type === "media-gen:get-task") return { task: { taskId: payload.taskId } };
      if (type === "task:retry") return { ok: true, taskId: payload.taskId };
      return { ok: true };
    });
    const app = makeApp({ bus: { request } });

    expect((await app.request("/api/media/tasks")).status).toBe(200);
    expect(request).toHaveBeenCalledWith("media-gen:get-tasks", {});

    expect((await app.request("/api/media/tasks/batch/b1")).status).toBe(200);
    expect(request).toHaveBeenCalledWith("media-gen:get-tasks", { batchId: "b1" });

    expect((await app.request("/api/media/tasks/t1")).status).toBe(200);
    expect(request).toHaveBeenCalledWith("media-gen:get-task", { taskId: "t1" });

    expect((await app.request("/api/media/tasks/t1/retry", { method: "POST" })).status).toBe(200);
    expect(request).toHaveBeenCalledWith("task:retry", { taskId: "t1" });
  });

  it("serves generated files from the image-gen generated directory", async () => {
    const generatedDir = path.join(tmpDir, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, "sample.png"), Buffer.from([137, 80, 78, 71]));
    const app = makeApp({
      engine: {
        pluginManager: {
          getPlugin: () => ({ ctx: { _mediaGen: { generatedDir } } }),
        },
      },
    });

    const res = await app.request("/api/media/generated/sample.png");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it("rejects generated files that exceed the media response size limit", async () => {
    const generatedDir = path.join(tmpDir, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, "large.png"), Buffer.alloc(9));
    const app = makeApp({
      mediaOptions: { maxGeneratedMediaBytes: 8 },
      engine: {
        pluginManager: {
          getPlugin: () => ({ ctx: { _mediaGen: { generatedDir } } }),
        },
      },
    });

    const res = await app.request("/api/media/generated/large.png");

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "media_file_too_large" });
  });
});
