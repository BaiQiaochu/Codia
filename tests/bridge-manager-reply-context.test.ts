import { describe, expect, it, vi } from "vitest";

import { BridgeManager } from "../lib/bridge/bridge-manager.js";

function createManager() {
  const engine = {
    agentName: "Codia",
    codiaHome: process.cwd(),
    getAgents: () => [],
    getBridgeMediaPublicBaseUrl: () => "",
  };
  return new BridgeManager({ engine, hub: { subscribe: () => () => {} } });
}

describe("BridgeManager reply context", () => {
  it("normalizes platform message ids and target scope for adapter replies", () => {
    const manager = createManager();

    expect(manager._replyContextFromMessage({
      isGroup: true,
      messageId: "mid-1",
      targetType: "group",
    })).toEqual({
      messageId: "mid-1",
      targetType: "group",
      isGroup: true,
      targetScope: "group",
    });

    expect(manager._replyContextFromMessage({
      isGroup: false,
      messageThreadId: 123,
    })).toEqual({
      messageThreadId: 123,
      isGroup: false,
      targetScope: "dm",
    });
  });

  it("passes normalized reply context to adapter reply methods", async () => {
    const manager = createManager();
    const adapter = {
      sendReply: vi.fn(async () => {}),
      sendBlockReply: vi.fn(async () => {}),
    };

    await manager._sendAdapterReply(adapter, "chat-1", "hello", {
      messageId: "mid-1",
      isGroup: true,
    });
    await manager._sendAdapterBlockReply(adapter, "chat-1", "stream", {
      messageId: "mid-2",
      targetType: "group",
    });

    expect(adapter.sendReply).toHaveBeenCalledWith("chat-1", "hello", {
      messageId: "mid-1",
      isGroup: true,
    });
    expect(adapter.sendBlockReply).toHaveBeenCalledWith("chat-1", "stream", {
      messageId: "mid-2",
      targetType: "group",
    });
  });
});
