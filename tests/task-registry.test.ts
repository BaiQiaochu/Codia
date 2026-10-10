// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRegistry } from "../lib/task-registry.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskRegistry", () => {
  it("registerHandler validates abort method", () => {
    const registry = new TaskRegistry();
    expect(() => registry.registerHandler("test", {})).toThrow("must have an abort");
    expect(() => registry.registerHandler("test", { abort: "not a fn" })).toThrow("must have an abort");
  });

  it("register + query returns task info", () => {
    const registry = new TaskRegistry();
    registry.registerHandler("test", { abort: vi.fn() });
    registry.register("task-1", { type: "test", parentSessionPath: "/parent-1" });

    const task = registry.query("task-1");

    expect(task).toBeTruthy();
    expect(task.type).toBe("test");
    expect(task.parentSessionPath).toBe("/parent-1");
    expect(task.aborted).toBe(false);
  });

  it("abort dispatches to handler and marks the task aborted", () => {
    const registry = new TaskRegistry();
    const abort = vi.fn();
    registry.registerHandler("test", { abort });
    registry.register("task-1", { type: "test", parentSessionPath: "/parent-1" });

    const result = registry.abort("task-1");

    expect(result).toBe("aborted");
    expect(abort).toHaveBeenCalledWith("task-1");
    expect(registry.query("task-1")).toMatchObject({
      aborted: true,
      status: "aborted",
      error: "aborted",
    });
  });

  it("abort with no handler returns no_handler", () => {
    const registry = new TaskRegistry();
    registry.register("task-1", { type: "unknown", parentSessionPath: "/parent-1" });
    expect(registry.abort("task-1")).toBe("no_handler");
  });

  it("abort on unknown taskId returns not_found", () => {
    const registry = new TaskRegistry();
    expect(registry.abort("missing")).toBe("not_found");
  });

  it("double abort returns already_aborted", () => {
    const registry = new TaskRegistry();
    registry.registerHandler("test", { abort: vi.fn() });
    registry.register("task-1", { type: "test", parentSessionPath: "/parent-1" });
    registry.abort("task-1");
    expect(registry.abort("task-1")).toBe("already_aborted");
  });

  it("remove cleans up the task", () => {
    const registry = new TaskRegistry();
    registry.registerHandler("test", { abort: vi.fn() });
    registry.register("task-1", { type: "test", parentSessionPath: "/parent-1" });

    registry.remove("task-1");

    expect(registry.query("task-1")).toBeNull();
  });

  it("unregisterHandler removes abort support", () => {
    const registry = new TaskRegistry();
    registry.registerHandler("test", { abort: vi.fn() });
    registry.unregisterHandler("test");
    registry.register("task-1", { type: "test", parentSessionPath: "/parent-1" });

    expect(registry.abort("task-1")).toBe("no_handler");
  });

  it("listByType filters by type", () => {
    const registry = new TaskRegistry();
    registry.registerHandler("a", { abort: vi.fn() });
    registry.registerHandler("b", { abort: vi.fn() });
    registry.register("task-1", { type: "a", parentSessionPath: "/parent-1" });
    registry.register("task-2", { type: "b", parentSessionPath: "/parent-2" });
    registry.register("task-3", { type: "a", parentSessionPath: "/parent-3" });

    expect(registry.listByType("a").map((task) => task.taskId)).toEqual(["task-1", "task-3"]);
  });

  it("listAll returns all tasks", () => {
    const registry = new TaskRegistry();
    registry.registerHandler("a", { abort: vi.fn() });
    registry.register("task-1", { type: "a", parentSessionPath: "/parent-1" });
    registry.register("task-2", { type: "a", parentSessionPath: "/parent-2" });

    expect(registry.listAll()).toHaveLength(2);
  });

  it("aborts all running tasks for a parent session", () => {
    const registry = new TaskRegistry();
    const abort = vi.fn();
    registry.registerHandler("subagent", { abort });
    registry.register("task-1", {
      type: "subagent",
      parentSessionPath: "/agents/codia/sessions/a.jsonl",
      meta: {},
    });
    registry.register("task-2", {
      type: "subagent",
      parentSessionPath: "/agents/codia/sessions/b.jsonl",
      meta: {},
    });

    const result = registry.abortByParentSession(
      "/agents/codia/sessions/a.jsonl",
      "parent session archived",
    );

    expect(result).toMatchObject({ matched: 1, aborted: 1, skippedFinal: 0 });
    expect(abort).toHaveBeenCalledWith("task-1");
    expect(registry.query("task-1")).toMatchObject({
      status: "aborted",
      aborted: true,
      failureReason: "parent session archived",
    });
    expect(registry.query("task-2")).toMatchObject({ status: "running" });
  });

  it("skips final tasks when aborting by parent session", () => {
    const registry = new TaskRegistry();
    const abort = vi.fn();
    registry.registerHandler("subagent", { abort });
    registry.register("task-1", { type: "subagent", parentSessionPath: "/sessions/a" });
    registry.register("task-2", { type: "subagent", parentSessionPath: "/sessions/b" });
    registry.register("task-3", { type: "subagent", parentSessionPath: "/sessions/a" });
    registry.complete("task-3");

    const result = registry.abortByParentSession("/sessions/a", "parent session archived");

    expect(result).toMatchObject({ matched: 2, aborted: 1, skippedFinal: 1 });
    expect(abort).toHaveBeenCalledWith("task-1");
    expect(abort).not.toHaveBeenCalledWith("task-2");
    expect(registry.query("task-1")).toMatchObject({
      status: "aborted",
      aborted: true,
      error: "parent session archived",
    });
    expect(registry.query("task-2")).toMatchObject({ status: "running", aborted: false });
    expect(registry.query("task-3")).toMatchObject({ status: "completed", aborted: false });
  });

  it("aborts running tasks by stable parent session id after the parent path moves", () => {
    const originalPath = "/agents/codia/sessions/original.jsonl";
    const movedPath = "/agents/codia/sessions/archive/renamed.jsonl";
    const sessionId = "sess_task_registry";
    const registry = new TaskRegistry({
      getSessionIdForPath: (sessionPath) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      ),
    });
    const abort = vi.fn();
    registry.registerHandler("subagent", { abort });
    registry.register("task-1", {
      type: "subagent",
      parentSessionPath: originalPath,
      meta: {},
    });
    registry.register("task-2", {
      type: "subagent",
      parentSessionPath: "/agents/codia/sessions/other.jsonl",
      meta: {},
    });

    const result = registry.abortByParentSession(
      movedPath,
      "parent session archived",
    );

    expect(result).toMatchObject({ matched: 1, aborted: 1, skippedFinal: 0 });
    expect(abort).toHaveBeenCalledWith("task-1");
    expect(abort).not.toHaveBeenCalledWith("task-2");
    expect(registry.query("task-1")).toMatchObject({
      parentSessionId: sessionId,
      status: "aborted",
      aborted: true,
    });
    expect(registry.query("task-2")).toMatchObject({ status: "running" });
  });

  it("update, complete, and fail keep explicit task state", () => {
    const registry = new TaskRegistry();
    registry.registerHandler("render", { abort: vi.fn() });
    registry.register("task-1", {
      type: "render",
      parentSessionPath: "/sessions/a",
      meta: { prompt: "a" },
    });

    registry.update("task-1", {
      status: "running",
      progress: { current: 2, total: 4, message: "half" },
      meta: { model: "image" },
    });

    expect(registry.query("task-1")).toMatchObject({
      status: "running",
      progress: { current: 2, total: 4, percent: 50, message: "half" },
      meta: { prompt: "a", model: "image" },
    });

    registry.complete("task-1", { url: "file.png" });
    expect(registry.query("task-1")).toMatchObject({
      status: "completed",
      result: { url: "file.png" },
    });

    registry.register("task-2", { type: "render", parentSessionPath: "/sessions/a" });
    registry.fail("task-2", "network");
    expect(registry.query("task-2")).toMatchObject({
      status: "failed",
      error: "network",
      failureReason: "network",
    });
  });

  it("cancel delegates to abort handler and marks canceled tasks", () => {
    const registry = new TaskRegistry();
    const abort = vi.fn();
    registry.registerHandler("render", { abort });
    registry.register("task-1", { type: "render", parentSessionPath: "/sessions/a" });

    expect(registry.cancel("task-1", "user")).toEqual({ result: "aborted", canceled: true });
    expect(abort).toHaveBeenCalledWith("task-1");
    expect(registry.query("task-1")).toMatchObject({
      status: "canceled",
      aborted: true,
      error: "user",
      failureReason: "user",
    });
  });

  it("persists tasks and restores active tasks as recovering", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-task-registry-"));
    const persistencePath = path.join(dir, "tasks.json");

    const registry = new TaskRegistry({ persistencePath });
    registry.registerHandler("render", { abort: vi.fn() });
    registry.register("task-1", {
      type: "render",
      parentSessionPath: "/sessions/a",
      meta: { prompt: "a" },
    });
    registry.update("task-1", { progress: { current: 1, total: 4 } });

    const restored = new TaskRegistry({ persistencePath });

    expect(restored.query("task-1")).toMatchObject({
      type: "render",
      parentSessionPath: "/sessions/a",
      status: "recovering",
      progress: { current: 1, total: 4, percent: 25 },
      meta: { prompt: "a" },
    });
  });

  it("runs persisted schedules when their handler is registered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-task-schedules-"));
    const persistencePath = path.join(dir, "tasks.json");

    const first = new TaskRegistry({ persistencePath });
    first.schedule("daily", {
      type: "digest",
      intervalMs: 1000,
      payload: { agentId: "agent-1" },
    });

    const run = vi.fn(async () => ({ ok: true }));
    const restored = new TaskRegistry({ persistencePath });
    restored.registerHandler("digest", { abort: vi.fn(), run });

    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: "daily",
      type: "digest",
      payload: { agentId: "agent-1" },
    }));
    expect(restored.querySchedule("daily")).toMatchObject({
      enabled: true,
      runCount: 1,
      lastResult: { ok: true },
    });
    restored.clearTimers();
  });
});
