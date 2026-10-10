// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeReliabilityLedger } from "../lib/bridge/bridge-reliability-ledger.js";
import { BridgeManager } from "../lib/bridge/bridge-manager.js";

describe("bridge reliability ledger", () => {
  let tempRoot = null;

  afterEach(() => {
    vi.useRealTimers();
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function makeTempRoot() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-bridge-reliability-"));
    return tempRoot;
  }

  it("persists bridge messages and dead letters", () => {
    const dir = makeTempRoot();
    const ledger = new BridgeReliabilityLedger({ dataDir: dir, now: () => 1000 });

    ledger.recordMessage({
      platform: "telegram",
      direction: "in",
      sessionKey: "tg_group_team@agent-1",
      chatId: "team",
      agentId: "agent-1",
      text: "hello",
    });
    ledger.recordDeadLetter({
      platform: "telegram",
      chatId: "team",
      sessionKey: "tg_group_team@agent-1",
      kind: "text",
      payload: { text: "failed" },
      error: "network down",
    });

    const restored = new BridgeReliabilityLedger({ dataDir: dir, now: () => 2000 });
    expect(restored.summary()).toMatchObject({
      messages: 1,
      deadLetters: 1,
      pendingDeadLetters: 1,
    });
    expect(restored.listDeadLetters()[0]).toMatchObject({
      platform: "telegram",
      chatId: "team",
      error: "network down",
      status: "pending",
    });
  });

  it("records outbound send failures as bridge dead letters", async () => {
    const root = makeTempRoot();
    const adapter = {
      sendReply: vi.fn().mockRejectedValue(new Error("transport offline")),
      capabilities: {},
    };
    const engine = {
      codiaHome: root,
      agentName: "Codia",
      getAgent: vi.fn(() => null),
    };
    const bm = new BridgeManager({ engine, hub: { eventBus: { emit: vi.fn() } } });
    bm._platforms.set("telegram:agent-1", {
      adapter,
      status: "connected",
      agentId: "agent-1",
      platform: "telegram",
    });
    Object.defineProperties(adapter, {
      __bridgePlatform: { value: "telegram", configurable: true },
      __bridgeAgentId: { value: "agent-1", configurable: true },
    });

    await expect(bm.sendTextMessage("telegram", "chat-1", "hello", "agent-1")).rejects.toThrow("transport offline");
    expect(bm.getReliabilitySummary()).toMatchObject({
      deadLetters: 1,
      pendingDeadLetters: 1,
    });
    expect(bm.getDeadLetters()[0]).toMatchObject({
      platform: "telegram",
      agentId: "agent-1",
      chatId: "chat-1",
      kind: "text",
    });
  });

  it("retries due text dead letters and records channel attribution", async () => {
    const root = makeTempRoot();
    const adapter = {
      sendReply: vi.fn(async () => ({ ok: true })),
      capabilities: {},
    };
    const engine = {
      codiaHome: root,
      agentName: "Codia",
      getAgent: vi.fn(() => ({ agentName: "Worker" })),
    };
    const bm = new BridgeManager({ engine, hub: { eventBus: { emit: vi.fn() } } });
    bm._platforms.set("telegram:agent-1", {
      adapter,
      status: "connected",
      agentId: "agent-1",
      platform: "telegram",
    });
    Object.defineProperties(adapter, {
      __bridgePlatform: { value: "telegram", configurable: true },
      __bridgeAgentId: { value: "agent-1", configurable: true },
    });
    bm._reliability.recordDeadLetter({
      platform: "telegram",
      chatId: "chat-1",
      sessionKey: "tg_group_chat-1@agent-1",
      agentId: "agent-1",
      kind: "text",
      payload: { text: "recover me" },
      nextRetryAt: 0,
    });

    const summary = await bm.retryDueDeadLetters();

    expect(summary).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
    expect(adapter.sendReply).toHaveBeenCalledWith("chat-1", "recover me", {});
    expect(bm.getDeadLetters({ includeResolved: true })[0]).toMatchObject({
      status: "delivered",
      deliveredAt: expect.any(Number),
    });
    expect(bm.getReliabilitySummary().byChannel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelId: "tg_group_chat-1@agent-1", messages: 1 }),
      ]),
    );
  });

  it("schedules reconnect with backoff when a configured bridge enters error status", async () => {
    vi.useFakeTimers();
    const root = makeTempRoot();
    const engine = {
      codiaHome: root,
      getAgent: vi.fn(() => ({
        config: { bridge: { qq: { enabled: true, appID: "app", appSecret: "secret" } } },
      })),
    };
    const bm = new BridgeManager({ engine, hub: { eventBus: { emit: vi.fn() } } });
    const reconnect = vi.spyOn(bm, "startPlatformFromConfig").mockImplementation(() => {});

    bm._recordPlatformStatus("qq", "agent-1", "error", "offline");
    expect(reconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(reconnect).toHaveBeenCalledWith(
      "qq",
      expect.objectContaining({ enabled: true, appID: "app" }),
      "agent-1",
    );
  });
});
