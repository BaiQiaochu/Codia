// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { callText } from "../core/llm-client.js";
import { createUsageLedger } from "../lib/llm/usage-ledger.js";

const usageContext = {
  source: {
    subsystem: "utility",
    operation: "title",
    surface: "system",
    trigger: "tool",
  },
  attribution: {
    kind: "session",
    agentId: "agent-1",
    sessionPath: "/sessions/a.jsonl",
  },
};

describe("callText usage ledger integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records successful non-streaming provider usage", async () => {
    const ledger = createUsageLedger({ requestIdFactory: () => "req-calltext" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "Title" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 8,
          total_tokens: 108,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      }),
    });

    const text = await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5-mini", provider: "openai", cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 } },
      messages: [{ role: "user", content: "name this" }],
      usageContext,
      usageLedger: ledger,
    });

    expect(text).toBe("Title");
    expect(ledger.list({}).entries[0]).toMatchObject({
      requestId: "req-calltext",
      status: "ok",
      model: { provider: "openai", modelId: "gpt-5-mini", api: "openai-completions" },
      source: { subsystem: "utility", operation: "title" },
      usage: {
        input: { totalTokens: 100, uncachedTokens: 40 },
        cache: { readTokens: 60, hit: true },
      },
    });
  });

  it("records failed provider calls without prompt content", async () => {
    const ledger = createUsageLedger({ requestIdFactory: () => "req-fail" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: { message: "provider down" } }),
    });

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5-mini", provider: "openai" },
      messages: [{ role: "user", content: "private prompt should not be stored" }],
      usageContext,
      usageLedger: ledger,
    })).rejects.toThrow("provider down");

    const entry = ledger.list({}).entries[0];
    expect(entry).toMatchObject({
      requestId: "req-fail",
      status: "error",
      error: { message: "provider down" },
    });
    expect(JSON.stringify(entry)).not.toContain("private prompt");
  });

  it("keeps provider usage when a successful response fails local text validation", async () => {
    const ledger = createUsageLedger({ requestIdFactory: () => "req-empty" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "" } }],
        usage: {
          prompt_tokens: 22,
          completion_tokens: 0,
          total_tokens: 22,
          prompt_tokens_details: { cached_tokens: 12 },
        },
      }),
    });

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5-mini", provider: "openai" },
      messages: [{ role: "user", content: "private prompt should not be stored" }],
      usageContext,
      usageLedger: ledger,
    })).rejects.toMatchObject({ code: "LLM_EMPTY_RESPONSE" });

    const entry = ledger.list({}).entries[0];
    expect(entry).toMatchObject({
      requestId: "req-empty",
      status: "error",
      usage: {
        input: { totalTokens: 22, uncachedTokens: 10 },
        cache: { readTokens: 12, hit: true },
        totalTokens: 22,
      },
      rawUsageShape: "completion_tokens,prompt_tokens,prompt_tokens_details,total_tokens",
    });
    expect(JSON.stringify(entry)).not.toContain("private prompt");
  });
});
