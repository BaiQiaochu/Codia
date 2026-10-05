import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import path from "node:path";
import { retryImageTask, runSubmitInBackground } from "../plugins/image-gen/lib/image-task-runner.js";
import registerTaskRoutes from "../plugins/image-gen/routes/tasks.js";

async function flushBackgroundSubmits() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeFailedTask(overrides = {}) {
  return {
    taskId: "task-img",
    adapterId: "fake-provider",
    batchId: "batch-1",
    type: "image",
    prompt: "same prompt",
    params: {
      type: "image",
      prompt: "same prompt",
      ratio: "16:9",
      resolution: "2k",
      model: "fake-model",
    },
    sessionPath: "/sessions/main.jsonl",
    deliveryTarget: null,
    adapterTaskId: "old-provider-task",
    submitState: "failed",
    status: "failed",
    failReason: "API returned no images",
    files: ["stale.png"],
    sessionFiles: [{ fileId: "old-file" }],
    imageWidth: 1024,
    imageHeight: 1024,
    retryCount: 1,
    createdAt: "2026-05-24T00:00:00.000Z",
    completedAt: "2026-05-24T00:01:00.000Z",
    ...overrides,
  };
}

function makeCtx(task, adapterOverrides = {}) {
  const adapter = {
    id: "fake-provider",
    submit: vi.fn(async () => ({ taskId: "retry-provider-task" })),
    ...adapterOverrides,
  };
  const store = {
    get: vi.fn(() => ({ ...task })),
    update: vi.fn((taskId, patch) => {
      if (taskId !== task.taskId) return null;
      Object.assign(task, patch);
      return { ...task };
    }),
  };
  const registry = {
    get: vi.fn((adapterId) => (adapterId === adapter.id ? adapter : null)),
  };
  const poller = {
    add: vi.fn(),
    checkNow: vi.fn(),
  };
  const bus = {
    request: vi.fn(async () => ({})),
  };
  const ctx = {
    _mediaGen: { registry, store, poller },
    dataDir: "/tmp/image-gen",
    bus,
    config: { get: vi.fn() },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
  return { ctx, adapter, store, registry, poller, bus };
}

describe("image generation retry", () => {
  it("reopens a failed image task with the same parameters and taskId", async () => {
    const task = makeFailedTask();
    const { ctx, adapter, store, poller, bus } = makeCtx(task);

    const result = await retryImageTask({ taskId: "task-img", ctx });

    expect(result).toMatchObject({
      ok: true,
      taskId: "task-img",
      placeholder: {
        type: "media_generation",
        taskId: "task-img",
        kind: "image",
        status: "pending",
        prompt: "same prompt",
      },
    });
    expect(bus.request).toHaveBeenCalledWith("deferred:retry", expect.objectContaining({
      taskId: "task-img",
      sessionPath: "/sessions/main.jsonl",
      sessionId: null,
      sessionRef: null,
      meta: expect.objectContaining({
        type: "image-generation",
        mediaKind: "image",
        deliveryIntent: "ui_only",
        triggerParentTurn: false,
        prompt: "same prompt",
      }),
    }));
    expect(store.update).toHaveBeenCalledWith("task-img", expect.objectContaining({
      status: "pending",
      failReason: null,
      submitState: "submitting",
      adapterTaskId: null,
      files: [],
      sessionFiles: [],
      imageWidth: null,
      imageHeight: null,
      createdAt: expect.any(String),
      completedAt: null,
      retryCount: 2,
    }));
    const retryPatch = store.update.mock.calls.find(([id, patch]) => id === "task-img" && patch?.status === "pending")?.[1];
    expect(retryPatch.createdAt).not.toBe("2026-05-24T00:00:00.000Z");
    expect(poller.add).toHaveBeenCalledWith("task-img");

    await flushBackgroundSubmits();

    expect(adapter.submit).toHaveBeenCalledWith(task.params, expect.objectContaining({
      generatedDir: path.join("/tmp/image-gen", "generated"),
      bus,
      log: ctx.log,
      config: ctx.config,
    }));
    expect(store.update).toHaveBeenCalledWith("task-img", expect.objectContaining({
      submitState: "submitted",
      adapterTaskId: "retry-provider-task",
    }));
  });

  it("automatically retries transient submit failures before marking the task failed", async () => {
    const task = makeFailedTask({
      status: "pending",
      submitState: "submitting",
      failReason: null,
      files: [],
      sessionFiles: [],
    });
    const transientError = new Error("API error 524: <!DOCTYPE html><title>m7ai.com | 524: A timeout occurred</title>");
    const { ctx, adapter, store, poller } = makeCtx(task, {
      submit: vi.fn()
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({ taskId: "provider-task-after-retry" }),
    });

    await runSubmitInBackground({
      taskId: "task-img",
      adapter,
      params: task.params,
      submitCtx: {
        dataDir: "/tmp/image-gen",
        bus: ctx.bus,
        log: ctx.log,
        generatedDir: path.join("/tmp/image-gen", "generated"),
        config: ctx.config,
      },
      store,
      poller,
      ctx,
    });

    expect(adapter.submit).toHaveBeenCalledTimes(2);
    expect(store.update).toHaveBeenCalledWith("task-img", expect.objectContaining({
      submitState: "submitting",
      submitRetryCount: 1,
      lastTransientError: transientError.message,
    }));
    expect(store.update).toHaveBeenCalledWith("task-img", expect.objectContaining({
      submitState: "submitted",
      adapterTaskId: "provider-task-after-retry",
    }));
    expect(store.update).not.toHaveBeenCalledWith("task-img", expect.objectContaining({
      status: "failed",
    }));
  });

  it("does not automatically retry non-transient submit failures", async () => {
    const task = makeFailedTask({
      status: "pending",
      submitState: "submitting",
      failReason: null,
      files: [],
      sessionFiles: [],
    });
    const authError = new Error("API error 401: Invalid token");
    const { ctx, adapter, store, poller } = makeCtx(task, {
      submit: vi.fn().mockRejectedValue(authError),
    });

    await runSubmitInBackground({
      taskId: "task-img",
      adapter,
      params: task.params,
      submitCtx: {
        dataDir: "/tmp/image-gen",
        bus: ctx.bus,
        log: ctx.log,
        generatedDir: path.join("/tmp/image-gen", "generated"),
        config: ctx.config,
      },
      store,
      poller,
      ctx,
    });

    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledWith("task-img", expect.objectContaining({
      status: "failed",
      failReason: authError.message,
      submitState: "failed",
    }));
  });

  it("rejects tasks that are already pending", async () => {
    const task = makeFailedTask({ status: "pending", submitState: "submitted" });
    const { ctx, adapter, store, poller, bus } = makeCtx(task);

    const result = await retryImageTask({ taskId: "task-img", ctx });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "task is already running",
    });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(poller.add).not.toHaveBeenCalled();
    expect(bus.request).not.toHaveBeenCalled();
  });

  it("exposes retry through the image-gen task route", async () => {
    const task = makeFailedTask();
    const { ctx } = makeCtx(task);
    const app = new Hono();
    registerTaskRoutes(app, ctx);

    const res = await app.request("/tasks/task-img/retry", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      taskId: "task-img",
      placeholder: {
        type: "media_generation",
        taskId: "task-img",
        status: "pending",
      },
    });
  });

  it("reopens a failed video task through the same recoverable task route", async () => {
    const task = makeFailedTask({
      taskId: "task-video",
      type: "video",
      prompt: "same video prompt",
      params: {
        type: "video",
        prompt: "same video prompt",
        model: "fake-video-model",
        image: "file://first-frame.png",
      },
    });
    const { ctx, adapter, store, poller, bus } = makeCtx(task);
    const app = new Hono();
    registerTaskRoutes(app, ctx);

    const res = await app.request("/tasks/task-video/retry", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      taskId: "task-video",
      placeholder: {
        type: "media_generation",
        taskId: "task-video",
        kind: "video",
        status: "pending",
        prompt: "same video prompt",
      },
    });
    expect(bus.request).toHaveBeenCalledWith("deferred:retry", expect.objectContaining({
      taskId: "task-video",
      sessionPath: "/sessions/main.jsonl",
      sessionId: null,
      sessionRef: null,
      meta: expect.objectContaining({
        type: "video-generation",
        mediaKind: "video",
        prompt: "same video prompt",
      }),
    }));
    expect(store.update).toHaveBeenCalledWith("task-video", expect.objectContaining({
      status: "pending",
      failReason: null,
      submitState: "submitting",
      adapterTaskId: null,
      retryCount: 2,
    }));
    expect(poller.add).toHaveBeenCalledWith("task-video");

    await flushBackgroundSubmits();

    expect(adapter.submit).toHaveBeenCalledWith(task.params, expect.objectContaining({
      generatedDir: path.join("/tmp/image-gen", "generated"),
    }));
  });

  it("lists normalized image and video tasks through type filters", async () => {
    const ctx = {
      _mediaGen: {
        store: {
          listAll: vi.fn(() => [
            makeFailedTask({ taskId: "img-1", type: "image", createdAt: "2026-05-24T00:00:00.000Z" }),
            makeFailedTask({ taskId: "vid-1", type: "video", createdAt: "2026-05-24T00:01:00.000Z" }),
          ]),
          listFavorited: vi.fn(() => []),
        },
      },
    };
    const app = new Hono();
    registerTaskRoutes(app, ctx);

    const images = await (await app.request("/tasks?filter=images")).json();
    const videos = await (await app.request("/tasks?filter=videos")).json();

    expect(images.tasks.map((task) => task.taskId)).toEqual(["img-1"]);
    expect(videos.tasks.map((task) => task.taskId)).toEqual(["vid-1"]);
  });
});
