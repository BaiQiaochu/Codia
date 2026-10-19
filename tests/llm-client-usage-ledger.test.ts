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

describe('final provider response versus local validation failure', () => {
  afterEach(() => vi.restoreAllMocks());
  const pricedModel = { id: 'synthetic', provider: 'synthetic', contextWindow: 100, maxTokens: 20,
    cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } };
  const finalUsage = { input_tokens: 22, output_tokens: 0, total_tokens: 22 };
  const options = ledger => ({ api: 'openai-completions', baseUrl: 'https://example.invalid/v1',
    model: pricedModel, maxTokens: 20, messages: [{ role: 'user', content: 'synthetic' }], usageContext, usageLedger: ledger });
  function sse(events) {
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('settles a complete HTTP response exactly once despite local rejection, then admits using actual usage', async () => {
    const ledger = createUsageLedger();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 22, completion_tokens: 0, total_tokens: 22 },
    }), { status: 200 }));
    try {
      ledger.setBudgetConfig({ daily: { maxUsd: .00017 } });
      await expect(callText(options(ledger))).rejects.toMatchObject({ code: 'LLM_EMPTY_RESPONSE' });
      expect(ledger.getBudgetReport().daily).toMatchObject({ calls: 1, knownCostCalls: 1, unknownCostCalls: 0, knownTokens: 22, reservedTokens: 0, reservedUsd: 0 });
      await expect(callText(options(ledger))).rejects.toMatchObject({ code: 'LLM_EMPTY_RESPONSE' });
      expect(fetch).toHaveBeenCalledTimes(2); expect(ledger.getBudgetReport().daily.calls).toBe(2);
    } finally { ledger.close(); }
  });

  it('uses a real Codex response.completed terminal event to retain final usage on local rejection', async () => {
    const ledger = createUsageLedger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sse([
      { type: 'response.completed', response: { status: 'completed', output: [], usage: finalUsage } },
    ]));
    try {
      await expect(callText({ ...options(ledger), api: 'openai-codex-responses' })).rejects.toMatchObject({ code: 'LLM_EMPTY_RESPONSE' });
      expect(ledger.list().entries[0]).toMatchObject({ status: 'error', usage: { totalTokens: 22 } });
      expect(ledger.getBudgetReport().daily).toMatchObject({ knownCostCalls: 1, unknownCostCalls: 0, knownTokens: 22, reservedTokens: 0 });
    } finally { ledger.close(); }
  });

  it.each([false, true])('never treats a Codex EOF as final even with positive usage and visibleText=%s', async visibleText => {
    const ledger = createUsageLedger();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sse([
      { type: 'response.in_progress', usage: finalUsage },
      ...(visibleText ? [{ type: 'response.output_text.delta', delta: 'synthetic partial' }] : []),
    ]));
    try {
      ledger.setBudgetConfig({ daily: { maxUsd: .0002 } });
      const call = () => callText({ ...options(ledger), api: 'openai-codex-responses' });
      if (visibleText) await expect(call()).resolves.toBe('synthetic partial');
      else await expect(call()).rejects.toMatchObject({ code: 'LLM_EMPTY_RESPONSE' });
      expect(ledger.getBudgetReport().daily).toMatchObject({ knownCostCalls: 0, unknownCostCalls: 1, reservedTokens: 120, reservedUsd: .00014 });
      await expect(call()).rejects.toThrow(/unknown/); expect(fetch).toHaveBeenCalledTimes(1);
    } finally { ledger.close(); }
  });

  it('does not trust an HTTP payload claiming final usage when the provider status is incomplete', async () => {
    const ledger = createUsageLedger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      status: 'incomplete', usageFinal: true, providerResponseComplete: true, usage: { ...finalUsage, final: true }, output: [],
    }), { status: 200 }));
    try {
      await expect(callText({ ...options(ledger), api: 'openai-responses' })).rejects.toMatchObject({ code: 'LLM_EMPTY_RESPONSE' });
      expect(ledger.getBudgetReport().daily).toMatchObject({ unknownCostCalls: 1, knownCostCalls: 0, reservedTokens: 120 });
    } finally { ledger.close(); }
  });
});

it.each(['', 'synthetic completed text'])('does not borrow earlier partial usage when completed Codex response lacks usage (text=%s)', async text => {
  const ledger = createUsageLedger();
  const events = [
    { type: 'response.in_progress', usage: { input_tokens: 22, output_tokens: 1, total_tokens: 23 } },
    { type: 'response.output_text.delta', delta: text || '<think>synthetic partial</think>' },
    { type: 'response.completed', response: { status: 'completed', output_text: text, output: [] } },
  ];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  try {
    const call = callText({ api: 'openai-codex-responses', baseUrl: 'https://example.invalid', model: { id: 'synthetic', provider: 'synthetic', contextWindow: 100, maxTokens: 20, cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } }, maxTokens: 20, messages: [{ role: 'user', content: 'synthetic' }], usageContext, usageLedger: ledger });
    if (text) await expect(call).resolves.toBe(text); else await expect(call).rejects.toMatchObject({ code: 'LLM_EMPTY_RESPONSE' });
    expect(ledger.getBudgetReport().daily).toMatchObject({ unknownCostCalls: 1, knownCostCalls: 0, reservedTokens: 120, reservedUsd: .00014 });
  } finally { ledger.close(); fetch.mockRestore(); }
});
