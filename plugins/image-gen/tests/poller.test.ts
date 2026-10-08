/**
 * image-gen/tests/poller.test.js
 *
 * Tests for lib/poller.js: shouldCheckThisTick pure function and the
 * Poller class with injectable registry, fake timers, and fake-async detection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shouldCheckThisTick, Poller } from "../lib/poller.ts";

// Mock readImageSize so poller tests don't depend on real file I/O.
vi.mock("../lib/image-size.js", () => ({
  readImageSize: vi.fn(async () => null),
}));

// ── shouldCheckThisTick ──────────────────────────────────────────────────────

describe("shouldCheckThisTick", () => {
  it("always returns true for age < 2 min", () => {
    const age = 60 * 1000; // 1 min
    expect(shouldCheckThisTick(age, 1)).toBe(true);
    expect(shouldCheckThisTick(age, 2)).toBe(true);
    expect(shouldCheckThisTick(age, 5)).toBe(true);
  });

  it("returns true only every 3rd tick for age 2-10 min", () => {
    const age = 5 * 60 * 1000; // 5 min
    expect(shouldCheckThisTick(age, 3)).toBe(true);
    expect(shouldCheckThisTick(age, 6)).toBe(true);
    expect(shouldCheckThisTick(age, 1)).toBe(false);
    expect(shouldCheckThisTick(age, 2)).toBe(false);
    expect(shouldCheckThisTick(age, 4)).toBe(false);
  });

  it("returns true only every 6th tick for age >= 10 min", () => {
    const age = 15 * 60 * 1000; // 15 min
    expect(shouldCheckThisTick(age, 6)).toBe(true);
    expect(shouldCheckThisTick(age, 12)).toBe(true);
    expect(shouldCheckThisTick(age, 1)).toBe(false);
    expect(shouldCheckThisTick(age, 3)).toBe(false);
    expect(shouldCheckThisTick(age, 5)).toBe(false);
  });
});

// ── Poller class ─────────────────────────────────────────────────────────────

function makeAdapter(overrides: Record<string, any> = {}) {
  return {
    id: "test-adapter",
    types: ["image"],
    query: vi.fn(async () => ({ status: "pending" })),
    ...overrides,
  };
}

function makePoller(overrides: Record<string, any> = {}) {
  const mockAdapter = overrides.adapter ?? makeAdapter();

  const mockStore = {
    listPending: vi.fn(() => []),
    get: vi.fn(() => null),
    update: vi.fn(() => null),
    ...overrides.store,
  };
  const mockBus = {
    request: vi.fn(async () => {}),
    ...overrides.bus,
  };
  const mockRegistry = {
    get: vi.fn(() => mockAdapter),
    ...overrides.registry,
  };
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides.log,
  };

  const poller = new Poller({
    store: mockStore,
    registry: mockRegistry,
    bus: mockBus,
    dataDir: "/tmp/image-gen",
    generatedDir: "/tmp/image-gen-generated",
    log,
    registerSessionFile: overrides.registerSessionFile,
  });

  return { poller, mockStore, mockBus, mockRegistry, mockAdapter, log };
}

describe("Poller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── start / stop ───────────────────────────────────────────────────────────

  it("starts and stops without error", () => {
    const { poller } = makePoller();
    expect(() => poller.start()).not.toThrow();
    expect(() => poller.stop()).not.toThrow();
  });

  it("does not let logger failures break recovery, cancellation, or polling", async () => {
    const log = {
      info: vi.fn(() => { throw new Error("info logger failed"); }),
      warn: vi.fn(() => { throw new Error("warn logger failed"); }),
      error: vi.fn(() => { throw new Error("error logger failed"); }),
    };
    const mockAdapter = makeAdapter({
      query: vi.fn(async () => {
        throw new Error("provider temporarily unavailable");
      }),
    });
    const now = new Date().toISOString();
    const { poller, mockStore } = makePoller({
      adapter: mockAdapter,
      log,
      store: {
        listPending: vi.fn(() => [{
          taskId: "recovered",
          status: "pending",
          createdAt: now,
          adapterId: "test-adapter",
        }]),
      },
    });

    expect(() => poller.start()).not.toThrow();

    poller.add("cancel-me");
    mockStore.get.mockReturnValueOnce({ taskId: "cancel-me", status: "pending", createdAt: now });
    expect(() => poller.cancel("cancel-me")).not.toThrow();

    poller.add("query-me");
    mockStore.get.mockReturnValueOnce({
      taskId: "query-me",
      status: "pending",
      createdAt: now,
      adapterId: "test-adapter",
    });
    await expect(poller.checkNow("query-me")).resolves.toBeUndefined();

    poller.stop();
  });

  it("stop is idempotent", () => {
    const { poller } = makePoller();
    poller.start();
    poller.stop();
    expect(() => poller.stop()).not.toThrow();
  });

  it("running is false before start and after stop", () => {
    const { poller } = makePoller();
    expect(poller.running).toBe(false);
    poller.start();
    expect(poller.running).toBe(true);
    poller.stop();
    expect(poller.running).toBe(false);
  });

  // ── add / hasPending ───────────────────────────────────────────────────────

  it("adds a taskId and reports it as pending", () => {
    const { poller } = makePoller();
    poller.start();
    poller.add("task1");
    expect(poller.hasPending("task1")).toBe(true);
    poller.stop();
  });

  it("returns false for unknown taskId", () => {
    const { poller } = makePoller();
    expect(poller.hasPending("nonexistent")).toBe(false);
  });

  // ── fake-async: task already has files ────────────────────────────────────

  it("skips adapter.query and marks success when task already has files", async () => {
    const mockAdapter = makeAdapter();
    const { poller, mockStore, mockBus } = makePoller({ adapter: mockAdapter });

    mockStore.get.mockReturnValue({
      taskId: "task1",
      adapterId: "test-adapter",
      status: "pending",
      files: ["img1.png", "img2.png"],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task1");

    await vi.advanceTimersByTimeAsync(5_000);

    // Adapter query must NOT be called
    expect(mockAdapter.query).not.toHaveBeenCalled();

    // Store must be updated to done
    expect(mockStore.update).toHaveBeenCalledWith(
      "task1",
      expect.objectContaining({ status: "done" })
    );

    // Bus must receive deferred:resolve with the existing files
    expect(mockBus.request).toHaveBeenCalledWith(
      "deferred:resolve",
      expect.objectContaining({ taskId: "task1", files: ["img1.png", "img2.png"] })
    );

    expect(poller.hasPending("task1")).toBe(false);

    poller.stop();
  });

  it("registers completed files as session files before resolving", async () => {
    const registerSessionFile = vi.fn(() => ({
      fileId: "sf_generated",
      filePath: "/tmp/image-gen-generated/img1.png",
      label: "img1.png",
    }));
    const { poller, mockStore, mockBus } = makePoller({ registerSessionFile });

    mockStore.get.mockReturnValue({
      taskId: "task1",
      adapterId: "test-adapter",
      status: "pending",
      sessionPath: "/sessions/test.jsonl",
      files: ["img1.png"],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task1");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/sessions/test.jsonl",
      filePath: expect.stringMatching(/[\\/]tmp[\\/]image-gen-generated[\\/]img1\.png$/),
      label: "img1.png",
      origin: "plugin_output",
      storageKind: "plugin_data",
    }));
    expect(mockStore.update).toHaveBeenCalledWith(
      "task1",
      expect.objectContaining({
        sessionFiles: [expect.objectContaining({ fileId: "sf_generated" })],
      }),
    );
    expect(mockBus.request).toHaveBeenCalledWith(
      "deferred:resolve",
      expect.objectContaining({
        taskId: "task1",
        files: ["img1.png"],
        sessionFiles: [expect.objectContaining({ fileId: "sf_generated" })],
      }),
    );

    poller.stop();
  });

  // ── real async: task without files → adapter.query ────────────────────────

  it("does not register session files or resolve deferred results for response delivery tasks", async () => {
    const registerSessionFile = vi.fn();
    const { poller, mockStore, mockBus } = makePoller({ registerSessionFile });

    mockStore.get.mockReturnValue({
      taskId: "task-response",
      adapterId: "test-adapter",
      status: "pending",
      sessionPath: null,
      deliveryMode: "response",
      delivery: { mode: "response" },
      files: ["response.png"],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task-response");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(registerSessionFile).not.toHaveBeenCalled();
    expect(mockStore.update).toHaveBeenCalledWith(
      "task-response",
      expect.objectContaining({
        status: "done",
        completedAt: expect.any(String),
      }),
    );
    expect(mockBus.request).not.toHaveBeenCalledWith("deferred:resolve", expect.anything());
    expect(mockBus.request).not.toHaveBeenCalledWith("task:remove", expect.anything());

    poller.stop();
  });

  it("falls back to absolute generated file paths when session file registration fails", async () => {
    const registerSessionFile = vi.fn(() => {
      throw new Error("registry unavailable");
    });
    const { poller, mockStore, mockBus } = makePoller({ registerSessionFile });

    mockStore.get.mockReturnValue({
      taskId: "task-fallback",
      adapterId: "test-adapter",
      status: "pending",
      sessionPath: "/sessions/test.jsonl",
      files: ["fallback.png"],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task-fallback");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockBus.request).toHaveBeenCalledWith(
      "deferred:resolve",
      expect.objectContaining({
        taskId: "task-fallback",
        files: ["fallback.png"],
        sessionFiles: [expect.objectContaining({
          filePath: expect.stringMatching(/[\\/]tmp[\\/]image-gen-generated[\\/]fallback\.png$/),
          label: "fallback.png",
          kind: "image",
        })],
      }),
    );

    poller.stop();
  });

  it("calls adapter.query on tick when task has no files", async () => {
    const mockAdapter = makeAdapter({
      query: vi.fn(async () => ({ status: "pending" })),
    });
    const { poller, mockStore } = makePoller({ adapter: mockAdapter });

    mockStore.get.mockReturnValue({
      taskId: "task1",
      adapterId: "test-adapter",
      status: "pending",
      files: [],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task1");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockAdapter.query).toHaveBeenCalledWith(
      "task1",
      expect.objectContaining({ generatedDir: "/tmp/image-gen-generated" })
    );

    poller.stop();
  });

  it("queries provider task id when it differs from the local placeholder task id", async () => {
    const mockAdapter = makeAdapter({
      query: vi.fn(async () => ({ status: "pending" })),
    });
    const { poller, mockStore } = makePoller({ adapter: mockAdapter });

    mockStore.get.mockReturnValue({
      taskId: "local-task",
      adapterTaskId: "remote-task",
      adapterId: "test-adapter",
      submitState: "submitted",
      status: "pending",
      files: [],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("local-task");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockAdapter.query).toHaveBeenCalledWith(
      "remote-task",
      expect.objectContaining({ generatedDir: "/tmp/image-gen-generated" }),
    );

    poller.stop();
  });

  it("does not query a task while provider submit is still in progress", async () => {
    const mockAdapter = makeAdapter({
      query: vi.fn(async () => ({ status: "pending" })),
    });
    const { poller, mockStore } = makePoller({ adapter: mockAdapter });

    mockStore.get.mockReturnValue({
      taskId: "local-task",
      adapterTaskId: null,
      adapterId: "test-adapter",
      submitState: "submitting",
      status: "pending",
      files: [],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("local-task");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockAdapter.query).not.toHaveBeenCalled();
    expect(poller.hasPending("local-task")).toBe(true);

    poller.stop();
  });

  it("checkNow immediately checks an active task", async () => {
    const mockAdapter = makeAdapter({
      query: vi.fn(async () => ({ status: "success", files: ["now.png"] })),
    });
    const { poller, mockStore } = makePoller({ adapter: mockAdapter });

    mockStore.get.mockReturnValue({
      taskId: "task-now",
      adapterId: "test-adapter",
      status: "pending",
      files: [],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task-now");

    await poller.checkNow("task-now");

    expect(mockAdapter.query).toHaveBeenCalledWith(
      "task-now",
      expect.objectContaining({ generatedDir: "/tmp/image-gen-generated" }),
    );
    expect(mockStore.update).toHaveBeenCalledWith(
      "task-now",
      expect.objectContaining({ status: "done", files: ["now.png"] }),
    );

    poller.stop();
  });

  it("updates store, emits deferred:resolve, and removes from active on adapter success", async () => {
    const mockAdapter = makeAdapter({
      query: vi.fn(async () => ({
        status: "success",
        files: ["abc.png", "def.png"],
      })),
    });

    const { poller, mockStore, mockBus } = makePoller({ adapter: mockAdapter });

    mockStore.get.mockReturnValue({
      taskId: "task1",
      adapterId: "test-adapter",
      status: "pending",
      files: [],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task1");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockStore.update).toHaveBeenCalledWith(
      "task1",
      expect.objectContaining({ status: "done", files: ["abc.png", "def.png"] })
    );
    expect(mockBus.request).toHaveBeenCalledWith(
      "deferred:resolve",
      expect.objectContaining({ taskId: "task1", files: ["abc.png", "def.png"] })
    );
    expect(poller.hasPending("task1")).toBe(false);

    poller.stop();
  });

  it("updates store, emits deferred:fail, and removes from active on adapter failed status", async () => {
    const mockAdapter = makeAdapter({
      query: vi.fn(async () => ({
        status: "failed",
        failReason: "content policy",
      })),
    });

    const { poller, mockStore, mockBus } = makePoller({ adapter: mockAdapter });

    mockStore.get.mockReturnValue({
      taskId: "task1",
      adapterId: "test-adapter",
      status: "pending",
      files: [],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task1");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockStore.update).toHaveBeenCalledWith(
      "task1",
      expect.objectContaining({ status: "failed", failReason: "content policy" })
    );
    expect(mockBus.request).toHaveBeenCalledWith(
      "deferred:fail",
      expect.objectContaining({ taskId: "task1" })
    );
    expect(poller.hasPending("task1")).toBe(false);

    poller.stop();
  });

  it("leaves task in active set when adapter returns pending status", async () => {
    const mockAdapter = makeAdapter({
      query: vi.fn(async () => ({ status: "pending" })),
    });

    const { poller, mockStore, mockBus } = makePoller({ adapter: mockAdapter });

    mockStore.get.mockReturnValue({
      taskId: "task1",
      adapterId: "test-adapter",
      status: "pending",
      files: [],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task1");

    await vi.advanceTimersByTimeAsync(5_000);

    // Still pending, not resolved or failed
    expect(mockBus.request).not.toHaveBeenCalled();
    expect(poller.hasPending("task1")).toBe(true);

    poller.stop();
  });

  it("handles adapter.query throwing and emits deferred:fail", async () => {
    const queryError = new Error("network timeout");
    const mockAdapter = makeAdapter({
      query: vi.fn(async () => { throw queryError; }),
    });

    const { poller, mockStore, mockBus } = makePoller({ adapter: mockAdapter });

    mockStore.get.mockReturnValue({
      taskId: "task1",
      adapterId: "test-adapter",
      status: "pending",
      files: [],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task1");

    // MAX_CONSECUTIVE_ERRORS = 5; need 5 ticks to exhaust the retry budget.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(mockStore.update).toHaveBeenCalledWith(
      "task1",
      expect.objectContaining({ status: "failed", failReason: "network timeout" })
    );
    expect(mockBus.request).toHaveBeenCalledWith(
      "deferred:fail",
      expect.objectContaining({ taskId: "task1" })
    );
    expect(poller.hasPending("task1")).toBe(false);

    poller.stop();
  });

  // ── cancel ─────────────────────────────────────────────────────────────────

  it("cancel removes task from active, marks failed in store, and calls deferred:abort + task:remove", () => {
    const { poller, mockStore, mockBus } = makePoller();

    poller.start();
    poller.add("task1");
    expect(poller.hasPending("task1")).toBe(true);

    poller.cancel("task1");

    // Removed from active set
    expect(poller.hasPending("task1")).toBe(false);

    // Store updated to cancelled
    expect(mockStore.update).toHaveBeenCalledWith(
      "task1",
      expect.objectContaining({ status: "cancelled", failReason: "user cancelled" })
    );

    // Bus calls: deferred:abort and task:remove
    expect(mockBus.request).toHaveBeenCalledWith(
      "deferred:abort",
      expect.objectContaining({ taskId: "task1", reason: "user cancelled" })
    );
    expect(mockBus.request).toHaveBeenCalledWith(
      "task:remove",
      expect.objectContaining({ taskId: "task1" })
    );

    poller.stop();
  });

  it("cancel is a no-op for unknown taskId", () => {
    const { poller, mockStore, mockBus } = makePoller();
    poller.start();

    poller.cancel("nonexistent");

    expect(mockStore.update).not.toHaveBeenCalled();
    expect(mockBus.request).not.toHaveBeenCalled();

    poller.stop();
  });

  it("cancelled task is ignored by _checkTask even if query was in-flight", async () => {
    // Simulate: adapter.query is slow, cancel arrives before query returns
    let resolveQuery;
    const mockAdapter = makeAdapter({
      query: vi.fn(() => new Promise((r) => { resolveQuery = r; })),
    });
    const { poller, mockStore, mockBus } = makePoller({ adapter: mockAdapter });

    mockStore.get.mockReturnValue({
      taskId: "task1",
      adapterId: "test-adapter",
      status: "pending",
      files: [],
      createdAt: new Date().toISOString(),
    });

    poller.start();
    poller.add("task1");

    // Trigger tick — adapter.query starts but hasn't resolved
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockAdapter.query).toHaveBeenCalled();

    // Cancel while query is in-flight
    poller.cancel("task1");
    expect(poller.hasPending("task1")).toBe(false);

    // Now resolve the query — _checkTask should bail out due to cancellation fence
    resolveQuery({ status: "success", files: ["img.png"] });
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // deferred:resolve should NOT have been called (only deferred:abort and task:remove from cancel)
    const resolveCall = mockBus.request.mock.calls.find(
      ([type]) => type === "deferred:resolve"
    );
    expect(resolveCall).toBeUndefined();

    poller.stop();
  });

  // ── recover pending from store on start ───────────────────────────────────

  it("recovers pending tasks from the store on start", () => {
    const { poller, mockStore } = makePoller({
      store: {
        listPending: vi.fn(() => [
          { taskId: "recovered1", adapterId: "test-adapter", status: "pending", createdAt: new Date().toISOString() },
          { taskId: "recovered2", adapterId: "test-adapter", status: "pending", createdAt: new Date().toISOString() },
        ]),
        get: vi.fn(() => null),
        update: vi.fn(),
      },
    });

    poller.start();

    expect(poller.hasPending("recovered1")).toBe(true);
    expect(poller.hasPending("recovered2")).toBe(true);

    poller.stop();
  });

  it("marks interrupted background submit tasks failed on start", () => {
    const { poller, mockStore, mockBus } = makePoller({
      store: {
        listPending: vi.fn(() => [
          {
            taskId: "interrupted",
            adapterId: "test-adapter",
            status: "pending",
            submitState: "submitting",
            adapterTaskId: null,
            files: [],
            createdAt: new Date().toISOString(),
          },
        ]),
        get: vi.fn(() => null),
        update: vi.fn(),
      },
    });

    poller.start();

    expect(poller.hasPending("interrupted")).toBe(false);
    expect(mockStore.update).toHaveBeenCalledWith(
      "interrupted",
      expect.objectContaining({
        status: "failed",
        submitState: "failed",
        failReason: expect.stringContaining("provider submission"),
      }),
    );
    expect(mockBus.request).toHaveBeenCalledWith(
      "deferred:fail",
      expect.objectContaining({ taskId: "interrupted" }),
    );

    poller.stop();
  });
});
