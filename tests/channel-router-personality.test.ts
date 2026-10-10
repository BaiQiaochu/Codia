import { describe, expect, it, vi } from "vitest";

const { runAgentPhoneSessionMock, callTextMock } = vi.hoisted(() => ({
  runAgentPhoneSessionMock: vi.fn(async (_agentId, _rounds, options) => {
    const passTool = options.extraCustomTools.find((tool) => tool.name === "channel_pass");
    await passTool.execute("tool-call-1", { reason: "watching" });
    return "";
  }),
  callTextMock: vi.fn(async () => "NO"),
}));

vi.mock("../hub/agent-executor.js", () => ({
  runAgentSession: vi.fn(async () => "legacy text"),
  runAgentPhoneSession: runAgentPhoneSessionMock,
}));

vi.mock("../core/llm-client.js", () => ({
  callText: callTextMock,
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../lib/memory/config-loader.js", () => ({
  loadConfig: vi.fn(() => {
    throw new Error("loadConfig should not be part of channel phone delivery gating");
  }),
}));

import { ChannelRouter } from "../hub/channel-router.js";

describe("ChannelRouter._executeCheck phone delivery", () => {
  it("does not run utility gating or disk personality fallback before the phone session", async () => {
    runAgentPhoneSessionMock.mockClear();
    callTextMock.mockClear();
    const mockAgent = {
      agentDir: "/tmp/codia-agent-phone-delivery",
      config: { agent: { name: "Codia", yuan: "codia" } },
      personality: "in-memory personality",
    };
    const resolveUtilityConfig = vi.fn(() => ({
      utility_large: "test-model-large",
      large_api_key: "test-key",
      large_base_url: "https://test.api",
      large_api: "openai-completions",
    }));

    const router = new ChannelRouter({
      hub: {
        engine: {
          agentsDir: "/fake/agents",
          channelsDir: "/fake/channels",
          userDir: "/fake/user",
          agents: new Map([["codia", mockAgent]]),
          getAgent: (id) => (id === "codia" ? mockAgent : null),
          resolveUtilityConfig,
        },
        eventBus: { emit: vi.fn() },
        agentPhoneActivities: { record: vi.fn() },
      },
    });

    const result = await router._executeCheck(
      "codia",
      "general",
      [{ sender: "user", timestamp: "2026-05-07 17:00:00", body: "hello" }],
      [],
    );

    expect(result).toMatchObject({ replied: false, passed: true });
    expect(runAgentPhoneSessionMock).toHaveBeenCalledOnce();
    expect(callTextMock).not.toHaveBeenCalled();
    expect(resolveUtilityConfig).not.toHaveBeenCalled();
  });
});
