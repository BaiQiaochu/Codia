// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { ActivityHub } from "../lib/activity-hub.js";
import { createHostApi } from "../lib/workflow/host-api.js";
import { createLimiter } from "../lib/workflow/concurrency.js";
import { createWorkflowTool } from "../lib/tools/workflow-tool.js";

function makeHostDeps(overrides = {}) {
  return {
    executeIsolated: overrides.executeIsolated || (async () => ({ replyText: "ok", error: null })),
    baseIsoOpts: overrides.baseIsoOpts || { agentId: "a1", parentSessionPath: "/s.jsonl", cwd: "/w" },
    limiter: overrides.limiter || createLimiter({ maxConcurrent: 4, maxTotal: 100 }),
    signal: overrides.signal,
    onProgress: overrides.onProgress || (() => {}),
    budget: overrides.budget || { total: null, spent: () => 0, remaining: () => Infinity },
    args: overrides.args,
    resolveAgentId: overrides.resolveAgentId,
    onAgentEvent: overrides.onAgentEvent,
  };
}

function makeCtx() {
  return { sessionManager: { getSessionFile: () => "/s.jsonl", getCwd: () => "/w" } };
}

function makeStore() {
  return { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
}

function makeRunStore() {
  return { register: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
}

const META = "export const meta = { name: 'demo', description: 'd' }\n";

describe("workflow step activity", () => {
  it("ActivityHub accepts workflow_step and preserves stepKind", () => {
    const hub = new ActivityHub();
    hub.upsert({
      id: "wf-1::step-1",
      kind: "workflow_step",
      status: "running",
      sessionPath: "/s/a.jsonl",
      parentTaskId: "wf-1",
      stepKind: "parallel",
      phaseLabel: "Research",
      startedAt: 1000,
    });

    expect(hub.get("wf-1::step-1")).toMatchObject({
      kind: "workflow_step",
      stepKind: "parallel",
      phaseLabel: "Research",
      parentTaskId: "wf-1",
    });
  });

  it("host api emits workflow step events for parallel, pipeline, and log", async () => {
    const events = [];
    const api = createHostApi(makeHostDeps({ onAgentEvent: (event) => events.push(event) }));

    api.phase("Research");
    api.log("collect inputs");
    await api.parallel([async () => 1, async () => 2]);
    await api.pipeline([1], (value) => value + 1);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "start", stepKind: "log", label: "collect inputs", phaseLabel: "Research" }),
      expect.objectContaining({ phase: "done", stepKind: "log" }),
      expect.objectContaining({ phase: "start", stepKind: "parallel", phaseLabel: "Research" }),
      expect.objectContaining({ phase: "done", stepKind: "parallel" }),
      expect.objectContaining({ phase: "start", stepKind: "pipeline", phaseLabel: "Research" }),
      expect.objectContaining({ phase: "done", stepKind: "pipeline" }),
    ]));
  });

  it("workflow tool converts step events into workflow_step activity entries", async () => {
    const hubEntries = [];
    const hub = {
      upsert: vi.fn((entry) => {
        hubEntries.push({ ...entry });
        return entry;
      }),
      get: vi.fn(() => null),
    };
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "ok", error: null }),
      getAgentId: () => "a1",
      emitEvent: () => {},
      getDeferredStore: () => makeStore(),
      getSubagentRunStore: () => makeRunStore(),
      getActivityHub: () => hub,
    });

    await tool.execute(
      "c1",
      { script: META + "phase('Research'); log('hello'); await parallel([async () => await agent('a')]); return 'done';" },
      undefined,
      undefined,
      makeCtx(),
    );

    await vi.waitFor(() => {
      expect(hubEntries.some((entry) => entry.kind === "workflow_step" && entry.stepKind === "log")).toBe(true);
      expect(hubEntries.some((entry) => entry.kind === "workflow_step" && entry.stepKind === "parallel")).toBe(true);
    });
    expect(hubEntries.filter((entry) => entry.kind === "workflow_step").every((entry) => entry.threadId == null)).toBe(true);
  });
});
