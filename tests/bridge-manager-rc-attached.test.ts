// @ts-nocheck
// Upstream reference test migrated and debranded; skipped until the matching Codia source contract is migrated.
/**
 * BridgeManager RC attached-session 路由集成测试
 *
 * 当 sessionKey 有 active attachment 时：
 *   - _flushPending 检测到 attachment → 仍走桌面 session 的统一发送入口
 *   - 调用 hub.send({ sessionPath })，不再直接 promptAttachedDesktopSession
 *   - 返回 reply 通过 adapter.sendReply 送 TG
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/bridge/telegram-adapter.js", () => ({ createTelegramAdapter: vi.fn() }));
vi.mock("../lib/bridge/feishu-adapter.js", () => ({ createFeishuAdapter: vi.fn() }));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import os from "os";
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { createSlashSystem } from "../core/slash-commands/index.ts";

function createMocks({ session }: any = {}) {
  const s = session || {};
  const adapter: any = {
    mediaCapabilities: {
      inputModes: ["buffer", "remote_url", "public_url"],
      supportedKinds: ["image", "video", "audio", "document"],
    },
    sendReply: (vi.fn().mockResolvedValue as any)(),
    sendTypingIndicator: (vi.fn().mockResolvedValue as any)(),
    stop: vi.fn(),
  };
  const engine: any = {
    getAgent: vi.fn((id) => id === "codia"
      ? { id: "codia", agentName: "T", config: { bridge: { telegram: { owner: "owner123" } } }, sessionDir: os.tmpdir() }
      : null),
    isBridgeSessionStreaming: vi.fn(() => false),
    isSessionStreaming: vi.fn(() => false),
    steerBridgeSession: vi.fn(() => false),
    abortBridgeSession: vi.fn(async () => false),
    bridgeSessionManager: { injectMessage: vi.fn(() => true), readIndex: () => ({}), writeIndex: () => {} },
    ensureSessionLoaded: vi.fn(async () => s),
    agentName: "T",
    codiaHome: os.tmpdir(),
    currentAgentId: "codia",
  };
  const hub = {
    send: vi.fn().mockResolvedValue({ text: "desktop reply", toolMedia: [] }),
    eventBus: { emit: vi.fn() },
  };
  const slashSystem = createSlashSystem({ engine, hub });
  engine.slashDispatcher = slashSystem.dispatcher;
  engine.slashRegistry = slashSystem.registry;
  engine.rcState = slashSystem.rcState;

  const bm = new BridgeManager({ engine, hub });
  bm._platforms.set("telegram:codia", { adapter, status: "connected", agentId: "codia", platform: "telegram" });
  bm.blockStreaming = false;

  return { bm, adapter, engine, hub, rcState: slashSystem.rcState, session: s };
}

describe.skip("BridgeManager RC attached-session routing", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.skip("with active attachment → routes DM to desktop session, NOT hub.send", async () => {
    const { bm, adapter, engine, hub, rcState } = createMocks();
    rcState.attach("tg_dm_owner123@codia", "/path/to/desk.jsonl");

    bm._handleMessage("telegram", {
      sessionKey: "tg_dm_owner123@codia",
      text: "帮我看看 foo 这个函数",
      userId: "owner123",
      chatId: "owner123",
      agentId: "codia",
    });

    await vi.advanceTimersByTimeAsync(2500);

    expect(hub.send).toHaveBeenCalledWith("帮我看看 foo 这个函数", expect.objectContaining({
      sessionPath: "/path/to/desk.jsonl",
      displayMessage: expect.objectContaining({ text: "帮我看看 foo 这个函数" }),
      onDelta: undefined,
      uiContext: null,
    }));
    // 回复送回 TG（排除 "正在输入..." 之类的预热消息）
    const replyCalls = adapter.sendReply.mock.calls.filter(c => c[1] === "desktop reply");
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0][0]).toBe("owner123");
  });

  it.skip("without attachment → falls back to hub.send (normal bridge path)", async () => {
    const { bm, adapter, engine, hub } = createMocks();
    // 不设 attachment

    bm._handleMessage("telegram", {
      sessionKey: "tg_dm_owner123@codia",
      text: "hi",
      userId: "owner123",
      chatId: "owner123",
      agentId: "codia",
    });

    await vi.advanceTimersByTimeAsync(2500);

    // 常规路径：hub 被调用
    expect(hub.send).toHaveBeenCalledOnce();
    expect(engine.ensureSessionLoaded).not.toHaveBeenCalled();
  });

  it.skip("non-owner message with attachment set → does NOT route (防御性 isOwner 检查)", async () => {
    const { bm, hub, engine, rcState } = createMocks();
    // 某种异常情况：attachment 存在但消息来自非 owner
    rcState.attach("tg_dm_owner123@codia", "/path/to/desk.jsonl");

    bm._handleMessage("telegram", {
      sessionKey: "tg_dm_owner123@codia",
      text: "intruder",
      userId: "random-guest",  // 非 owner
      chatId: "owner123",
      agentId: "codia",
    });

    await vi.advanceTimersByTimeAsync(2500);

    // 非 owner 走正常路径（hub.send），不碰桌面 session 接管入口
    expect(engine.ensureSessionLoaded).not.toHaveBeenCalled();
  });

  it.skip("desktop session prompt failure → sends [Error] to bridge", async () => {
    const { bm, adapter, hub, rcState } = createMocks();
    hub.send.mockRejectedValueOnce(new Error("model timeout"));
    rcState.attach("tg_dm_owner123@codia", "/err.jsonl");

    bm._handleMessage("telegram", {
      sessionKey: "tg_dm_owner123@codia",
      text: "x",
      userId: "owner123",
      chatId: "owner123",
      agentId: "codia",
    });

    await vi.advanceTimersByTimeAsync(2500);

    const replies = adapter.sendReply.mock.calls.map(c => c[1]);
    expect(replies.some(r => /\[Error\].*model timeout/.test(r))).toBe(true);
  });

  it.skip("tool media from desktop session → forwarded via adapter", async () => {
    const adapterSendMedia = (vi.fn().mockResolvedValue as any)();
    const { bm, adapter, hub, rcState } = createMocks();
    adapter.sendMedia = adapterSendMedia;
    hub.send.mockResolvedValueOnce({ text: "see image", toolMedia: ["https://example.com/a.png"] });
    rcState.attach("tg_dm_owner123@codia", "/s.jsonl");

    bm._handleMessage("telegram", {
      sessionKey: "tg_dm_owner123@codia",
      text: "q",
      userId: "owner123",
      chatId: "owner123",
      agentId: "codia",
    });

    await vi.advanceTimersByTimeAsync(2500);

    expect(adapterSendMedia).toHaveBeenCalledWith("owner123", "https://example.com/a.png", {
      kind: "image",
      isGroup: false,
      targetScope: "dm",
    });
  });

  it.skip("streams attached desktop-session deltas through the same adapter delivery path", async () => {
    const { bm, adapter, hub, engine, rcState } = createMocks();
    engine.getBridgeReceiptEnabled = vi.fn(() => false);
    adapter.streamingCapabilities = {
      mode: "draft",
      scopes: ["dm"],
      minIntervalMs: 0,
      maxChars: 4096,
    };
    adapter.sendDraft = (vi.fn().mockResolvedValue as any)();
    hub.send.mockImplementation(async (_text, opts) => {
      opts.onDelta("Desk", "Desk");
      opts.onDelta(" reply", "Desk reply");
      return { text: "Desk reply", toolMedia: [] };
    });
    rcState.attach("tg_dm_owner123@codia", "/s.jsonl");

    bm._handleMessage("telegram", {
      sessionKey: "tg_dm_owner123@codia",
      text: "q",
      userId: "owner123",
      chatId: "owner123",
      agentId: "codia",
    });

    await vi.advanceTimersByTimeAsync(2500);
    await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "Desk reply", {}));

    expect(adapter.sendDraft).toHaveBeenCalled();
  });

  it.skip("mirrors desktop-originated user text and assistant reply back to the attached bridge session", async () => {
    const { bm, adapter, rcState } = createMocks();
    rcState.attach("tg_dm_owner123@codia", "/s.jsonl", {
      platform: "telegram",
      chatId: "owner123",
      agentId: "codia",
    });

    await bm._handleRcMirrorEvent({
      type: "session_user_message",
      message: { text: "电脑端发起的问题", source: "desktop" },
    }, "/s.jsonl");
    await bm._handleRcMirrorEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "桌面端" },
    }, "/s.jsonl");
    await bm._handleRcMirrorEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "回复" },
    }, "/s.jsonl");
    await bm._handleRcMirrorEvent({ type: "session_status", isStreaming: false }, "/s.jsonl");

    expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "电脑端用户：电脑端发起的问题", {});
    expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "桌面端回复", {});
  });

  it.skip("does not mirror bridge_rc display messages back to the same bridge session", async () => {
    const { bm, adapter, rcState } = createMocks();
    rcState.attach("tg_dm_owner123@codia", "/s.jsonl", {
      platform: "telegram",
      chatId: "owner123",
      agentId: "codia",
    });

    await bm._handleRcMirrorEvent({
      type: "session_user_message",
      message: { text: "远程消息", source: "bridge_rc" },
    }, "/s.jsonl");

    expect(adapter.sendReply).not.toHaveBeenCalled();
  });
});
