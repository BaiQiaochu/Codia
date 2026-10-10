import { describe, expect, it } from "vitest";
import { createRuntimeTraceStore } from "../core/runtime-trace-store.js";

describe("RuntimeTraceStore", () => {
  it("records lifecycle phases and trims old traces", () => {
    const store = createRuntimeTraceStore({
      maxTraces: 1,
      now: () => "2026-05-23T00:00:00.000Z",
    });
    const first = store.startTrace({
      traceId: "trace-first",
      sessionPath: "E:/sessions/one.jsonl",
      agentId: "codia",
    });

    store.recordPhase(first.traceId, "input.received", { summary: "received" });
    store.endTrace(first.traceId, { status: "completed" });
    store.startTrace({ traceId: "trace-second", agentId: "codia" });

    expect(store.snapshot().traces).toHaveLength(1);
    expect(store.snapshot().traces[0]).toMatchObject({
      traceId: "trace-second",
      agentId: "codia",
      status: "running",
    });
  });

  it("redacts secrets and path-like values", () => {
    const store = createRuntimeTraceStore({
      now: () => "2026-05-23T00:00:00.000Z",
    });
    const trace = store.startTrace({ traceId: "trace-redact" });

    store.recordPhase(trace.traceId, "model.route", {
      details: {
        api_key: "sk-secret",
        authorization: "Bearer abcdef",
        filePath: "C:/Users/ghost/.codex/auth.json",
      },
    });

    const json = JSON.stringify(store.snapshot());
    expect(json).not.toContain("sk-secret");
    expect(json).not.toContain("abcdef");
    expect(json).toContain("auth.json");
  });

  it("records tool call chains linked to a lifecycle trace", () => {
    const store = createRuntimeTraceStore({
      now: () => "2026-05-23T00:00:00.000Z",
    });
    const trace = store.startTrace({ traceId: "trace-tools" });

    const tool = store.recordToolCall({
      traceId: trace.traceId,
      toolTraceId: "tooltrace-1",
      toolName: "bash",
      source: "builtin",
      permission: { mode: "ask", decision: "confirmed" },
      sandbox: { enabled: true, boundaryId: "execb_server_studio" },
      result: { status: "success", durationMs: 12 },
    });

    expect(tool).toMatchObject({
      toolTraceId: "tooltrace-1",
      traceId: "trace-tools",
      toolName: "bash",
    });
    expect(store.snapshot().traces[0].toolCalls[0]).toMatchObject({
      toolName: "bash",
      result: { status: "success", durationMs: 12 },
    });
  });
});
