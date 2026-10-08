// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeferredResultStore } from "../lib/deferred-result-store.js";

describe("DeferredResultStore", () => {
  let store;
  let mockBus;

  beforeEach(() => {
    mockBus = { emit: vi.fn() };
    store = new DeferredResultStore(mockBus);
  });

  describe("defer + resolve", () => {
    it("registers a task and resolves it", () => {
      store.defer("t1", "/session/a", { type: "image" });
      expect(store.query("t1")).toMatchObject({ status: "pending", sessionPath: "/session/a" });
      store.resolve("t1", { files: ["img.png"] });
      expect(store.query("t1")).toMatchObject({ status: "resolved" });
    });

    it("triggers onResult callback with taskId, sessionPath, result, meta", () => {
      const cb = vi.fn();
      store.onResult(cb);
      store.defer("t1", "/s/a", { type: "img" });
      store.resolve("t1", { files: ["x.png"] });
      expect(cb).toHaveBeenCalledWith("t1", "/s/a", { files: ["x.png"] }, { type: "img" });
    });

    it("emits deferred_result event on EventBus", () => {
      store.defer("t1", "/s/a", { type: "img" });
      store.resolve("t1", { files: ["x.png"] });
      expect(mockBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "deferred_result", taskId: "t1", status: "success" }),
        "/s/a"
      );
    });

    it("ignores duplicate resolve (no-op)", () => {
      const cb = vi.fn();
      store.onResult(cb);
      store.defer("t1", "/s/a", {});
      store.resolve("t1", { a: 1 });
      store.resolve("t1", { a: 2 });
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe("defer + fail", () => {
    it("records failure reason", () => {
      store.defer("t1", "/s/a", { type: "img" });
      store.fail("t1", "credit exhausted");
      expect(store.query("t1")).toMatchObject({ status: "failed", reason: "credit exhausted" });
    });

    it("triggers onFail callback", () => {
      const cb = vi.fn();
      store.onFail(cb);
      store.defer("t1", "/s/a", { type: "img" });
      store.fail("t1", "boom");
      expect(cb).toHaveBeenCalledWith("t1", "/s/a", "boom", { type: "img" });
    });
  });

  describe("retry", () => {
    it("reopens a failed task with fresh pending metadata", () => {
      store.defer("t1", "/s/a", { type: "image" });
      store.fail("t1", "boom");

      store.retry("t1", "/s/a", { type: "image", prompt: "again" });

      expect(store.query("t1")).toMatchObject({
        status: "pending",
        sessionPath: "/s/a",
        meta: { type: "image", prompt: "again" },
        result: null,
        reason: null,
        delivered: false,
      });
    });
  });

  describe("listPending", () => {
    it("returns only pending tasks for the given session", () => {
      store.defer("t1", "/s/a", {});
      store.defer("t2", "/s/b", {});
      store.defer("t3", "/s/a", {});
      store.resolve("t3", {});
      const pending = store.listPending("/s/a");
      expect(pending).toHaveLength(1);
      expect(pending[0].taskId).toBe("t1");
    });
  });

  describe("clearBySession", () => {
    it("removes all pending tasks for a session", () => {
      store.defer("t1", "/s/a", {});
      store.defer("t2", "/s/a", {});
      store.defer("t3", "/s/b", {});
      store.clearBySession("/s/a");
      expect(store.query("t1")).toBeNull();
      expect(store.query("t2")).toBeNull();
      expect(store.query("t3")).not.toBeNull();
    });
  });

  describe("suppressDelivery", () => {
    it("marks completed undelivered tasks as delivered without notifying a parent session", () => {
      store.defer("t1", "/s/a", { type: "image" });
      store.resolve("t1", { files: ["out.png"] });

      expect(store.suppressDelivery("t1", "parent archived")).toBe(true);

      expect(store.query("t1")).toMatchObject({
        delivered: true,
        deliverySuppressed: true,
        suppressionReason: "parent archived",
      });
    });

    it("suppresses pending tasks by session", () => {
      store.defer("pending", "/s/a", { type: "image" });
      store.defer("resolved", "/s/a", { type: "image" });
      store.defer("other", "/s/b", { type: "image" });
      store.resolve("resolved", { files: ["out.png"] });

      expect(store.suppressBySession("/s/a", "session deleted")).toEqual({
        aborted: 1,
        suppressed: 1,
        unchanged: 0,
      });
      expect(store.query("pending")).toMatchObject({
        status: "aborted",
        delivered: true,
        deliverySuppressed: true,
      });
      expect(store.query("resolved")).toMatchObject({
        delivered: true,
        deliverySuppressed: true,
      });
      expect(store.query("other")).toMatchObject({ delivered: false });
    });
  });

  describe("unsubscribe", () => {
    it("onResult returns unsubscribe function", () => {
      const cb = vi.fn();
      const unsub = store.onResult(cb);
      store.defer("t1", "/s/a", {});
      unsub();
      store.resolve("t1", {});
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("query unknown task", () => {
    it("returns null for unknown taskId", () => {
      expect(store.query("nonexistent")).toBeNull();
    });
  });

  describe("summary", () => {
    it("returns aggregate counts for recoverable task states", () => {
      store.defer("pending-1", "/s/a", { type: "image" });
      store.defer("resolved-1", "/s/a", { type: "video" });
      store.defer("failed-1", "/s/b", { type: "plugin" });
      store.defer("aborted-1", "/s/b", { type: "subagent" });

      store.resolve("resolved-1", { files: ["out.png"] });
      store.fail("failed-1", "timeout");
      store.abort("aborted-1", "user canceled");

      expect(store.summary()).toEqual({
        total: 4,
        pending: 1,
        resolved: 1,
        failed: 1,
        aborted: 1,
        delivered: 0,
        undelivered: 3,
      });
    });
  });
});
