// @ts-nocheck
import { describe, expect, it } from "vitest";
import { createHostApi } from "../lib/workflow/host-api.js";
import { createLimiter } from "../lib/workflow/concurrency.js";

function makeDeps(overrides = {}) {
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

describe("workflow host api", () => {
  it("calls executeIsolated and returns replyText", async () => {
    const calls = [];
    const api = createHostApi(makeDeps({
      executeIsolated: async (prompt, opts) => {
        calls.push({ prompt, opts });
        return { replyText: "hello", error: null };
      },
    }));

    await expect(api.agent("do it")).resolves.toBe("hello");
    expect(calls[0]).toMatchObject({
      prompt: "do it",
      opts: { agentId: "a1" },
    });
  });

  it("passes stable workflow node thread ids into child sessions and events", async () => {
    const calls = [];
    const events = [];
    const api = createHostApi(makeDeps({
      baseIsoOpts: {
        agentId: "a1",
        parentSessionPath: "/s.jsonl",
        cwd: "/w",
        subagentTaskId: "workflow-1",
      },
      onAgentEvent: (event) => events.push(event),
      executeIsolated: async (_prompt, opts) => {
        calls.push(opts);
        opts.onSessionReady?.("/child.jsonl");
        return { replyText: "ok", error: null };
      },
    }));

    await api.agent("p", { label: "research" });

    expect(calls[0]).toMatchObject({
      subagentThreadId: "workflow-1::node-1",
      subagentThreadKind: "workflow_node",
    });
    expect(events.find((event) => event.phase === "start")).toMatchObject({
      nodeId: "node-1",
      threadId: "workflow-1::node-1",
      threadKind: "workflow_node",
      label: "research",
    });
    expect(events.find((event) => event.phase === "session")).toMatchObject({
      nodeId: "node-1",
      threadId: "workflow-1::node-1",
      threadKind: "workflow_node",
      childSessionPath: "/child.jsonl",
    });
    expect(events.find((event) => event.phase === "done")).toMatchObject({
      threadId: "workflow-1::node-1",
      threadKind: "workflow_node",
    });
  });

  it("forwards child session id metadata from isolated agents", async () => {
    const events = [];
    const api = createHostApi(makeDeps({
      baseIsoOpts: {
        agentId: "a1",
        parentSessionPath: "/s.jsonl",
        cwd: "/w",
        subagentTaskId: "workflow-1",
      },
      onAgentEvent: (event) => events.push(event),
      executeIsolated: async (_prompt, opts) => {
        opts.onSessionReady?.("/child.jsonl", { sessionId: "sess_child_workflow" });
        return { replyText: "ok", error: null };
      },
    }));

    await api.agent("p");

    expect(events.find((event) => event.phase === "session")).toMatchObject({
      childSessionId: "sess_child_workflow",
      childSessionPath: "/child.jsonl",
    });
  });

  it("rejects unknown agent options before starting an isolated node", () => {
    const calls = [];
    const api = createHostApi(makeDeps({
      executeIsolated: async (prompt, opts) => {
        calls.push({ prompt, opts });
        return { replyText: "ok", error: null };
      },
    }));

    expect(() => api.agent("read README", { task: "read README", access: "read" } as any))
      .toThrow(/unsupported option "task"/i);
    expect(calls).toHaveLength(0);
  });

  it("fails when explicit agentType cannot be resolved", async () => {
    const calls = [];
    const api = createHostApi(makeDeps({
      resolveAgentId: () => undefined,
      executeIsolated: async (prompt, opts) => {
        calls.push({ prompt, opts });
        return { replyText: "ok", error: null };
      },
    }));

    await expect(api.agent("do it", { agentType: "missing-agent" }))
      .rejects.toThrow(/agentType.*missing-agent/i);
    expect(calls).toHaveLength(0);
  });
});
