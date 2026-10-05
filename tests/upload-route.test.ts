// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadRoute } from "../server/routes/upload.js";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.js";

let tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-upload-route-"));
  tempDirs.push(dir);
  return dir;
}

function makeEngine({ taskManager } = {}) {
  const rootDir = makeTempDir();
  const gsapHome = path.join(rootDir, "gsap-home");
  const agentsDir = path.join(rootDir, "agents");
  const sessionFiles = new SessionFileRegistry();
  const pluginManager = {
    getPlugin(pluginId) {
      if (pluginId !== "knowledge-graph" || !taskManager) return null;
      return {
        ctx: {
          _knowledgeGraph: {
            taskManager,
          },
        },
      };
    },
  };

  return {
    rootDir,
    gsapHome,
    agentsDir,
    pluginManager,
    sessionFiles,
    registerSessionFile(payload) {
      return sessionFiles.registerFile(payload);
    },
    getRuntimeContext() {
      return { studioId: "studio_upload_test" };
    },
  };
}

function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createUploadRoute(engine));
  return app;
}

function writeSourceFile(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  vi.restoreAllMocks();
});

describe("upload route knowledge graph auto sync", () => {
  it("queues a knowledge graph incremental build for supported text uploads", async () => {
    const taskManager = {
      getTaskState: vi.fn(() => ({ is_building: false })),
      submitBuildTask: vi.fn(() => ({ accepted: true, task: { id: "kg-task-1" } })),
    };
    const engine = makeEngine({ taskManager });
    const app = makeApp(engine);
    const sourcePath = writeSourceFile(engine.rootDir, "docs/notes.md", "# Title\nAlpha links to Beta.");

    const response = await app.request("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [sourcePath] }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.uploads).toHaveLength(1);
    expect(data.uploads[0]).toMatchObject({
      src: sourcePath,
      name: "notes.md",
      isDirectory: false,
    });
    expect(fs.existsSync(data.uploads[0].dest)).toBe(true);
    expect(taskManager.getTaskState).toHaveBeenCalledTimes(1);
    expect(taskManager.submitBuildTask).toHaveBeenCalledTimes(1);
    expect(taskManager.submitBuildTask).toHaveBeenCalledWith({
      documents: [
        {
          id: expect.stringMatching(/^upload:/),
          title: "notes.md",
          text: "# Title\nAlpha links to Beta.",
        },
      ],
      rebuild: false,
      parentSessionPath: "",
    });
  });

  it("skips auto sync while a knowledge graph build task is already active", async () => {
    const taskManager = {
      getTaskState: vi.fn(() => ({ is_building: true })),
      submitBuildTask: vi.fn(),
    };
    const engine = makeEngine({ taskManager });
    const app = makeApp(engine);
    const sourcePath = writeSourceFile(engine.rootDir, "docs/busy.txt", "Busy graph sync input");

    const response = await app.request("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [sourcePath] }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.uploads[0].error).toBeUndefined();
    expect(taskManager.getTaskState).toHaveBeenCalledTimes(1);
    expect(taskManager.submitBuildTask).not.toHaveBeenCalled();
  });

  it("does not fail the upload request when knowledge graph sync throws", async () => {
    const taskManager = {
      getTaskState: vi.fn(() => ({ is_building: false })),
      submitBuildTask: vi.fn(() => {
        throw new Error("sync failed");
      }),
    };
    const engine = makeEngine({ taskManager });
    const app = makeApp(engine);
    const sourcePath = writeSourceFile(engine.rootDir, "docs/failure.json", "{\"alpha\":true}");

    const response = await app.request("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [sourcePath] }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.uploads).toHaveLength(1);
    expect(data.uploads[0].src).toBe(sourcePath);
    expect(data.uploads[0].error).toBeUndefined();
    expect(fs.existsSync(data.uploads[0].dest)).toBe(true);
    expect(taskManager.submitBuildTask).toHaveBeenCalledTimes(1);
  });

  it("does not auto sync unsupported upload file extensions", async () => {
    const taskManager = {
      getTaskState: vi.fn(() => ({ is_building: false })),
      submitBuildTask: vi.fn(),
    };
    const engine = makeEngine({ taskManager });
    const app = makeApp(engine);
    const sourcePath = writeSourceFile(engine.rootDir, "docs/photo.png", "not an actual png");

    const response = await app.request("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [sourcePath] }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.uploads).toHaveLength(1);
    expect(taskManager.getTaskState).not.toHaveBeenCalled();
    expect(taskManager.submitBuildTask).not.toHaveBeenCalled();
  });

  it("does not trigger knowledge graph auto sync for upload-blob", async () => {
    const taskManager = {
      getTaskState: vi.fn(() => ({ is_building: false })),
      submitBuildTask: vi.fn(),
    };
    const engine = makeEngine({ taskManager });
    const app = makeApp(engine);
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    const response = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "graph.png",
        base64Data: pngBase64,
        mimeType: "image/png",
      }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.uploads).toHaveLength(1);
    expect(data.uploads[0].error).toBeUndefined();
    expect(fs.existsSync(data.uploads[0].dest)).toBe(true);
    expect(taskManager.getTaskState).not.toHaveBeenCalled();
    expect(taskManager.submitBuildTask).not.toHaveBeenCalled();
  });

  it("registers channel uploads as reusable resource envelopes", async () => {
    const engine = makeEngine();
    const app = makeApp(engine);
    const sourcePath = writeSourceFile(engine.rootDir, "media/shot.png", "png-bytes");

    const response = await app.request("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paths: [sourcePath],
        resourceScope: "channel",
        channelId: "ch_design",
      }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.uploads[0]).toMatchObject({
      name: "shot.png",
      fileId: expect.stringMatching(/^sf_/),
      resource: {
        schemaVersion: 1,
        studioId: "studio_upload_test",
        source: "session_file",
        type: "file",
        links: {
          self: expect.stringMatching(/^\/api\/resources\/res_sf_/),
          content: expect.stringMatching(/^\/api\/resources\/res_sf_/),
        },
      },
    });
    expect(data.uploads[0].resource.resourceId).toBe(`res_${data.uploads[0].fileId}`);
    expect(fs.existsSync(path.join(engine.agentsDir, "_channels", "sessions", "ch_design.jsonl.files.json"))).toBe(true);
  });
});
