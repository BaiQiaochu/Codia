import { describe, expect, it } from "vitest";
import { EventBus } from "../hub/event-bus.js";
import { createUsageLedger } from "../lib/llm/usage-ledger.js";

describe("usage:list bus handler", () => {
  it("returns filtered usage ledger entries through EventBus request", async () => {
    const bus = new EventBus();
    const ledger = createUsageLedger({ requestIdFactory: () => "req-1" });
    ledger.record({
      model: { provider: "openai", modelId: "gpt-5-mini", api: "openai-completions" },
      usage: { prompt_tokens: 10, completion_tokens: 1 },
      usageContext: {
        source: { subsystem: "session", operation: "reply", surface: "desktop", trigger: "user" },
        attribution: { kind: "session", agentId: "agent-1", sessionPath: "/sessions/a.jsonl" },
      },
    });

    bus.handle("usage:list", (filter = {}) => ledger.list(filter));

    const result = await bus.request("usage:list", {
      sessionPath: "/sessions/a.jsonl",
      provider: "openai",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      requestId: "req-1",
      model: { provider: "openai" },
    });
    expect(result.nextCursor).toBeNull();
  });
});
