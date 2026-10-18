import { describe, expect, it, vi } from "vitest";
import { installProviderRuntimeCompat } from "../lib/pi-sdk/index.js";

describe("Pi SDK provider runtime compat", () => {
  it("injects long prompt-cache affinity into streaming model calls", async () => {
    const streamFn = vi.fn(async function* (_model, _context, _options) {});
    const session = {
      sessionId: "session-runtime-cache",
      agent: { streamFn },
    };

    installProviderRuntimeCompat(session);

    await session.agent.streamFn(
      { id: "gpt-5", provider: "openai", api: "openai-completions" },
      { messages: [] },
      { headers: { "x-api-key": "sk-test" } },
    );

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(streamFn.mock.calls[0][2]).toMatchObject({
      sessionId: "session-runtime-cache",
      cacheRetention: "long",
      headers: { "x-api-key": "sk-test" },
    });
  });

  it("does not override caller-provided prompt-cache options", async () => {
    const streamFn = vi.fn(async function* (_model, _context, _options) {});
    const session = {
      sessionId: "session-runtime-cache",
      agent: { streamFn },
    };

    installProviderRuntimeCompat(session);

    await session.agent.streamFn(
      { id: "claude-test", provider: "anthropic" },
      { messages: [] },
      { sessionId: "caller-session", cacheRetention: "short" },
    );

    expect(streamFn.mock.calls[0][2]).toMatchObject({
      sessionId: "caller-session",
      cacheRetention: "short",
    });
  });

  it("derives a non-path cache key when only the session file is available", async () => {
    const streamFn = vi.fn(async function* (_model, _context, _options) {});
    const session = {
      sessionManager: {
        getSessionFile: () => "C:\\Users\\ghost\\Desktop\\Codia-WorkSpace\\secret-session.jsonl",
      },
      agent: { streamFn },
    };

    installProviderRuntimeCompat(session);

    await session.agent.streamFn(
      { id: "deepseek-chat", provider: "deepseek" },
      { messages: [] },
      {},
    );

    const sentOptions = streamFn.mock.calls[0][2];
    expect(sentOptions.cacheRetention).toBe("long");
    expect(sentOptions.sessionId).toMatch(/^codia-cache-[a-f0-9]{32}$/);
    expect(sentOptions.sessionId).not.toContain("Users");
    expect(sentOptions.sessionId).not.toContain("secret-session");
  });

  it("keeps explicit cache disablement intact", async () => {
    const streamFn = vi.fn(async function* (_model, _context, _options) {});
    const session = {
      sessionId: "session-runtime-cache",
      agent: { streamFn },
    };

    installProviderRuntimeCompat(session);

    await session.agent.streamFn(
      { id: "local-test", provider: "custom" },
      { messages: [] },
      { cacheRetention: "none" },
    );

    expect(streamFn.mock.calls[0][2]).toEqual({ cacheRetention: "none" });
  });

  it("leaves MiniMax Anthropic x-api-key streaming requests untouched", async () => {
    const streamFn = vi.fn(async function* (_model, _context, _options) {});
    const session = { agent: { streamFn } };

    installProviderRuntimeCompat(session);

    await session.agent.streamFn(
      {
        id: "MiniMax-M2.7",
        provider: "minimax-token-plan",
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
      },
      { messages: [] },
      { headers: { "x-api-key": "sk-test" } },
    );

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(streamFn.mock.calls[0][2].headers).toEqual({ "x-api-key": "sk-test" });
  });

  it("leaves ordinary Anthropic requests untouched", async () => {
    const streamFn = vi.fn(async function* (_model, _context, _options) {});
    const session = { agent: { streamFn } };

    installProviderRuntimeCompat(session);

    await session.agent.streamFn(
      {
        id: "claude-sonnet",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      },
      { messages: [] },
      { headers: { "x-api-key": "sk-test" } },
    );

    expect(streamFn.mock.calls[0][2].headers).toEqual({ "x-api-key": "sk-test" });
  });
});

it("wraps the actual SDK streamFunction slot and preserves this binding", async () => {
  const { Agent } = await import("@earendil-works/pi-agent-core");
  const streamFn = vi.fn(function (_model, _context, _options) { return null; });
  const agent = new Agent({ streamFn } as any);
  const session = { agent, sessionId: "actual-sdk-session" };
  installProviderRuntimeCompat(session);
  await (agent as any).streamFunction({}, {}, { cacheRetention: "none" });
  expect(streamFn.mock.contexts[0]).toBe(agent);
  expect(streamFn.mock.calls[0][2]).toEqual({ cacheRetention: "none" });
  expect((agent as any).streamFn).toBeUndefined();
});
