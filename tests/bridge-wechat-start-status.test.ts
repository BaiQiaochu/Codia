// @ts-nocheck
import os from "os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createWechatAdapter = vi.fn();

vi.mock("../lib/bridge/telegram-adapter.js", () => ({
  createTelegramAdapter: vi.fn(),
}));
vi.mock("../lib/bridge/feishu-adapter.js", () => ({
  createFeishuAdapter: vi.fn(),
}));
vi.mock("../lib/bridge/qq-adapter.js", () => ({
  createQQAdapter: vi.fn(),
}));
vi.mock("../lib/bridge/wechat-adapter.js", () => ({
  createWechatAdapter,
}));
vi.mock("../lib/bridge/whatsapp-adapter.js", () => ({
  createWhatsAppAdapter: vi.fn(),
}));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe("BridgeManager wechat startup status", async () => {
  const { BridgeManager } = await import("../lib/bridge/bridge-manager.js");

  beforeEach(() => {
    createWechatAdapter.mockReset();
  });

  it("starts wechat as connected like the original 0.103.1 flow", async () => {
    createWechatAdapter.mockImplementation(({ onStatus }) => {
      onStatus?.("connected");
      return {
        stop: vi.fn(),
      };
    });

    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      agentName: "G-SAP",
      getAgent: vi.fn(() => null),
    };
    const hub = {
      eventBus: { emit: vi.fn() },
    };
    const bm = new BridgeManager({ engine, hub });

    await bm.startPlatform("wechat", { botToken: "token", hanaHome: os.tmpdir() }, "agent-1");

    expect(bm.getStatus("agent-1").wechat.status).toBe("connected");
  });

  it("waits for the previous adapter to stop before restarting", async () => {
    let createCount = 0;
    let oldAdapterStopped = false;

    createWechatAdapter.mockImplementation(() => {
      createCount += 1;
      if (createCount === 1) {
        return {
          stop: vi.fn(() => new Promise((resolve) => {
            setTimeout(() => {
              oldAdapterStopped = true;
              resolve();
            }, 10);
          })),
        };
      }

      expect(oldAdapterStopped).toBe(true);
      return {
        stop: vi.fn(),
      };
    });

    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      agentName: "G-SAP",
      getAgent: vi.fn(() => null),
    };
    const hub = {
      eventBus: { emit: vi.fn() },
    };
    const bm = new BridgeManager({ engine, hub });

    await bm.startPlatform("wechat", { botToken: "token", hanaHome: os.tmpdir() }, "agent-1");
    await bm.startPlatform("wechat", { botToken: "token-2", hanaHome: os.tmpdir() }, "agent-1");

    expect(createCount).toBe(2);
    expect(oldAdapterStopped).toBe(true);
  });
});
