// @ts-nocheck
import os from "os";
import { describe, expect, it, vi } from "vitest";
import { BridgeManager } from "../lib/bridge/bridge-manager.js";

function createBridgeManager() {
  const engine = {
    hanakoHome: os.tmpdir(),
    agent: null,
    agentName: "G-SAP",
    getAgent: vi.fn(() => null),
  };
  const hub = {
    eventBus: { emit: vi.fn() },
  };
  return new BridgeManager({ engine, hub });
}

describe("BridgeManager status metadata", () => {
  it("refreshes lastSyncAt when a platform message is pushed", () => {
    const bm = createBridgeManager();

    bm._platforms.set("qq:agent-1", {
      adapter: { getStatus: () => ({}) },
      status: "connected",
      error: null,
      errorType: null,
      errorDetail: null,
      agentId: "agent-1",
      platform: "qq",
    });
    bm._recordPlatformStatus("qq", "agent-1", "connected");

    const before = bm.getStatus("agent-1").qq.lastSyncAt;
    bm._pushMessage({
      platform: "qq",
      direction: "in",
      sessionKey: "qq_dm_u1@agent-1",
      agentId: "agent-1",
      sender: "user",
      text: "hello",
      ts: Date.now(),
    });

    const after = bm.getStatus("agent-1").qq.lastSyncAt;

    expect(before).toBeNull();
    expect(typeof after).toBe("number");
    expect(after).toBeGreaterThan(0);
  });

  it("passes adapter getStatus metadata through platform status", () => {
    const bm = createBridgeManager();

    bm._platforms.set("telegram:agent-1", {
      adapter: { getStatus: () => ({ adapterVersion: "telegram-test-1", ready: true }) },
      status: "connected",
      error: null,
      errorType: null,
      errorDetail: null,
      agentId: "agent-1",
      platform: "telegram",
    });
    bm._recordPlatformStatus("telegram", "agent-1", "connected");

    expect(bm.getStatus("agent-1").telegram).toMatchObject({
      adapterVersion: "telegram-test-1",
      ready: true,
      status: "connected",
    });
  });

  it("uses the bridge owner policy for feishu proactive sends", async () => {
    const adapter = {
      sendReply: vi.fn().mockResolvedValue(),
      resolveOwnerChatId: vi.fn(() => null),
    };
    const recordAssistantMessage = vi.fn(() => true);
    const engine = {
      hanakoHome: os.tmpdir(),
      agentName: "G-SAP",
      bridgeSessionManager: { recordAssistantMessage },
      getAgent: vi.fn((id) => id === "agent-1" ? {
        id: "agent-1",
        agentName: "Agent One",
        config: { bridge: { feishu: { owner: "ou_owner" } } },
      } : null),
      getBridgeIndex: vi.fn(() => ({
        "fs_dm_ou_owner@agent-1": {
          file: "owner.jsonl",
          userId: "ou_owner",
          chatId: "oc_actual_chat",
        },
      })),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });
    bm._platforms.set("feishu:agent-1", {
      adapter,
      status: "connected",
      agentId: "agent-1",
      platform: "feishu",
    });

    const result = await bm.sendProactive("hello", "agent-1");

    expect(adapter.sendReply).toHaveBeenCalledWith("oc_actual_chat", "hello", {});
    expect(recordAssistantMessage).toHaveBeenCalledWith(
      "fs_dm_ou_owner@agent-1",
      "hello",
      expect.objectContaining({
        agentId: "agent-1",
        createIfMissing: true,
        meta: expect.objectContaining({
          userId: "ou_owner",
          chatId: "oc_actual_chat",
        }),
      }),
    );
    expect(result).toEqual({
      platform: "feishu",
      chatId: "oc_actual_chat",
      sessionKey: "fs_dm_ou_owner@agent-1",
      recorded: true,
    });
  });

  it("can skip proactive bridge context recording", async () => {
    const adapter = {
      sendReply: vi.fn().mockResolvedValue(),
      resolveOwnerChatId: vi.fn(() => null),
    };
    const recordAssistantMessage = vi.fn(() => true);
    const engine = {
      hanakoHome: os.tmpdir(),
      agentName: "G-SAP",
      bridgeSessionManager: { recordAssistantMessage },
      getAgent: vi.fn((id) => id === "agent-1" ? {
        id: "agent-1",
        agentName: "Agent One",
        config: { bridge: { feishu: { owner: "ou_owner" } } },
      } : null),
      getBridgeIndex: vi.fn(() => ({
        "fs_dm_ou_owner@agent-1": {
          file: "owner.jsonl",
          userId: "ou_owner",
          chatId: "oc_actual_chat",
        },
      })),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });
    bm._platforms.set("feishu:agent-1", {
      adapter,
      status: "connected",
      agentId: "agent-1",
      platform: "feishu",
    });

    const result = await bm.sendProactive("hello", "agent-1", { contextPolicy: "none" });

    expect(adapter.sendReply).toHaveBeenCalledWith("oc_actual_chat", "hello", {});
    expect(recordAssistantMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      platform: "feishu",
      chatId: "oc_actual_chat",
      sessionKey: "fs_dm_ou_owner@agent-1",
      recorded: false,
    });
  });
});
