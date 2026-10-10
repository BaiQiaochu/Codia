// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { Hub } from "../hub/index.js";
import { BridgeManager } from "../lib/bridge/bridge-manager.js";

function makeEngine() {
  return {
    agents: new Map(),
    agentName: "Codia",
    setHubCallbacks: vi.fn(),
    setEventBus: vi.fn(),
    isSessionStreaming: vi.fn(() => false),
    promptSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => false),
    listSessions: vi.fn(async () => []),
    listAgents: vi.fn(() => []),
    providerRegistry: {
      getCredentials: vi.fn(() => ({})),
      getAllProvidersRaw: vi.fn(() => ({})),
      getAll: vi.fn(() => new Map()),
      getAllModelsByType: vi.fn(() => []),
      getModelsByType: vi.fn(() => []),
    },
    resolveUtilityConfig: vi.fn(() => ({})),
    getAgent: vi.fn((agentId) => ({ id: agentId, agentName: "项目经理" })),
    dispose: vi.fn(async () => {}),
  };
}

describe("company bridge text delivery", () => {
  it("routes bridge:send-text bus requests through the active bridge manager", async () => {
    const hub = new Hub({ engine: makeEngine() });
    hub.bridgeManager = {
      sendTextMessage: vi.fn(async () => ({ platform: "telegram", chatId: "group-1", sessionKey: "telegram_group_group-1@pm" })),
    };

    const result = await hub.eventBus.request("bridge:send-text", {
      platform: "telegram",
      chatId: "group-1",
      text: "任务已更新",
      agentId: "pm",
      channelId: "ch_1",
      companyId: "company_default",
    });

    expect(result).toMatchObject({ platform: "telegram", chatId: "group-1" });
    expect(hub.bridgeManager.sendTextMessage).toHaveBeenCalledWith("telegram", "group-1", "任务已更新", "pm", expect.objectContaining({
      channelId: "ch_1",
      companyId: "company_default",
      isGroup: true,
    }));

    await hub.dispose();
  });

  it("sends text to a connected bridge group and records it in bridge messages", async () => {
    const emit = vi.fn();
    const bridge = new BridgeManager({
      engine: {
        agentName: "Codia",
        getAgent: vi.fn(() => ({ agentName: "项目经理" })),
      },
      hub: {
        eventBus: { emit },
        subscribe: vi.fn(() => () => {}),
      },
    });
    const adapter = {
      sendReply: vi.fn(async () => {}),
      capabilities: { proactive: true },
    };
    bridge._platforms.set("telegram:pm", {
      platform: "telegram",
      agentId: "pm",
      status: "connected",
      adapter,
    });

    const result = await bridge.sendTextMessage("telegram", "group-1", "<think>hidden</think>\n任务已更新", "pm", {
      replyContext: { messageThreadId: "thread-1" },
    });

    expect(result).toMatchObject({ platform: "telegram", chatId: "group-1", sessionKey: "telegram_group_group-1@pm" });
    expect(adapter.sendReply).toHaveBeenCalledWith("group-1", "任务已更新", { messageThreadId: "thread-1" });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "bridge_message",
      message: expect.objectContaining({
        platform: "telegram",
        direction: "out",
        agentId: "pm",
        text: "任务已更新",
        isGroup: true,
      }),
    }), null);
  });
});
