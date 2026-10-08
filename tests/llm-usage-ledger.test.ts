import { describe, expect, it, vi } from "vitest";
import { createUsageLedger } from "../lib/llm/usage-ledger.js";

function sessionContext(sessionPath = "/tmp/session.jsonl") {
  return {
    source: {
      subsystem: "session",
      operation: "reply",
      surface: "desktop",
      trigger: "user",
    },
    attribution: {
      kind: "session",
      agentId: "agent-1",
      sessionPath,
    },
  };
}

describe("Usage ledger", () => {
  it("records a completed request with normalized usage and emits llm_usage", () => {
    const events = [];
    const ledger = createUsageLedger({
      now: () => 1_000,
      eventBus: { emit: (event, scope) => events.push({ event, scope }) },
      requestIdFactory: () => "req-1",
    });

    const req = ledger.start({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usageContext: sessionContext("/sessions/a.jsonl"),
    });
    const entry = ledger.finish(req.requestId, {
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });

    expect(entry).toMatchObject({
      schemaVersion: 1,
      requestId: "req-1",
      status: "ok",
      source: { subsystem: "session", operation: "reply" },
      attribution: { kind: "session", sessionPath: "/sessions/a.jsonl" },
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usage: { input: { totalTokens: 10 }, output: { totalTokens: 2 }, totalTokens: 12 },
    });
    expect(ledger.list({}).entries).toHaveLength(1);
    expect(events).toEqual([
      { event: { type: "llm_usage", entry }, scope: "/sessions/a.jsonl" },
    ]);
  });

  it("records usage_missing for completed requests without provider usage", () => {
    const ledger = createUsageLedger({ now: () => 1_000, requestIdFactory: () => "req-missing" });

    const req = ledger.start({
      model: { provider: "anthropic", modelId: "claude", api: "anthropic-messages" },
      usageContext: sessionContext(),
    });
    const entry = ledger.finish(req.requestId, { usage: null });

    expect(entry).toMatchObject({
      requestId: "req-missing",
      status: "usage_missing",
      usage: null,
    });
  });

  it("records errors without prompt content", () => {
    const ledger = createUsageLedger({ now: () => 1_000, requestIdFactory: () => "req-error" });
    const req = ledger.start({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usageContext: sessionContext(),
    });

    const entry = ledger.recordError(req.requestId, new Error("boom"));

    expect(entry).toMatchObject({
      requestId: "req-error",
      status: "error",
      error: { name: "Error", message: "boom" },
    });
    expect(JSON.stringify(entry)).not.toContain("prompt");
  });

  it("bounds entries and filters by model, subsystem, status, and session", () => {
    let clock = 1_000;
    let id = 0;
    const ledger = createUsageLedger({
      maxEntries: 2,
      now: () => clock,
      requestIdFactory: () => `req-${++id}`,
    });

    ledger.record({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usage: { prompt_tokens: 10, completion_tokens: 1 },
      usageContext: sessionContext("/sessions/a.jsonl"),
    });
    clock += 1_000;
    ledger.record({
      model: { provider: "anthropic", modelId: "claude", api: "anthropic-messages" },
      usage: { input: 20, output: 2 },
      usageContext: sessionContext("/sessions/b.jsonl"),
    });
    clock += 1_000;
    ledger.recordError(
      ledger.start({
        model: { provider: "openai", modelId: "gpt-5-mini", api: "openai-completions" },
        usageContext: {
          source: { subsystem: "memory", operation: "compile_today", surface: "system", trigger: "daily" },
          attribution: { kind: "memory", agentId: "agent-1" },
        },
      }).requestId,
      new Error("daily failed")
    );

    expect(ledger.list({}).entries.map(entry => entry.requestId)).toEqual(["req-2", "req-3"]);
    expect(ledger.list({ provider: "anthropic" }).entries).toHaveLength(1);
    expect(ledger.list({ subsystem: "memory", status: "error" }).entries).toHaveLength(1);
    expect(ledger.list({ sessionPath: "/sessions/a.jsonl" }).entries).toHaveLength(0);
    expect(ledger.list({ attributionKind: "memory" }).entries[0].model.modelId).toBe("gpt-5-mini");
  });

  it("warns when a first-party call records unknown usage context", () => {
    const logger = { warn: vi.fn() };
    const ledger = createUsageLedger({ logger, requestIdFactory: () => "req-unknown" });

    ledger.record({
      model: { provider: null, modelId: null, api: null },
      usage: { input: 1, output: 1 },
      usageContext: null,
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unknown usage context"));
  });
});
