// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeferredResultCoordinator } from "../lib/deferred-result-coordinator.js";
import { DeferredResultStore } from "../lib/deferred-result-store.js";

describe("DeferredResultCoordinator", () => {
  let store;
  let sessionCoordinator;
  let coordinator;

  beforeEach(() => {
    store = new DeferredResultStore();
    sessionCoordinator = {
      deliverCustomMessage: vi.fn().mockResolvedValue({ ok: true, mode: "triggerTurn" }),
      recordCustomEntry: vi.fn().mockResolvedValue({ ok: true, mode: "customEntry" }),
    };
    coordinator = new DeferredResultCoordinator({
      store,
      sessionCoordinator,
      retryIntervalMs: 0,
      log: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
    });
    coordinator.start();
  });

  it("delivers resolved task results through hidden custom messages and marks them delivered", async () => {
    store.defer("task-1", "/sessions/a.jsonl", { type: "subagent" });
    store.resolve("task-1", { replyText: "done <ok>" });

    await vi.waitFor(() => {
      expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledOnce();
    });

    const [sessionPath, message, opts] = sessionCoordinator.deliverCustomMessage.mock.calls[0];
    expect(sessionPath).toBe("/sessions/a.jsonl");
    expect(message).toMatchObject({
      customType: "codia-background-result",
      display: false,
    });
    expect(message.content).toContain("task-id=\"task-1\"");
    expect(message.content).toContain("status=\"success\"");
    expect(message.content).toContain("&lt;ok&gt;");
    expect(message.details).toMatchObject({
      schemaVersion: 1,
      taskId: "task-1",
      deliveryId: expect.stringContaining("task-1"),
    });
    expect(opts).toEqual({ triggerTurn: true });
    expect(store.query("task-1")).toMatchObject({ delivered: true });
  });

  it("keeps undelivered tasks when custom message delivery fails", async () => {
    sessionCoordinator.deliverCustomMessage.mockRejectedValueOnce(new Error("session unavailable"));
    store.defer("task-2", "/sessions/a.jsonl", { type: "subagent" });
    store.resolve("task-2", "done");

    await vi.waitFor(() => {
      expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledOnce();
    });

    expect(store.query("task-2")).toMatchObject({ delivered: false });
  });

  it("records UI-only media results as non-context custom entries without waking the parent agent", async () => {
    store.defer("task-ui-only", "/sessions/a.jsonl", {
      type: "image-generation",
      mediaKind: "image",
      deliveryIntent: "ui_only",
      triggerParentTurn: false,
    });
    store.resolve("task-ui-only", { sessionFiles: [{ id: "sf_1" }] });

    await vi.waitFor(() => {
      expect(sessionCoordinator.recordCustomEntry).toHaveBeenCalledOnce();
    });

    expect(sessionCoordinator.deliverCustomMessage).not.toHaveBeenCalled();
    expect(sessionCoordinator.recordCustomEntry).toHaveBeenCalledWith(
      "/sessions/a.jsonl",
      "codia-deferred-result",
      expect.objectContaining({
        schemaVersion: 1,
        taskId: "task-ui-only",
        status: "success",
        type: "image-generation",
        result: { sessionFiles: [{ id: "sf_1" }] },
      }),
    );
    expect(store.query("task-ui-only")).toMatchObject({ delivered: true });
  });

  it("records UI-only interlude results as non-context custom entries when requested", async () => {
    const sessionFile = {
      fileId: "sf_img",
      filePath: "/cache/generated.png",
      mime: "image/png",
      kind: "image",
    };
    store.defer("task-ui-interlude", "/sessions/a.jsonl", {
      type: "subagent",
      interlude: true,
      deliveryIntent: "ui_only",
    });
    store.resolve("task-ui-interlude", { sessionFiles: [sessionFile] });

    await vi.waitFor(() => {
      expect(sessionCoordinator.recordCustomEntry).toHaveBeenCalledOnce();
    });

    expect(sessionCoordinator.deliverCustomMessage).not.toHaveBeenCalled();
    expect(sessionCoordinator.recordCustomEntry).toHaveBeenCalledWith(
      "/sessions/a.jsonl",
      "codia-deferred-result",
      expect.objectContaining({
        schemaVersion: 1,
        taskId: "task-ui-interlude",
        status: "success",
        type: "subagent",
        result: { sessionFiles: [sessionFile] },
      }),
    );
    expect(store.query("task-ui-interlude")).toMatchObject({ delivered: true });
  });

  it("wakes the parent agent when a UI-only image generation task fails with failure notification enabled", async () => {
    store.defer("task-img-fail", "/sessions/a.jsonl", {
      type: "image-generation",
      mediaKind: "image",
      deliveryIntent: "ui_only",
      triggerParentTurn: false,
      notifyAgentOnFailure: true,
      prompt: "moon",
    });
    store.fail("task-img-fail", "quota exhausted");

    await vi.waitFor(() => {
      expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledOnce();
    });

    expect(sessionCoordinator.recordCustomEntry).not.toHaveBeenCalled();
    expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledWith(
      "/sessions/a.jsonl",
      expect.objectContaining({
        customType: "codia-background-result",
        display: false,
        content: expect.stringContaining("status=\"failed\""),
      }),
      { triggerTurn: true },
    );
    expect(sessionCoordinator.deliverCustomMessage.mock.calls[0][1].content).toContain("quota exhausted");
    expect(store.query("task-img-fail")).toMatchObject({ delivered: true });
  });

  it("flushes old undelivered task results without waiting for a new store event", async () => {
    store._tasks.set("task-3", {
      status: "resolved",
      sessionPath: "/sessions/a.jsonl",
      meta: { type: "subagent" },
      deferredAt: Date.now(),
      result: "done",
      reason: null,
      delivered: false,
    });

    await coordinator.flushUndelivered();

    expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledOnce();
    expect(store.query("task-3")).toMatchObject({ delivered: true });
  });

  it("delivers aborted tasks without triggering the parent agent turn", async () => {
    store.defer("task-4", "/sessions/a.jsonl", { type: "subagent" });
    store.abort("task-4", "user stopped");

    await vi.waitFor(() => {
      expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledOnce();
    });

    expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledWith(
      "/sessions/a.jsonl",
      expect.objectContaining({ customType: "codia-background-result" }),
      { triggerTurn: false },
    );
    expect(store.query("task-4")).toMatchObject({ delivered: true });
  });

  it("suppresses old undelivered results when the parent session is no longer runnable", async () => {
    sessionCoordinator.isRunnableSessionPath = vi.fn(() => false);
    store._tasks.set("task-5", {
      status: "resolved",
      sessionPath: "/sessions/archived/a.jsonl",
      meta: { type: "subagent" },
      deferredAt: Date.now(),
      result: "done",
      reason: null,
      delivered: false,
    });

    await coordinator.flushUndelivered();

    expect(sessionCoordinator.deliverCustomMessage).not.toHaveBeenCalled();
    expect(store.query("task-5")).toMatchObject({
      delivered: true,
      deliverySuppressed: true,
    });
  });

  it("leaves bridge-targeted results for bridge delivery instead of suppressing them as non-desktop sessions", async () => {
    sessionCoordinator.isRunnableSessionPath = vi.fn(() => false);
    store._tasks.set("task-bridge", {
      status: "resolved",
      sessionPath: "/agents/codia/sessions/bridge/owner/chat.jsonl",
      meta: {
        type: "image-generation",
        deliveryIntent: "ui_only",
        deliveryTarget: { kind: "bridge", platform: "wechat", chatId: "wx-user" },
      },
      deferredAt: Date.now(),
      result: { sessionFiles: [{ id: "sf_bridge" }] },
      reason: null,
      delivered: false,
    });

    await coordinator.flushUndelivered();

    expect(sessionCoordinator.deliverCustomMessage).not.toHaveBeenCalled();
    expect(sessionCoordinator.recordCustomEntry).not.toHaveBeenCalled();
    expect(store.query("task-bridge")).toMatchObject({ delivered: false });
    expect(store.query("task-bridge").deliverySuppressed).toBeUndefined();
  });
});
