import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import registerImageCardRoutes from "../routes/card.js";
import registerVideoCardRoutes from "../routes/video-card.js";

const tempDirs = [];

function makeStore(tasks) {
  return {
    getByBatch(batchId) {
      return tasks.filter((task) => task.batchId === batchId);
    },
  };
}

function makeApp({ pluginId = "image-gen", tasks }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-image-card-"));
  tempDirs.push(dataDir);
  const app = new Hono();
  const ctx = {
    pluginId,
    dataDir,
    _mediaGen: {
      store: makeStore(tasks),
    },
  };
  registerImageCardRoutes(app, ctx);
  registerVideoCardRoutes(app, ctx);
  return app;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("image-gen card routes", () => {
  it("renders image cards without video renderer branches", async () => {
    const app = makeApp({
      tasks: [{
        taskId: "img1",
        batchId: "batch-image",
        status: "done",
        type: "image",
        params: { ratio: "1:1" },
        files: ["img1.png"],
      }],
    });

    const res = await app.request("/card?batch=batch-image");
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('alt="generated image"');
    expect(html).not.toContain("payload.kind === 'video'");
    expect(html).not.toContain("<video");
  });

  it("renders provider video cards on a dedicated route", async () => {
    const app = makeApp({
      tasks: [{
        taskId: "video1",
        batchId: "batch-video",
        status: "done",
        type: "video",
        params: { ratio: "16:9" },
        files: ["clip.mp4"],
      }],
    });

    const res = await app.request("/video-card?batch=batch-video");
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("<video");
    expect(html).toContain("clip.mp4");
    expect(html).not.toContain('alt="generated image"');
  });

  it("renders a retry action for failed image tasks", async () => {
    const app = makeApp({
      tasks: [{
        taskId: "img-failed",
        batchId: "batch-failed",
        status: "failed",
        type: "image",
        params: { ratio: "1:1" },
        failReason: "temporary provider error",
      }],
    });

    const res = await app.request("/card?batch=batch-failed");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('data-action="retry"');
    expect(html).toContain('data-task-id="img-failed"');
    expect(html).toContain("/tasks/");
    expect(html).toContain("/retry");
  });
});
