// @ts-nocheck
// tests/workflow-tool.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowTool } from "../lib/tools/workflow-tool.js";

function makeCtx() {
  return { sessionManager: { getSessionFile: () => "/s.jsonl", getCwd: () => "/w" } };
}
function makeStore() {
  return { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
}
function makeRunStore() {
  return { register: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
}
const META = `export const meta = { name: 'demo', description: 'd' }\n`;
const waitForBackground = (assertion) => vi.waitFor(assertion, { timeout: 3000 });

describe("workflow tool", () => {
  it("工具形状正确", () => {
    const tool = createWorkflowTool({ executeIsolated: async () => ({}) });
    expect(tool.name).toBe("workflow");
    expect(tool.parameters.properties.script).toBeTruthy();
  });

  it("派出后台任务：立即返回 taskId + streamStatus running，并在 deferred store 登记 type=workflow", async () => {
    const store = makeStore();
    const runStore = makeRunStore();
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const tool = createWorkflowTool({
      executeIsolated: exec, getAgentId: () => "a1", emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => runStore,
    });
    const res = await tool.execute(
      "c1",
      { script: META + `const o=[]; while(o.length<2){o.push(await agent('x'))} return o` },
      undefined, undefined, makeCtx()
    );
    // 立即返回 taskId（不阻塞、不含同步 result）
    expect(res.details.taskId).toMatch(/^workflow-/);
    expect(res.details.streamStatus).toBe("running");
    expect(res.content[0].text).toMatch(/已派出后台/);
    // defer + register 登记，meta 带 type=workflow + summary=meta.name
    expect(store.defer).toHaveBeenCalledWith(
      res.details.taskId, "/s.jsonl",
      expect.objectContaining({ type: "workflow", summary: "demo" }),
    );
    expect(runStore.register).toHaveBeenCalledWith(
      res.details.taskId, expect.objectContaining({ summary: "demo" }),
    );
  });

  it("dispatches workflow runs with stable parentSessionId while keeping sessionPath as locator", async () => {
    const store = makeStore();
    const runStore = makeRunStore();
    const upserts = [];
    const hub = { upsert: (entry) => { upserts.push({ ...entry }); return entry; } };
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "ok", error: null }),
      getAgentId: () => "a1",
      emitEvent: () => {},
      getDeferredStore: () => store,
      getSubagentRunStore: () => runStore,
      getActivityHub: () => hub,
      getSessionIdForPath: (sessionPath) => sessionPath === "/s.jsonl" ? "sess_parent_workflow" : null,
    });

    const res = await tool.execute(
      "c1",
      { script: META + `return await agent('x')` },
      undefined, undefined, makeCtx()
    );

    expect(store.defer).toHaveBeenCalledWith(
      res.details.taskId,
      { sessionId: "sess_parent_workflow", sessionPath: "/s.jsonl" },
      expect.objectContaining({ type: "workflow", summary: "demo" }),
    );
    expect(runStore.register).toHaveBeenCalledWith(
      res.details.taskId,
      expect.objectContaining({ parentSessionId: "sess_parent_workflow", parentSessionPath: "/s.jsonl" }),
    );
    expect(upserts.find((entry) => entry.id === res.details.taskId)).toMatchObject({
      sessionId: "sess_parent_workflow",
      sessionPath: "/s.jsonl",
    });
  });

  it("后台跑完 resolve 合成结果到 deferred store，子 agent isoOpts 带 subagentTaskId", async () => {
    const store = makeStore();
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const tool = createWorkflowTool({
      executeIsolated: exec, getAgentId: () => "a1", emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute(
      "c1",
      { script: META + `const o=[]; while(o.length<2){o.push(await agent('x'))} return o` },
      undefined, undefined, makeCtx()
    );
    await waitForBackground(() => {
      expect(store.resolve).toHaveBeenCalledWith(res.details.taskId, JSON.stringify(["bug", "bug"], null, 2));
    });
    // 脚本内 agent() 派出的子 session 关联到这个 workflow task
    expect(exec.mock.calls[0][1]).toMatchObject({
      agentId: "a1", parentSessionPath: "/s.jsonl", cwd: "/w",
      subagentContext: true, subagentTaskId: res.details.taskId, emitEvents: true,
    });
  });

  it("脚本头非法时同步返回 toolError，不派后台任务", async () => {
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({}), emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute("c1", { script: `return 1` }, undefined, undefined, makeCtx());
    expect(res.details.error).toMatch(/脚本非法/);
    expect(store.defer).not.toHaveBeenCalled();
  });

  it("脚本运行时出错 → 后台 fail 到 deferred store", async () => {
    const store = makeStore();
    const runStore = makeRunStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "", error: "boom" }), emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => runStore,
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx());
    expect(res.details.taskId).toBeTruthy();
    await waitForBackground(() => {
      expect(store.fail).toHaveBeenCalledWith(res.details.taskId, expect.stringMatching(/boom|agent 失败/));
    });
    expect(runStore.fail).toHaveBeenCalled();
  });

  it("deferred 基础设施不可用时同步兜底执行，直接返回 result", async () => {
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const tool = createWorkflowTool({
      executeIsolated: exec, getAgentId: () => "a1", emitEvent: () => {},
      // 不提供 getDeferredStore → 同步兜底
    });
    const res = await tool.execute(
      "c1",
      { script: META + `return await agent('x')` },
      undefined, undefined, makeCtx()
    );
    expect(res.details.result).toBe("bug");
    expect(res.details.agentsSpawned).toBe(1);
  });

  it("emitEvent 收到 workflow_progress（phase/log），带 taskId", async () => {
    const evts = [];
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "ok", error: null }),
      emitEvent: (e, sp) => evts.push({ e, sp }),
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute(
      "c1",
      { script: META + `phase('Find'); log('hi'); return await agent('x')` },
      undefined, undefined, makeCtx()
    );
    await waitForBackground(() => {
      expect(evts.map((x) => x.e.type)).toContain("workflow_progress");
    });
    expect(evts.find((x) => x.e.title === "Find")).toBeTruthy();
    expect(evts.every((x) => x.e.taskId === res.details.taskId)).toBe(true);
  });

  it("派出时 details 带 startedAt（inline 概览块算时长用）", async () => {
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "ok", error: null }), emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx());
    expect(typeof res.details.startedAt).toBe("number");
  });

  it("后台跑完 emit block_update（inline 概览块翻 done + finishedAt）带 parentSessionPath", async () => {
    const evts = [];
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "ok", error: null }),
      emitEvent: (e, sp) => evts.push({ e, sp }),
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx());
    let bu;
    await waitForBackground(() => {
      bu = evts.find((x) => x.e.type === "block_update" && x.e.taskId === res.details.taskId);
      expect(bu).toBeTruthy();
    });
    expect(bu).toBeTruthy();
    expect(bu.e.patch.streamStatus).toBe("done");
    expect(typeof bu.e.patch.finishedAt).toBe("number");
    expect(bu.sp).toBe("/s.jsonl");
  });

  it("脚本运行时出错 → emit block_update streamStatus failed", async () => {
    const evts = [];
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "", error: "boom" }),
      emitEvent: (e) => evts.push(e),
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx());
    let bu;
    await waitForBackground(() => {
      bu = evts.find((e) => e.type === "block_update" && e.patch?.streamStatus === "failed");
      expect(bu).toBeTruthy();
    });
    expect(bu).toBeTruthy();
    expect(bu.taskId).toBe(res.details.taskId);
  });

  it("脚本里 agent() → ActivityHub workflow_agent 子 entry（parentTaskId/label/childSessionPath）", async () => {
    const store = makeStore();
    const upserts = [];
    const hub = { upsert: (e) => { upserts.push({ ...e }); return e; } };
    const tool = createWorkflowTool({
      executeIsolated: async (p, o) => { o.onSessionReady?.("/child.jsonl"); return { replyText: "x", error: null }; },
      getAgentId: () => "a1", emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
      getActivityHub: () => hub,
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x', { label: '探索' })` }, undefined, undefined, makeCtx());
    const childId = `${res.details.taskId}::node-1`;
    await waitForBackground(() => {
      expect(upserts.find((e) => e.id === childId && e.status === "done")).toBeTruthy();
    });
    const running = upserts.find((e) => e.id === childId && e.status === "running");
    expect(running).toMatchObject({ kind: "workflow_agent", parentTaskId: res.details.taskId, sessionPath: "/s.jsonl", label: "探索" });
    expect(upserts.find((e) => e.id === childId && e.childSessionPath === "/child.jsonl")).toBeTruthy();
    expect(upserts.find((e) => e.id === childId && e.status === "done")).toBeTruthy();
  });

  it("propagates parent and child session ids through workflow node lifecycle", async () => {
    const store = makeStore();
    const threadStore = {
      beginRun: vi.fn(),
      attachSession: vi.fn(),
      finishRun: vi.fn(),
    };
    const upserts = [];
    const hub = {
      upsert: (entry) => { upserts.push({ ...entry }); return entry; },
      get: (id) => {
        const merged = {};
        for (const entry of upserts) if (entry.id === id) Object.assign(merged, entry);
        return merged.id ? merged : null;
      },
    };
    const tool = createWorkflowTool({
      executeIsolated: async (_prompt, isoOpts) => {
        isoOpts.onSessionReady?.("/child.jsonl", { sessionId: "sess_child_workflow" });
        return { replyText: "x", error: null };
      },
      getAgentId: () => "a1",
      emitEvent: () => {},
      getDeferredStore: () => store,
      getSubagentRunStore: () => makeRunStore(),
      getSubagentThreadStore: () => threadStore,
      getActivityHub: () => hub,
      getSessionIdForPath: (sessionPath) => sessionPath === "/s.jsonl" ? "sess_parent_workflow" : null,
    });

    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx());
    const threadId = `${res.details.taskId}::node-1`;
    const childId = threadId;

    await waitForBackground(() => {
      expect(threadStore.finishRun).toHaveBeenCalledWith(threadId, { status: "resolved", close: true });
    });
    expect(threadStore.beginRun).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        parentSessionId: "sess_parent_workflow",
        parentSessionPath: "/s.jsonl",
      }),
    );
    expect(threadStore.attachSession).toHaveBeenCalledWith(
      threadId,
      "/child.jsonl",
      expect.objectContaining({
        parentSessionId: "sess_parent_workflow",
        parentSessionPath: "/s.jsonl",
        childSessionId: "sess_child_workflow",
      }),
    );
    expect(upserts.find((entry) => entry.id === childId && entry.status === "running")).toMatchObject({
      sessionId: "sess_parent_workflow",
      sessionPath: "/s.jsonl",
    });
    expect(upserts.find((entry) => entry.id === childId && entry.childSessionId === "sess_child_workflow")).toBeTruthy();
  });

  it("节点 done 从 UsageLedger 按 childSessionPath 汇总 token 写入子 entry", async () => {
    const store = makeStore();
    const upserts = [];
    const hub = {
      upsert: (e) => { upserts.push({ ...e }); return e; },
      get: (id) => {
        const merged = {};
        for (const u of upserts) if (u.id === id) Object.assign(merged, u);
        return merged.id ? merged : null;
      },
    };
    const ledger = {
      list: ({ childSessionPath }) => ({
        entries: childSessionPath === "/child.jsonl"
          ? [{ usage: { totalTokens: 1000 } }, { usage: { totalTokens: 234 } }]
          : [],
      }),
    };
    const tool = createWorkflowTool({
      executeIsolated: async (p, o) => { o.onSessionReady?.("/child.jsonl"); return { replyText: "x", error: null }; },
      getAgentId: () => "a1", emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
      getActivityHub: () => hub, getUsageLedger: () => ledger,
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx());
    const childId = `${res.details.taskId}::node-1`;
    await waitForBackground(() => {
      const done = upserts.find((e) => e.id === childId && e.status === "done");
      expect(done?.tokens).toBe(1234); // 1000 + 234
    });
  });

  it("prefers childSessionId over childSessionPath when summing workflow node usage", async () => {
    const store = makeStore();
    const upserts = [];
    const hub = {
      upsert: (entry) => { upserts.push({ ...entry }); return entry; },
      get: (id) => {
        const merged = {};
        for (const entry of upserts) if (entry.id === id) Object.assign(merged, entry);
        return merged.id ? merged : null;
      },
    };
    const ledger = {
      list: vi.fn(({ childSessionId, childSessionPath }) => ({
        entries: childSessionId === "sess_child_workflow"
          ? [{ usage: { totalTokens: 400 } }, { usage: { totalTokens: 56 } }]
          : childSessionPath === "/child.jsonl"
          ? [{ usage: { totalTokens: 9999 } }]
          : [],
      })),
    };
    const tool = createWorkflowTool({
      executeIsolated: async (_prompt, isoOpts) => {
        isoOpts.onSessionReady?.("/child.jsonl", { sessionId: "sess_child_workflow" });
        return { replyText: "x", error: null };
      },
      getAgentId: () => "a1",
      emitEvent: () => {},
      getDeferredStore: () => store,
      getSubagentRunStore: () => makeRunStore(),
      getActivityHub: () => hub,
      getUsageLedger: () => ledger,
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx());
    const childId = `${res.details.taskId}::node-1`;

    await waitForBackground(() => {
      const done = upserts.find((entry) => entry.id === childId && entry.status === "done");
      expect(done?.tokens).toBe(456);
    });
    expect(ledger.list).toHaveBeenCalledWith({ childSessionId: "sess_child_workflow" });
  });
});
