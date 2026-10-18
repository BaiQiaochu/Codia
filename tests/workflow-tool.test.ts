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

describe("workflow durable recovery", () => {
  it("reuses successful writes without dispatch and refuses changed definitions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-resume-"));
    try {
      const store = makeStore();
      const executeIsolated = vi.fn(async () => ({ replyText: "saved" }));
      const tool = createWorkflowTool({ executeIsolated, getAgentId: () => "a1", getJournalDir: () => dir, getDeferredStore: () => store });
      const script = META + "return await agent('save artifact', { access: 'write' });";
      const first = await tool.execute("one", { script }, undefined, undefined, makeCtx());
      await waitForBackground(() => expect(store.resolve).toHaveBeenCalledWith(first.details.taskId, "saved"));
      const second = await tool.execute("two", { script, resumeFromRunId: first.details.taskId }, undefined, undefined, makeCtx());
      await waitForBackground(() => expect(store.resolve).toHaveBeenCalledWith(second.details.taskId, "saved"));
      expect(executeIsolated).toHaveBeenCalledTimes(1);
      const changed = await tool.execute("three", { script: script + " // changed", resumeFromRunId: second.details.taskId }, undefined, undefined, makeCtx());
      expect(changed.details.error).toMatch(/changed/);
      expect(store.defer).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("unknown external writes block resume before registering another run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-unknown-"));
    try {
      const store = makeStore();
      const executeIsolated = vi.fn(async () => { throw new Error("timeout after send"); });
      const tool = createWorkflowTool({ executeIsolated, getJournalDir: () => dir, getDeferredStore: () => store });
      const script = META + "return await agent('send', { access: 'write' });";
      const first = await tool.execute("one", { script }, undefined, undefined, makeCtx());
      await waitForBackground(() => expect(store.fail).toHaveBeenCalled());
      const retry = await tool.execute("two", { script, resumeFromRunId: first.details.taskId }, undefined, undefined, makeCtx());
      expect(retry.details.error).toMatch(/unknown external result/);
      expect(executeIsolated).toHaveBeenCalledTimes(1);
      expect(store.defer).toHaveBeenCalledTimes(1);
      const invalid = await tool.execute("three", { script, resumeFromRunId: "../../outside" }, undefined, undefined, makeCtx());
      expect(invalid.details.error).toMatch(/Invalid workflow run ID/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("nested workflow actions have distinct journal sequences and activity IDs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-nested-"));
    try {
      const store = makeStore();
      const calls = [];
      const tool = createWorkflowTool({ executeIsolated: async (_p, o) => { calls.push(o); return { replyText: "ok" }; }, getJournalDir: () => dir, getDeferredStore: () => store });
      const child = META + "return await agent('child');";
      const script = META + "await agent('parent'); return await workflow(args.child);";
      const result = await tool.execute("one", { script, args: { child } }, undefined, undefined, makeCtx());
      await waitForBackground(() => expect(store.resolve).toHaveBeenCalled());
      expect(new Set(calls.map(o => o.subagentThreadId)).size).toBe(2);
      const lines = fs.readFileSync(path.join(dir, result.details.taskId + ".jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      expect(new Set(lines.filter(e => e.status === "ok").map(e => e.actionId)).size).toBe(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("workflow resolved registry versions", () => {
  it("blocks a changed registry before claiming recovery or dispatching another node", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-runtime-"));
    try {
      const store = makeStore();
      let registry = { model: "resolved-model-v1", prompt: "prompt-v1", tools: "tools-v1" };
      const effects = vi.fn();
      const tool = createWorkflowTool({
        requireRuntimeSnapshot: true, getRuntimeSnapshot: () => registry,
        executeIsolated: async (_prompt, opts) => {
          const replay = opts.workflowRuntimeGuard({ version: 1, model: "resolved-model-v1", tools: "tools-v1", prompt: "prompt-v1" });
          if (replay?.replay) return { workflowReplay: true };
          effects();
          return { replyText: "saved" };
        },
        getJournalDir: () => dir, getDeferredStore: () => store,
      });
      const script = META + "return await agent('save', { access: 'write' });";
      const first = await tool.execute("one", { script }, undefined, undefined, makeCtx());
      await waitForBackground(() => expect(store.resolve).toHaveBeenCalledWith(first.details.taskId, "saved"));
      registry = { ...registry, tools: "tools-v2" };
      const second = await tool.execute("two", { script, resumeFromRunId: first.details.taskId }, undefined, undefined, makeCtx());
      expect(second.details.error).toMatch(/changed/);
      expect(effects).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(dir, first.details.taskId + ".jsonl.resume"))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("trusted template budget propagation", () => {
  it("refuses the unpersisted synchronous fallback", async () => {
    const executeIsolated = vi.fn();
    const tool = createWorkflowTool({ executeIsolated });
    const result = await tool.execute("budget", { script: META + "return await agent('x')" }, undefined, undefined, { runBudget: {} });
    expect(result.details.error).toMatch(/persisted parent session/);
    expect(result.content[0].text).toMatch(/persisted parent session/);
    expect(executeIsolated).not.toHaveBeenCalled();
  });
  it("shares the same budget with nested workflows and retains evidence on the root run", async () => {
    const store = makeStore();
    const runBudget = { limits: { maxTokens: 100 }, model: { id: "pinned" }, snapshot: () => ({ committedTokens: 12 }) };
    const executeIsolated = vi.fn(async () => ({ replyText: "ok" }));
    const hub = { upsert: vi.fn() };
    const tool = createWorkflowTool({ executeIsolated, getDeferredStore: () => store, getActivityHub: () => hub });
    const child = META + "return await agent('nested')";
    await tool.execute("budget", { script: META + "return await workflow(args.child)", args: { child } }, undefined, undefined,
      { ...makeCtx(), runBudget, executionModel: { id: "pinned" }, toolFilter: [], builtinFilter: [] });
    await waitForBackground(() => expect(store.resolve.mock.calls.length + store.fail.mock.calls.length).toBe(1));
    expect(store.fail.mock.calls).toEqual([]);
    expect(executeIsolated.mock.calls[0][1].runBudget).toBe(runBudget);
    expect(executeIsolated.mock.calls[0][1].model).toEqual({ id: "pinned" });
    expect(hub.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ status: "done", runBudget: { committedTokens: 12 } }));
  });
});

it("cancels active workflow dispatch and never schedules the next node", async () => {
  const store = makeStore();
  const hub = { upsert: vi.fn() };
  const abort = vi.fn();
  const executeIsolated = vi.fn((_prompt, options) => new Promise(resolve => {
    options.signal.addEventListener("abort", () => resolve({ error: "aborted" }), { once: true });
  }));
  const tool = createWorkflowTool({ executeIsolated, getDeferredStore: () => store, getActivityHub: () => hub, getSubagentRunStore: () => ({ register: vi.fn(), abort }) });
  const result = await tool.execute("cancel", { script: META + "await agent('first'); return await agent('must not dispatch');" }, undefined, undefined, makeCtx());
  await waitForBackground(() => expect(executeIsolated).toHaveBeenCalledTimes(1));
  expect(tool.cancelRun(result.details.taskId)).toBe(true);
  await waitForBackground(() => expect(store.fail).toHaveBeenCalled());
  expect(executeIsolated).toHaveBeenCalledTimes(1);
  expect(abort).toHaveBeenCalled();
  expect(hub.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ status: "aborted" }));
  await waitForBackground(() => expect(tool.cancelRun(result.details.taskId)).toBe(false));
});
