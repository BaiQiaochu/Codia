import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowActivityStore, WORKFLOW_ACTIVITY_STORE_VERSION } from "../lib/workflow-activity-store.js";

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-activity-"));
  file = path.join(dir, "workflow-activity.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const wfEntry = (over = {}) => ({
  id: "workflow-1", kind: "workflow", status: "running",
  sessionPath: "/s/a.jsonl", agentId: "hana", summary: "demo",
  startedAt: 1000, finishedAt: null, ...over,
});

describe("WorkflowActivityStore", () => {
  it("upsert + get/list 取回；落盘后新实例能重载（持久化）", () => {
    const store = new WorkflowActivityStore(file);
    store.upsert(wfEntry());
    store.upsert(wfEntry({ id: "workflow-1::n1", kind: "workflow_agent", parentTaskId: "workflow-1", label: "探索" }));
    expect(store.size).toBe(2);
    expect(store.get("workflow-1").summary).toBe("demo");

    // 模拟重启：新实例从同一文件重载
    const reloaded = new WorkflowActivityStore(file);
    expect(reloaded.size).toBe(2);
    expect(reloaded.get("workflow-1::n1")).toMatchObject({ kind: "workflow_agent", parentTaskId: "workflow-1", label: "探索" });
    expect(reloaded.get("workflow-1").status).toBe("running");
  });

  it("落盘格式带 schemaVersion + entries", () => {
    const store = new WorkflowActivityStore(file);
    store.upsert(wfEntry());
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(raw.schemaVersion).toBe(WORKFLOW_ACTIVITY_STORE_VERSION);
    expect(raw.entries["workflow-1"]).toBeTruthy();
  });

  it("upsert 同 id 覆盖（状态推进 running→done）", () => {
    const store = new WorkflowActivityStore(file);
    store.upsert(wfEntry());
    store.upsert(wfEntry({ status: "done", finishedAt: 2000 }));
    expect(store.get("workflow-1").status).toBe("done");
    expect(store.get("workflow-1").finishedAt).toBe(2000);
    expect(store.size).toBe(1);
  });

  it("listBySession 只取该 session；按 path 存取不靠焦点", () => {
    const store = new WorkflowActivityStore(file);
    store.upsert(wfEntry({ id: "a1", sessionPath: "/s/a.jsonl" }));
    store.upsert(wfEntry({ id: "b1", sessionPath: "/s/b.jsonl" }));
    store.upsert(wfEntry({ id: "a2", sessionPath: "/s/a.jsonl" }));
    expect(store.listBySession("/s/a.jsonl").map(e => e.id).sort()).toEqual(["a1", "a2"]);
    expect(store.listBySession("/s/b.jsonl")).toHaveLength(1);
    expect(store.listBySession(null)).toEqual([]);
  });

  it("removeBySession 清掉该 session 并落盘", () => {
    const store = new WorkflowActivityStore(file);
    store.upsert(wfEntry({ id: "a1", sessionPath: "/s/a.jsonl" }));
    store.upsert(wfEntry({ id: "b1", sessionPath: "/s/b.jsonl" }));
    expect(store.removeBySession("/s/a.jsonl")).toBe(1);
    expect(store.get("a1")).toBeNull();
    expect(store.get("b1")).toBeTruthy();
    // 落盘一致
    const reloaded = new WorkflowActivityStore(file);
    expect(reloaded.get("a1")).toBeNull();
    expect(reloaded.get("b1")).toBeTruthy();
  });

  it("prune 删除早于 maxAge 的 entry（按 finishedAt||startedAt），保留新近", () => {
    const store = new WorkflowActivityStore(file);
    const now = 1_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    store.upsert(wfEntry({ id: "old", status: "done", startedAt: now - 5 * day, finishedAt: now - 5 * day }));
    store.upsert(wfEntry({ id: "fresh", status: "done", startedAt: now - 1000, finishedAt: now - 1000 }));
    const removed = store.prune(3 * day, now);
    expect(removed).toBe(1);
    expect(store.get("old")).toBeNull();
    expect(store.get("fresh")).toBeTruthy();
  });

  it("无 id 的 entry 被忽略", () => {
    const store = new WorkflowActivityStore(file);
    expect(store.upsert({ kind: "workflow", sessionPath: "/s/a.jsonl" })).toBeNull();
    expect(store.size).toBe(0);
  });

  it("无持久化路径时纯内存（仍可 upsert/list）", () => {
    const store = new WorkflowActivityStore(null);
    store.upsert(wfEntry());
    expect(store.size).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("损坏 JSON 文件不崩（按空账本起步），且可续写", () => {
    fs.writeFileSync(file, "{ not valid json");
    const store = new WorkflowActivityStore(file);
    expect(store.size).toBe(0);
    // 起空账本后仍可正常写入并重载
    store.upsert(wfEntry());
    expect(store.size).toBe(1);
    const reloaded = new WorkflowActivityStore(file);
    expect(reloaded.get("workflow-1").summary).toBe("demo");
  });
});
