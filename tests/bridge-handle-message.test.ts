// @ts-nocheck
/**
 * BridgeManager._handleMessage 测试
 *
  *
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

//

vi.mock("../lib/bridge/telegram-adapter.js", () => ({
  createTelegramAdapter: vi.fn(),
}));
vi.mock("../lib/bridge/feishu-adapter.js", () => ({
  createFeishuAdapter: vi.fn(),
}));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import os from "os";
import { BridgeManager } from "../lib/bridge/bridge-manager.js";

// ── Helpers ──

/** */
const tagged = (text) => expect.stringMatching(new RegExp(`^<t>\\d{2}-\\d{2} \\d{2}:\\d{2}</t> ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

function createMocks() {
  const adapter = {
    sendReply: vi.fn().mockResolvedValue(),
    sendBlockReply: vi.fn().mockResolvedValue(),
    stop: vi.fn(),
  };

  const engine = {
    getAgent: vi.fn().mockImplementation((id) => {
      if (id === "codia") return { agentName: "TestAgent", config: { bridge: { telegram: { owner: "owner123" } } } };
      return null;
    }),
    getBridgeReceiptEnabled: vi.fn(() => false),
    isBridgeSessionStreaming: vi.fn().mockReturnValue(false),
    abortBridgeSession: vi.fn().mockResolvedValue(false),
    steerBridgeSession: vi.fn().mockReturnValue(false),
    agentName: "TestAgent",
    codiaHome: os.tmpdir(),
    currentAgentId: "codia",
  };

  const hub = {
    send: vi.fn().mockResolvedValue("AI response"),
    eventBus: { emit: vi.fn() },
  };

  const bm = new BridgeManager({ engine, hub });
  //
  bm._platforms.set("telegram:codia", { adapter, status: "connected", agentId: "codia", platform: "telegram" });
  // Disable block streaming for simpler assertions
  bm.blockStreaming = false;

  return { bm, adapter, engine, hub };
}

// ── Tests ──

describe("BridgeManager._handleMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Group messages ──

  describe("group fast path", () => {
    it("sends immediately without debounce", async () => {
      const { bm, hub, adapter } = createMocks();

      // _flushGroupMessage is fire-and-forget (not awaited), wait for it
      const promise = bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@codia",
        text: "hello",
        senderName: "Alice",
        userId: "user1",
        isGroup: true,
        chatId: "g1",
        agentId: "codia",
      });
      await promise;
      // flush the unresolved group message promise
      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledOnce());

      expect(hub.send).toHaveBeenCalledWith(
        tagged("Alice: hello"),
        expect.objectContaining({ sessionKey: "tg_group_g1@codia", role: "guest", isGroup: true }),
      );
      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalled());
      expect(adapter.sendReply).toHaveBeenCalledWith("g1", "AI response", {});
    });

    it("prefixes sender name in group messages", async () => {
      const { bm, hub } = createMocks();

      await bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@codia",
        text: "hi there",
        senderName: "Bob",
        userId: "user2",
        isGroup: true,
        chatId: "g1",
        agentId: "codia",
      });

      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledWith(tagged("Bob: hi there"), expect.any(Object)));
    });
  });

  // ── DM debounce ──

  describe("DM debounce", () => {
    it("buffers messages and sends merged after 2s", async () => {
      const { bm, hub, adapter } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });
      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "world",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      expect(hub.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        expect.stringMatching(/^<t>\d{2}-\d{2} \d{2}:\d{2}<\/t> hello\nworld$/),
        expect.objectContaining({ sessionKey: "tg_dm_owner123@codia", role: "owner" }),
      );
      expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "AI response", {});
    });

    it("resets debounce timer on each new message", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "first",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(hub.send).not.toHaveBeenCalled();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "second",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(hub.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);
      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        expect.stringMatching(/^<t>\d{2}-\d{2} \d{2}:\d{2}<\/t> first\nsecond$/),
        expect.any(Object),
      );
    });

    it("uses owner role for owner DMs", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledWith(
        tagged("hi"),
        expect.objectContaining({ role: "owner" }),
      );
    });

    it("uses guest role for non-owner DMs", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_stranger@codia",
        text: "hi",
        senderName: "Stranger",
        userId: "stranger",
        chatId: "stranger",
        agentId: "codia",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledWith(
        tagged("Stranger: hi"),
        expect.objectContaining({ role: "guest" }),
      );
    });

    it("treats wechat DMs as owner sessions regardless of explicit owner config", async () => {
      const { bm, hub } = createMocks();
      const wechatAdapter = {
        sendReply: vi.fn().mockResolvedValue(),
        stop: vi.fn(),
      };
      bm._platforms.set("wechat:codia", { adapter: wechatAdapter, status: "connected", agentId: "codia", platform: "wechat" });

      bm._handleMessage("wechat", {
        sessionKey: "wx_dm_wxid123@codia",
        text: "hi from wechat",
        senderName: "wx-user",
        userId: "wxid123",
        chatId: "wxid123",
        agentId: "codia",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledWith(
        tagged("hi from wechat"),
        expect.objectContaining({ role: "owner", sessionKey: "wx_dm_wxid123@codia" }),
      );
    });

    it("uses declared native typing receipt instead of a text prompt", async () => {
      const { bm, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(true);
      adapter.sendTypingIndicator = vi.fn().mockResolvedValue();
      adapter.receiptCapabilities = {
        platform: "telegram",
        mode: "native_typing",
        scopes: ["dm"],
        refreshIntervalMs: 0,
        cancellable: false,
      };

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(adapter.sendTypingIndicator).toHaveBeenCalledWith("owner123", expect.any(Object));
      expect(adapter.sendReply).toHaveBeenCalledTimes(1);
      expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "AI response", {});
    });

    it("cancels declared native typing receipt after reply generation settles", async () => {
      const { bm, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(true);
      adapter.sendTypingIndicator = vi.fn().mockResolvedValue();
      adapter.cancelTypingIndicator = vi.fn().mockResolvedValue();
      adapter.receiptCapabilities = {
        platform: "wechat",
        mode: "native_typing",
        scopes: ["dm"],
        refreshIntervalMs: 0,
        cancellable: true,
      };

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      await vi.advanceTimersByTimeAsync(2100);

      await vi.waitFor(() => expect(adapter.cancelTypingIndicator).toHaveBeenCalledWith("owner123", expect.any(Object)));
      expect(adapter.cancelTypingIndicator).toHaveBeenCalledTimes(1);
    });

    it("passes message_id when downloading feishu image attachments", async () => {
      const { bm, hub } = createMocks();
      const feishuAdapter = {
        sendReply: vi.fn().mockResolvedValue(),
        sendBlockReply: vi.fn().mockResolvedValue(),
        stop: vi.fn(),
        downloadImage: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      };
      bm._platforms.set("feishu:codia", { adapter: feishuAdapter, status: "connected", agentId: "codia", platform: "feishu" });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@codia",
        text: "",
        userId: "stranger",
        senderName: "Stranger",
        chatId: "oc_123",
        agentId: "codia",
        attachments: [{
          type: "image",
          platformRef: "img_123",
          _messageId: "om_123",
          mimeType: "image/jpeg",
        }],
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(feishuAdapter.downloadImage).toHaveBeenCalledWith("img_123", "om_123");
      expect(hub.send).toHaveBeenCalledWith(
        tagged("Stranger: "),
        expect.objectContaining({
          images: [expect.objectContaining({ mimeType: "image/png" })],
        }),
      );
    });
  });

  // ── Abort ──

  describe("abort on new message", () => {
    it("uses steer (not abort) when session is streaming", async () => {
      const { bm, engine } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(true);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "new msg",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      //
      expect(engine.abortBridgeSession).not.toHaveBeenCalled();
    });

    it("does not steer if session is not streaming", async () => {
      const { bm, engine } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(false);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "new msg",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      expect(engine.abortBridgeSession).not.toHaveBeenCalled();
    });
  });

  // ── /stop command ──

  describe("/stop command", () => {
    it("aborts active session and clears pending buffer", async () => {
      const { bm, engine, hub } = createMocks();
      engine.abortBridgeSession.mockResolvedValue(true);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      await bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "/stop",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      expect(engine.abortBridgeSession).toHaveBeenCalledWith("tg_dm_owner123@codia");

      await vi.advanceTimersByTimeAsync(3000);
      expect(hub.send).not.toHaveBeenCalled();
    });

    it("non-owner /stop is treated as regular message", async () => {
      const { bm, engine, hub } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(false);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_stranger@codia",
        text: "/stop",
        senderName: "Stranger",
        userId: "stranger",
        chatId: "stranger",
        agentId: "codia",
      });

      //
      await vi.advanceTimersByTimeAsync(2100);
      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        tagged("Stranger: /stop"),
        expect.objectContaining({ role: "guest" }),
      );
    });
  });

  // ── Agent isolation ──

  describe("agent isolation via sessionKey", () => {
    it("same userId with different agentId produces different sessionKeys", async () => {
      const { bm, hub, engine } = createMocks();
      // Register a second agent adapter
      const kuroAdapter = { sendReply: vi.fn().mockResolvedValue(), sendBlockReply: vi.fn().mockResolvedValue(), stop: vi.fn() };
      bm._platforms.set("telegram:kuro", { adapter: kuroAdapter, status: "connected", agentId: "kuro", platform: "telegram" });
      engine.getAgent.mockImplementation((id) => {
        if (id === "codia") return { agentName: "TestAgent", config: { bridge: { telegram: { owner: "owner123" } } } };
        if (id === "kuro") return { agentName: "Kuro", config: { bridge: { telegram: { owner: "owner123" } } } };
        return null;
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "msg to codia",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@kuro",
        text: "msg to kuro",
        userId: "owner123",
        chatId: "owner123",
        agentId: "kuro",
      });

      await vi.advanceTimersByTimeAsync(2100);

      // Both messages should have been sent with their respective sessionKeys
      expect(hub.send).toHaveBeenCalledTimes(2);
      expect(hub.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: "tg_dm_owner123@codia" }),
      );
      expect(hub.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: "tg_dm_owner123@kuro" }),
      );
    });

    it("messages are properly isolated between agents (debounce per sessionKey)", async () => {
      const { bm, hub, engine } = createMocks();
      // Register a second agent adapter
      const kuroAdapter = { sendReply: vi.fn().mockResolvedValue(), sendBlockReply: vi.fn().mockResolvedValue(), stop: vi.fn() };
      bm._platforms.set("telegram:kuro", { adapter: kuroAdapter, status: "connected", agentId: "kuro", platform: "telegram" });
      engine.getAgent.mockImplementation((id) => {
        if (id === "codia") return { agentName: "TestAgent", config: { bridge: { telegram: { owner: "owner123" } } } };
        if (id === "kuro") return { agentName: "Kuro", config: { bridge: { telegram: { owner: "owner123" } } } };
        return null;
      });

      //
      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "hello codia",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });
      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@kuro",
        text: "hello kuro",
        userId: "owner123",
        chatId: "owner123",
        agentId: "kuro",
      });

      await vi.advanceTimersByTimeAsync(2100);

      // Each agent gets its own message, not merged
      expect(hub.send).toHaveBeenCalledTimes(2);
      const calls = hub.send.mock.calls;
      const codiaCall = calls.find(c => c[1].sessionKey === "tg_dm_owner123@codia");
      const kuroCall = calls.find(c => c[1].sessionKey === "tg_dm_owner123@kuro");
      expect(codiaCall[0]).toMatch(/hello codia/);
      expect(kuroCall[0]).toMatch(/hello kuro/);
      // Neither message contains the other agent's text
      expect(codiaCall[0]).not.toMatch(/hello kuro/);
      expect(kuroCall[0]).not.toMatch(/hello codia/);
    });
  });

  // ── Processing lock ──

  describe("processing lock", () => {
    it("prevents concurrent _flushPending for same sessionKey", async () => {
      const { bm, hub } = createMocks();

      let resolveFirst;
      hub.send.mockImplementationOnce(() =>
        new Promise((r) => { resolveFirst = r; })
      );

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "msg1",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });
      await vi.advanceTimersByTimeAsync(2100);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@codia",
        text: "msg2",
        userId: "owner123",
        chatId: "owner123",
        agentId: "codia",
      });
      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledOnce();

      resolveFirst("response 1");
      await vi.advanceTimersByTimeAsync(600);

      expect(hub.send).toHaveBeenCalledTimes(2);
      expect(hub.send).toHaveBeenLastCalledWith(tagged("msg2"), expect.any(Object));
    });
  });
});
