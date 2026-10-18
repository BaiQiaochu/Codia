import { describe, it, expect, vi } from "vitest";
import { ActivityHub } from "../lib/activity-hub.js";

function makeBus() {
  return { emit: vi.fn() };
}

const baseEntry = {
  id: "subagent-1", kind: "subagent", status: "running",
  sessionPath: "/s/a.jsonl", agentId: "a1", agentName: "小花",
  summary: "调研 X", startedAt: 1000,
};

describe("ActivityHub", () => {
  it("upsert 新 entry 后 get/list 能拿到，字段规范化", () => {
    const hub = new ActivityHub();
    hub.upsert(baseEntry);
    expect(hub.get("subagent-1")).toMatchObject({
      id: "subagent-1", kind: "subagent", status: "running",
      sessionPath: "/s/a.jsonl", agentId: "a1", summary: "调研 X", startedAt: 1000,
    });
    expect(hub.list()).toHaveLength(1);
  });

  it("upsert forwards label/access and maps legacy reuseInstance into label only", () => {
    const hub = new ActivityHub();
    hub.upsert({ ...baseEntry, label: "research-1", access: "read" });
    expect(hub.get("subagent-1").label).toBe("research-1");
    expect(hub.get("subagent-1").access).toBe("read");
    hub.upsert({ ...baseEntry, id: "legacy", reuseInstance: "research" });
    expect(hub.get("legacy").label).toBe("research");
    expect(hub.get("legacy").reuseInstance).toBeUndefined();
    hub.upsert({ id: "s2", kind: "subagent", status: "running", sessionPath: "/s/a.jsonl" });
    expect(hub.get("s2").label).toBeNull();
  });

  it("upsert 同 id 合并：running→done 保留 startedAt/sessionPath/summary，补 finishedAt", () => {
    const hub = new ActivityHub();
    hub.upsert(baseEntry);
    hub.upsert({ id: "subagent-1", status: "done", finishedAt: 2000 });
    const e = hub.get("subagent-1");
    expect(e.status).toBe("done");
    expect(e.startedAt).toBe(1000);          // 保留
    expect(e.sessionPath).toBe("/s/a.jsonl"); // 保留
    expect(e.summary).toBe("调研 X");         // 保留
    expect(e.finishedAt).toBe(2000);
  });

  it("listBySession 只返回该 sessionPath 的活动（当前对话过滤）", () => {
    const hub = new ActivityHub();
    hub.upsert({ ...baseEntry, id: "t1", sessionPath: "/s/a.jsonl" });
    hub.upsert({ ...baseEntry, id: "t2", sessionPath: "/s/b.jsonl" });
    hub.upsert({ ...baseEntry, id: "t3", sessionPath: "/s/a.jsonl" });
    expect(hub.listBySession("/s/a.jsonl").map(e => e.id).sort()).toEqual(["t1", "t3"]);
    expect(hub.listBySession("/s/b.jsonl")).toHaveLength(1);
    expect(hub.listBySession(null)).toEqual([]);
  });

  it("filters by stable sessionId when the session path locator moves", () => {
    const hub = new ActivityHub(null, null, {
      getSessionIdForPath: (sessionPath) => (
        sessionPath === "/s/original.jsonl" || sessionPath === "/s/moved.jsonl"
          ? "sess_activity_1"
          : null
      ),
    });
    hub.upsert({ ...baseEntry, id: "t1", sessionPath: "/s/original.jsonl" });
    hub.upsert({ ...baseEntry, id: "t2", sessionPath: "/s/other.jsonl" });

    expect(hub.get("t1")).toMatchObject({
      sessionId: "sess_activity_1",
      sessionPath: "/s/original.jsonl",
    });
    expect(hub.listBySession("/s/moved.jsonl").map(e => e.id)).toEqual(["t1"]);
  });

  it("upsert 广播 agent_activity（带 sessionPath）+ 通知 onChange", () => {
    const bus = makeBus();
    const hub = new ActivityHub(bus);
    const seen = [];
    hub.onChange(e => seen.push(e.id));
    hub.upsert(baseEntry);
    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_activity", entry: expect.objectContaining({ id: "subagent-1" }) }),
      "/s/a.jsonl",
    );
    expect(seen).toEqual(["subagent-1"]);
  });

  it("workflow kind 被接受（subagent/workflow 同一真相源）", () => {
    const hub = new ActivityHub();
    hub.upsert({ id: "workflow-1", kind: "workflow", status: "running", sessionPath: "/s/a.jsonl", summary: "demo" });
    expect(hub.get("workflow-1").kind).toBe("workflow");
  });

  it("normalizes canonical lifecycle statuses while preserving legacy UI status", () => {
    const hub = new ActivityHub();
    hub.upsert({ id: "queued-1", kind: "workflow", status: "queued", sessionPath: "/s/a.jsonl" });
    hub.upsert({ id: "success-1", kind: "workflow", status: "succeeded", sessionPath: "/s/a.jsonl" });
    hub.upsert({ id: "cancelled-1", kind: "subagent", status: "cancelled", sessionPath: "/s/a.jsonl" });

    expect(hub.get("queued-1")).toMatchObject({ status: "running", lifecycleStatus: "queued" });
    expect(hub.get("success-1")).toMatchObject({ status: "done", lifecycleStatus: "succeeded" });
    expect(hub.get("cancelled-1")).toMatchObject({ status: "aborted", lifecycleStatus: "cancelled" });
  });

  it("非法 kind/status 兜底（新建默认 subagent/running）", () => {
    const hub = new ActivityHub();
    hub.upsert({ id: "x", kind: "bogus", status: "weird", sessionPath: "/s/a.jsonl" });
    const e = hub.get("x");
    expect(e.kind).toBe("subagent");
    expect(e.status).toBe("running");
  });

  it("无 id 的 entry 被忽略（不入库、不广播）", () => {
    const bus = makeBus();
    const hub = new ActivityHub(bus);
    expect(hub.upsert({ kind: "subagent", sessionPath: "/s/a.jsonl" })).toBeNull();
    expect(hub.list()).toHaveLength(0);
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it("clearBySession 清掉该 session 的活动（内存回收）", () => {
    const hub = new ActivityHub();
    hub.upsert({ ...baseEntry, id: "t1", sessionPath: "/s/a.jsonl" });
    hub.upsert({ ...baseEntry, id: "t2", sessionPath: "/s/b.jsonl" });
    hub.clearBySession("/s/a.jsonl");
    expect(hub.get("t1")).toBeNull();
    expect(hub.get("t2")).toBeTruthy();
  });

  it("onChange 返回 unsub，取消后不再收到", () => {
    const hub = new ActivityHub();
    const seen = [];
    const unsub = hub.onChange(e => seen.push(e.id));
    hub.upsert({ ...baseEntry, id: "t1" });
    unsub();
    hub.upsert({ ...baseEntry, id: "t2" });
    expect(seen).toEqual(["t1"]);
  });

  it("workflow_agent 子节点：kind 接受 + parentTaskId/label/phaseLabel/childSessionId/tokens 保留，渐进 upsert", () => {
    const hub = new ActivityHub();
    hub.upsert({
      id: "wf-1::node-1", kind: "workflow_agent", status: "running",
      sessionPath: "/s/a.jsonl", parentTaskId: "wf-1", label: "探索",
      phaseLabel: "Find", agentId: "butter", startedAt: 1000,
    });
    // 后补 childSessionId/childSessionPath + tokens（done），不带 parentTaskId/label 也应保留
    hub.upsert({
      id: "wf-1::node-1",
      status: "done",
      childSessionId: "sess_child",
      childSessionPath: "/s/child.jsonl",
      tokens: 1234,
      finishedAt: 2000,
    });
    const e = hub.get("wf-1::node-1");
    expect(e.kind).toBe("workflow_agent");
    expect(e.parentTaskId).toBe("wf-1");
    expect(e.label).toBe("探索");
    expect(e.phaseLabel).toBe("Find");
    expect(e.childSessionId).toBe("sess_child");
    expect(e.childSessionPath).toBe("/s/child.jsonl");
    expect(e.tokens).toBe(1234);
    expect(e.status).toBe("done");
    expect(e.startedAt).toBe(1000);
  });

  it("workflow_step kind is accepted and preserves stepKind", () => {
    const hub = new ActivityHub();
    hub.upsert({
      id: "wf-1::step-1", kind: "workflow_step", status: "running",
      sessionPath: "/s/a.jsonl", parentTaskId: "wf-1", stepKind: "parallel",
      phaseLabel: "Find", startedAt: 1000,
    });
    const e = hub.get("wf-1::step-1");
    expect(e.kind).toBe("workflow_step");
    expect(e.stepKind).toBe("parallel");
    expect(e.phaseLabel).toBe("Find");
    expect(e.parentTaskId).toBe("wf-1");
  });
});

// ── 持久化背书（重启不丢右侧 workflow 卡）──

function makeFakeStore(initial = []) {
  const map = new Map(initial.map((e) => [e.id, { ...e }]));
  const matchesSession = (entry, ref) => {
    if (typeof ref === "string") return entry.sessionPath === ref;
    if (ref?.sessionId) return entry.sessionId === ref.sessionId;
    return !!ref?.sessionPath && entry.sessionPath === ref.sessionPath;
  };
  return {
    upsert: vi.fn((e) => { map.set(e.id, { ...e }); return { ...e }; }),
    removeBySession: vi.fn((sp) => {
      let n = 0;
      for (const [id, e] of map) if (matchesSession(e, sp)) { map.delete(id); n++; }
      return n;
    }),
    list: () => [...map.values()].map((e) => ({ ...e })),
    get: (id) => (map.has(id) ? { ...map.get(id) } : null),
    _map: map,
  };
}

describe("ActivityHub 持久化背书", () => {
  it("workflow / workflow_agent / workflow_step / subagent write through store while heartbeat / cron stay transient", () => {
    const store = makeFakeStore();
    const hub = new ActivityHub(null, store);
    hub.upsert({ id: "wf-1", kind: "workflow", status: "running", sessionPath: "/s/a.jsonl" });
    hub.upsert({ id: "wf-1::n1", kind: "workflow_agent", status: "running", sessionPath: "/s/a.jsonl", parentTaskId: "wf-1" });
    hub.upsert({ id: "step-1", kind: "workflow_step", status: "done", sessionPath: "/s/a.jsonl", parentTaskId: "wf-1", stepKind: "pipeline" });
    hub.upsert({ id: "sub-1", kind: "subagent", status: "running", sessionPath: "/s/a.jsonl" });
    hub.upsert({ id: "hb-1", kind: "heartbeat", status: "running", sessionPath: "/s/a.jsonl" });
    hub.upsert({ id: "cron-1", kind: "cron", status: "running", sessionPath: "/s/a.jsonl" });

    const persistedIds = store.upsert.mock.calls.map((c) => c[0].id);
    expect(persistedIds).toContain("wf-1");
    expect(persistedIds).toContain("wf-1::n1");
    expect(persistedIds).toContain("step-1");
    expect(persistedIds).toContain("sub-1");        // subagent 现在也持久化（右侧子助手卡重启复原）
    expect(persistedIds).not.toContain("hb-1");
    expect(persistedIds).not.toContain("cron-1");
  });

  it("subagent write-through and rehydrate preserve label/access/childSessionPath", () => {
    const store = makeFakeStore();
    const hub1 = new ActivityHub(null, store);
    hub1.upsert({
      id: "sub-1", kind: "subagent", status: "done", sessionPath: "/s/a.jsonl",
      agentId: "butter", agentName: "Butter", label: "research-1", access: "read",
      childSessionPath: "/s/child.jsonl", summary: "调研完成", startedAt: 1, finishedAt: 2,
    });
    // 模拟重启：新 hub 从同一 store 回灌
    const hub2 = new ActivityHub(null, store);
    const e = hub2.get("sub-1");
    expect(e.kind).toBe("subagent");
    expect(e.status).toBe("done");               // 终态原样
    expect(e.label).toBe("research-1");          // display label survives
    expect(e.access).toBe("read");               // access class survives
    expect(e.reuseInstance).toBeUndefined();      // legacy alias is input-only
    expect(e.childSessionPath).toBe("/s/child.jsonl"); // 子会话预览链接保留
    expect(e.agentId).toBe("butter");
  });

  it("subagent 遗留 running → 回灌判孤儿标 failed（不永久转圈）", () => {
    const store = makeFakeStore([
      { id: "sub-orphan", kind: "subagent", status: "running", sessionPath: "/s/a.jsonl", startedAt: 100 },
    ]);
    const hub = new ActivityHub(null, store);
    expect(hub.get("sub-orphan").status).toBe("failed");
    expect(hub.get("sub-orphan").finishedAt).toBeNull();
    expect(hub.get("sub-orphan").lifecycleStatus).toBe("recovery_required");
  });

  it("构造时从 store 回灌；上一进程遗留的 running 判为孤儿 → 标 failed（不再永久转圈）", () => {
    const store = makeFakeStore([
      { id: "wf-done", kind: "workflow", status: "done", sessionPath: "/s/a.jsonl", startedAt: 1000, finishedAt: 2000, summary: "完成的" },
      { id: "wf-orphan", kind: "workflow", status: "running", sessionPath: "/s/a.jsonl", startedAt: 1000, summary: "中断的" },
      { id: "wf-orphan::n1", kind: "workflow_agent", status: "running", sessionPath: "/s/a.jsonl", parentTaskId: "wf-orphan", startedAt: 1000 },
    ]);
    const hub = new ActivityHub(null, store);
    expect(hub.get("wf-done").status).toBe("done");          // 终态原样回灌
    expect(hub.get("wf-orphan").status).toBe("failed");      // 孤儿 running → failed
    expect(hub.get("wf-orphan").finishedAt).toBeNull(); // 不编造外部动作完成时间
    expect(hub.get("wf-orphan").lifecycleStatus).toBe("recovery_required");
    expect(hub.get("wf-orphan::n1").status).toBe("failed");  // 子节点同理
    // 孤儿修正写回 store，保持落盘一致
    expect(store.get("wf-orphan").status).toBe("failed");
  });

  it("rebroadcastSession 重发该 session 的活动（重启后让前端 slice 重新填充）", () => {
    const bus = makeBus();
    const store = makeFakeStore([
      { id: "wf-a", kind: "workflow", status: "done", sessionPath: "/s/a.jsonl", startedAt: 1, finishedAt: 2 },
      { id: "wf-b", kind: "workflow", status: "done", sessionPath: "/s/b.jsonl", startedAt: 1, finishedAt: 2 },
    ]);
    const hub = new ActivityHub(bus, store);
    bus.emit.mockClear(); // 忽略回灌期间可能的 emit
    hub.rebroadcastSession("/s/a.jsonl");
    const emitted = bus.emit.mock.calls.filter((c) => c[0]?.type === "agent_activity").map((c) => c[0].entry.id);
    expect(emitted).toContain("wf-a");
    expect(emitted).not.toContain("wf-b");
  });

  it("clearBySession 同时清 store（会话退场，持久化也回收）", () => {
    const store = makeFakeStore();
    const hub = new ActivityHub(null, store);
    hub.upsert({ id: "wf-1", kind: "workflow", status: "running", sessionPath: "/s/a.jsonl" });
    hub.clearBySession("/s/a.jsonl");
    expect(hub.get("wf-1")).toBeNull();
    expect(store.removeBySession).toHaveBeenCalledWith("/s/a.jsonl");
  });

  it("clearBySession clears persisted activity by stable sessionId after the path moves", () => {
    const store = makeFakeStore();
    const hub = new ActivityHub(null, store, {
      getSessionIdForPath: (sessionPath) => (
        sessionPath === "/s/original.jsonl" || sessionPath === "/s/moved.jsonl"
          ? "sess_activity_1"
          : null
      ),
    });
    hub.upsert({ id: "wf-1", kind: "workflow", status: "running", sessionPath: "/s/original.jsonl" });

    hub.clearBySession("/s/moved.jsonl");

    expect(hub.get("wf-1")).toBeNull();
    expect(store.removeBySession).toHaveBeenCalledWith({
      sessionId: "sess_activity_1",
      sessionPath: "/s/moved.jsonl",
    });
  });

  it("无 store 时一切照旧（纯内存，无写穿/回灌）", () => {
    const hub = new ActivityHub();
    expect(hub.upsert({ id: "wf-1", kind: "workflow", status: "running", sessionPath: "/s/a.jsonl" })).toBeTruthy();
    expect(typeof hub.rebroadcastSession).toBe("function");
    hub.rebroadcastSession("/s/a.jsonl"); // 不抛
  });
});


it("marks interrupted budget evidence as unknown after restart", () => {
  const store = makeFakeStore();
  const first = new ActivityHub(null, store);
  first.upsert({ id: "budgeted", kind: "workflow", status: "running", runBudget: { state: "active", committedTokens: 12, reservedTokens: 200 } });
  const restarted = new ActivityHub(null, store);
  expect(restarted.get("budgeted")).toMatchObject({ lifecycleStatus: "recovery_required", runBudget: {
    state: "blocked", committedTokens: 12, reservedTokens: 200, usageAfterCheckpointUnknown: true,
  } });
});
