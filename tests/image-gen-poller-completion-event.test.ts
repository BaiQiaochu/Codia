// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../plugins/image-gen/lib/task-store.ts";
import { Poller } from "../plugins/image-gen/lib/poller.ts";

describe("image-gen poller completion event", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-image-poller-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits media-gen:task-done with persisted metadata when an image task succeeds", async () => {
    const generatedDir = path.join(tmpDir, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    const store = new TaskStore(tmpDir);
    const taskId = "task-cover";
    const events = [];
    const bus = {
      emit: vi.fn((event, sessionPath) => events.push({ event, sessionPath })),
      request: vi.fn(async () => ({ ok: true })),
    };
    const adapter = {
      query: vi.fn(async () => ({ status: "success", files: ["cover.png"] })),
    };
    const registry = {
      getProtocol: () => adapter,
      get: () => adapter,
    };
    store.add({
      taskId,
      adapterId: "openai",
      providerId: "openai",
      modelId: "gpt-image-1",
      protocolId: "openai-images",
      batchId: "batch-cover",
      type: "image",
      prompt: "cover prompt",
      params: { type: "image", prompt: "cover prompt", ratio: "3:2" },
      sessionPath: "/sessions/a.jsonl",
      metadata: {
        profile: "markdown-cover",
        cover: { targetFilePath: "/vault/note.md" },
      },
    });

    const poller = new Poller({
      store,
      registry,
      bus,
      generatedDir,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerSessionFile: vi.fn(() => ({ fileId: "sf1", filePath: path.join(generatedDir, "cover.png") })),
    } as any);

    await poller._checkTask(taskId, store.get(taskId));

    expect(events).toEqual([
      expect.objectContaining({
        sessionPath: "/sessions/a.jsonl",
        event: expect.objectContaining({
          type: "media-gen:task-done",
          taskId,
          files: ["cover.png"],
          metadata: {
            profile: "markdown-cover",
            cover: { targetFilePath: "/vault/note.md" },
          },
        }),
      }),
    ]);
  });
});
