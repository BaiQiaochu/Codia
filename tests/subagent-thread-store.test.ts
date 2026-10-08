import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SubagentThreadStore,
  SUBAGENT_THREAD_STORE_VERSION,
} from "../lib/subagent-thread-store.js";

describe("SubagentThreadStore", () => {
  let tempDir;
  let storePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-subagent-threads-"));
    storePath = path.join(tempDir, "subagent-threads.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("records a direct thread, attaches its child session, then keeps it open for follow-up", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("subagent-1", {
      kind: "direct",
      parentSessionPath: "/parent.jsonl",
      agentId: "gsap",
      label: "探索一",
      access: "read",
      summary: "read files",
    });
    store.attachSession("subagent-1", "/child.jsonl");
    store.finishRun("subagent-1", { status: "resolved", summary: "done", close: false });

    expect(store.get("subagent-1")).toMatchObject({
      threadId: "subagent-1",
      kind: "direct",
      status: "open",
      lastRunStatus: "resolved",
      parentSessionPath: "/parent.jsonl",
      agentId: "gsap",
      childSessionPath: "/child.jsonl",
      label: "探索一",
      access: "read",
      summary: "done",
      runCount: 1,
    });
    expect(store.get("subagent-1").closedAt).toBeNull();
  });

  it("keeps direct threads open across runs and increments runCount", () => {
    const store = new SubagentThreadStore(storePath);
    const threadId = "subagent-thread-1";

    store.beginRun(threadId, {
      kind: "direct",
      parentSessionPath: "/parent.jsonl",
      agentId: "butter",
      label: "探索一",
      access: "read",
    });
    store.attachSession(threadId, "/child.jsonl");
    store.finishRun(threadId, { status: "resolved", summary: "first", close: false });
    store.beginRun(threadId, {
      kind: "direct",
      parentSessionPath: "/parent.jsonl",
      agentId: "butter",
      label: "探索一",
      access: "read",
    });
    expect(store.get(threadId)).toMatchObject({
      status: "open",
      lastRunStatus: "pending",
      runCount: 2,
    });
    store.finishRun(threadId, { status: "resolved", summary: "second", close: false });

    expect(store.get(threadId)).toMatchObject({
      kind: "direct",
      status: "open",
      lastRunStatus: "resolved",
      childSessionPath: "/child.jsonl",
      label: "探索一",
      access: "read",
      runCount: 2,
    });
    expect(store.get(threadId).closedAt).toBeNull();
  });

  it("persists and reloads thread records with schema version", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("workflow-1::node-1", {
      kind: "workflow_node",
      parentTaskId: "workflow-1",
      nodeId: "node-1",
      parentSessionPath: "/parent.jsonl",
      agentId: "gsap",
      label: "探索",
    });
    store.attachSession("workflow-1::node-1", "/child.jsonl");

    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(onDisk.schemaVersion).toBe(SUBAGENT_THREAD_STORE_VERSION);

    const restored = new SubagentThreadStore(storePath);
    expect(restored.get("workflow-1::node-1")).toMatchObject({
      kind: "workflow_node",
      parentTaskId: "workflow-1",
      nodeId: "node-1",
      label: "探索",
      childSessionPath: "/child.jsonl",
    });
  });

  it("removes all threads owned by a parent session", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("a", { kind: "direct", parentSessionPath: "/s/a.jsonl" });
    store.beginRun("b", { kind: "workflow_node", parentSessionPath: "/s/a.jsonl" });
    store.beginRun("c", { kind: "direct", parentSessionPath: "/s/b.jsonl" });

    expect(store.removeBySession("/s/a.jsonl")).toBe(2);
    expect(store.get("a")).toBeNull();
    expect(store.get("b")).toBeNull();
    expect(store.get("c")).toBeTruthy();
  });

  it("attachSession persists childSessionId alongside the child locator", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("subagent-child-id", {
      kind: "direct",
      parentSessionPath: "/parent.jsonl",
      agentId: "gsap",
    });
    store.attachSession("subagent-child-id", "/child.jsonl", {
      childSessionId: "sess_child_thread",
    });

    const restored = new SubagentThreadStore(storePath);
    expect(restored.get("subagent-child-id")).toMatchObject({
      childSessionId: "sess_child_thread",
      childSessionPath: "/child.jsonl",
    });
  });

  it("matches parent session threads by stable session id after the parent path moves", () => {
    const originalPath = "/sessions/original.jsonl";
    const movedPath = "/sessions/archive/original.jsonl";
    const sessionId = "sess_parent_thread";
    const store = new SubagentThreadStore(storePath, {
      getSessionIdForPath: (sessionPath) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      ),
    });

    store.beginRun("direct-a", { kind: "direct", parentSessionPath: originalPath });
    store.beginRun("workflow-a", { kind: "workflow_node", parentSessionPath: originalPath });
    store.beginRun("direct-b", { kind: "direct", parentSessionPath: "/sessions/other.jsonl" });

    expect(store.listOpenDirectBySession(movedPath).map((thread) => thread.threadId)).toEqual(["direct-a"]);
    expect(store.removeBySession(movedPath)).toBe(2);
    expect(store.get("direct-a")).toBeNull();
    expect(store.get("workflow-a")).toBeNull();
    expect(store.get("direct-b")).toBeTruthy();
  });

  it("rehydrates orphan pending runs as failed without closing direct threads", () => {
    fs.writeFileSync(storePath, JSON.stringify({
      schemaVersion: SUBAGENT_THREAD_STORE_VERSION,
      threads: {
        "subagent-1": {
          threadId: "subagent-1",
          kind: "direct",
          status: "open",
          lastRunStatus: "pending",
          parentSessionPath: "/s/a.jsonl",
          runCount: 1,
          createdAt: "2026-06-01T00:00:00.000Z",
          lastRunAt: "2026-06-01T00:01:00.000Z",
        },
        "workflow-1::node-1": {
          threadId: "workflow-1::node-1",
          kind: "workflow_node",
          status: "open",
          lastRunStatus: "pending",
          parentSessionPath: "/s/a.jsonl",
          runCount: 2,
          createdAt: "2026-06-01T00:00:00.000Z",
          lastRunAt: "2026-06-01T00:02:00.000Z",
        },
      },
    }, null, 2));

    const store = new SubagentThreadStore(storePath);

    expect(store.get("subagent-1")).toMatchObject({
      kind: "direct",
      status: "open",
      lastRunStatus: "failed",
      closedAt: null,
    });
    expect(store.get("workflow-1::node-1")).toMatchObject({
      kind: "workflow_node",
      status: "closed",
      lastRunStatus: "failed",
      closedAt: "2026-06-01T00:02:00.000Z",
    });
  });

  it("normalizes legacy ephemeral/reusable threads to direct and maps instance to label on read", () => {
    fs.writeFileSync(storePath, JSON.stringify({
      schemaVersion: SUBAGENT_THREAD_STORE_VERSION,
      threads: {
        "subagent-old": {
          threadId: "subagent-old",
          kind: "ephemeral",
          status: "closed",
          lastRunStatus: "resolved",
          parentSessionPath: "/s/a.jsonl",
        },
        "reusable::/s/a.jsonl::butter::探索": {
          threadId: "reusable::/s/a.jsonl::butter::探索",
          kind: "reusable",
          status: "open",
          lastRunStatus: "resolved",
          parentSessionPath: "/s/a.jsonl",
          instance: "探索",
          reuseKey: "/s/a.jsonl::butter::探索",
        },
      },
    }, null, 2));

    const store = new SubagentThreadStore(storePath);

    expect(store.get("subagent-old")).toMatchObject({
      kind: "direct",
      status: "closed",
    });
    expect(store.get("reusable::/s/a.jsonl::butter::探索")).toMatchObject({
      kind: "direct",
      status: "open",
      label: "探索",
    });
    expect(store.get("reusable::/s/a.jsonl::butter::探索").instance).toBeUndefined();
    expect(store.get("reusable::/s/a.jsonl::butter::探索").reuseKey).toBeUndefined();
  });

  it("lists open direct threads for one parent session and excludes workflow nodes", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("subagent-a", {
      kind: "direct",
      parentSessionPath: "/s/a.jsonl",
      agentId: "gsap",
      agentName: "G-SAP",
      label: "探索一",
      access: "read",
      summary: "读完生命周期代码",
    });
    store.finishRun("subagent-a", { status: "resolved", summary: "可继续", close: false });
    store.beginRun("subagent-b", {
      kind: "direct",
      parentSessionPath: "/s/b.jsonl",
      agentId: "gsap",
      label: "探索一",
      access: "read",
    });
    store.beginRun("workflow-1::node-1", {
      kind: "workflow_node",
      parentSessionPath: "/s/a.jsonl",
      label: "探索",
    });

    expect(store.listOpenDirectBySession("/s/a.jsonl")).toEqual([
      expect.objectContaining({
        threadId: "subagent-a",
        kind: "direct",
        status: "open",
        agentName: "G-SAP",
        label: "探索一",
        access: "read",
        summary: "可继续",
      }),
    ]);
  });

  it("closes a direct thread explicitly and rejects closing workflow nodes through direct close", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("subagent-a", { kind: "direct", parentSessionPath: "/s/a.jsonl" });
    store.beginRun("workflow-1::node-1", { kind: "workflow_node", parentSessionPath: "/s/a.jsonl" });

    expect(store.closeDirectThread("subagent-a", { summary: "不用了" })).toMatchObject({
      threadId: "subagent-a",
      status: "closed",
      summary: "不用了",
    });
    expect(store.closeDirectThread("workflow-1::node-1", { summary: "x" })).toBeNull();
  });

  it("serializes work per direct thread without blocking different threads", async () => {
    const store = new SubagentThreadStore(storePath);
    const order = [];
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });

    const p1 = store.runSerialized("subagent-a", async () => {
      order.push("a1-start");
      await gateA;
      order.push("a1-end");
    });
    const p2 = store.runSerialized("subagent-a", async () => {
      order.push("a2-start");
    });
    const p3 = store.runSerialized("subagent-b", async () => {
      order.push("b-start");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["a1-start", "b-start"]);
    expect(store.isBusy("subagent-a")).toBe(true);

    releaseA();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(["a1-start", "b-start", "a1-end", "a2-start"]);
    expect(store.isBusy("subagent-a")).toBe(false);
  });
});
