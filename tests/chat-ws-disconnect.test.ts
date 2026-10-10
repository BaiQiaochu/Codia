import { describe, expect, it, vi, afterEach } from "vitest";
import {
  DEFAULT_DISCONNECT_ABORT_GRACE_MS,
  createChatRoute,
  resolveDisconnectAbortGraceMs,
} from "../server/routes/chat.js";
import { t } from "../server/i18n.js";

describe("chat websocket disconnect lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("uses a minute-scale default WS disconnect abort grace and allows overriding it", () => {
    expect(DEFAULT_DISCONNECT_ABORT_GRACE_MS).toBeGreaterThanOrEqual(60_000);
    expect(resolveDisconnectAbortGraceMs(undefined)).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
    expect(resolveDisconnectAbortGraceMs("0")).toBe(0);
    expect(resolveDisconnectAbortGraceMs("45000")).toBe(45_000);
    expect(resolveDisconnectAbortGraceMs("-1")).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
    expect(resolveDisconnectAbortGraceMs("bad")).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
  });

  it("keeps long streaming tasks alive across transient websocket disconnects", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CODIA_WS_DISCONNECT_ABORT_GRACE_MS", "25");
    let wsFactory = null;
    const upgradeWebSocket = (factory) => {
      wsFactory = factory;
      return () => {};
    };
    const engine = {
      abortAllStreaming: vi.fn(async () => 1),
    };
    const hub = {
      subscribe: vi.fn(),
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = wsFactory({});
    handlers.onOpen({}, {});
    handlers.onClose({}, {});

    await vi.advanceTimersByTimeAsync(24);

    expect(engine.abortAllStreaming).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(engine.abortAllStreaming).toHaveBeenCalledTimes(1);
  });

  it("replays a terminal prompt error after reconnect when failure happened while disconnected", async () => {
    let wsFactory = null;
    let hubSubscriber = null;
    let releasePrompt;
    const promptCanFinish = new Promise((resolve) => {
      releasePrompt = resolve;
    });
    let promptStarted;
    const promptStartedPromise = new Promise((resolve) => {
      promptStarted = resolve;
    });
    const upgradeWebSocket = (factory) => {
      wsFactory = factory;
      return () => {};
    };
    const sessionPath = "/agents/a/sessions/s.jsonl";
    const engine = {
      agentName: "Codia",
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
    };
    const hub = {
      subscribe: vi.fn((callback) => {
        hubSubscriber = callback;
      }),
      send: vi.fn(async (_text, opts) => {
        hubSubscriber({ type: "session_status", isStreaming: true }, opts.sessionPath);
        promptStarted();
        await promptCanFinish;
        hubSubscriber({ type: "session_status", isStreaming: false }, opts.sessionPath);
        throw new Error("model connection lost");
      }),
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const firstHandlers = wsFactory({});
    const firstWs = { readyState: 1, send: vi.fn() };
    firstHandlers.onOpen({}, firstWs);
    firstHandlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "run long task", sessionPath }),
    }, firstWs);
    await promptStartedPromise;
    firstHandlers.onClose({}, firstWs);
    releasePrompt();
    await Promise.resolve();

    const secondHandlers = wsFactory({});
    const secondWs = { readyState: 1, send: vi.fn() };
    secondHandlers.onOpen({}, secondWs);
    secondHandlers.onMessage({
      data: JSON.stringify({ type: "resume_stream", sessionPath, sinceSeq: 0 }),
    }, secondWs);
    await Promise.resolve();

    const messages = secondWs.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const resumed = messages.find((msg) => msg.type === "stream_resume");
    expect(resumed).toBeTruthy();
    expect(resumed.isStreaming).toBe(false);
    expect(resumed.events.map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "model connection lost",
        terminal: true,
      }),
    );
  });

  it("broadcasts session_created hub events to websocket clients", async () => {
    let wsFactory = null;
    let hubSubscriber = null;
    const upgradeWebSocket = (factory) => {
      wsFactory = factory;
      return () => {};
    };
    const engine = {
      abortAllStreaming: vi.fn(async () => 0),
    };
    const hub = {
      subscribe: vi.fn((callback) => {
        hubSubscriber = callback;
      }),
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = wsFactory({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    hubSubscriber({
      type: "session_created",
      session: { path: "/sessions/new.jsonl", agentName: "Codia" },
    }, "/sessions/new.jsonl");

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: "session_created",
      sessionPath: "/sessions/new.jsonl",
      session: { path: "/sessions/new.jsonl", agentName: "Codia" },
    }));
  });

  it("falls back to visible output for a thinking-only stream when the provider ends without turn_end", async () => {
    let wsFactory = null;
    let hubSubscriber = null;
    const upgradeWebSocket = (factory) => {
      wsFactory = factory;
      return () => {};
    };
    const sessionPath = "/agents/a/sessions/thinking-only.jsonl";
    const engine = {
      getSessionByPath: vi.fn(() => null),
    };
    const hub = {
      eventBus: { emit: vi.fn() },
      subscribe: vi.fn((callback) => {
        hubSubscriber = callback;
      }),
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = wsFactory({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    hubSubscriber({ type: "session_status", isStreaming: true }, sessionPath);
    hubSubscriber({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
    }, sessionPath);
    hubSubscriber({ type: "session_status", isStreaming: false }, sessionPath);

    const messages = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(messages.map((msg) => msg.type)).toEqual(expect.arrayContaining([
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_delta",
      "turn_end",
      "status",
    ]));
    expect(messages.find((msg) => msg.type === "error")).toBeUndefined();
    expect(messages.find((msg) => msg.type === "text_delta")).toMatchObject({
      sessionPath,
      delta: "reasoning",
    });
  });

  it("falls back to visible output for think-tag-only text deltas", async () => {
    let wsFactory = null;
    let hubSubscriber = null;
    const upgradeWebSocket = (factory) => {
      wsFactory = factory;
      return () => {};
    };
    const sessionPath = "/agents/a/sessions/think-tag-only.jsonl";
    const engine = {
      getSessionByPath: vi.fn(() => null),
    };
    const hub = {
      eventBus: { emit: vi.fn() },
      subscribe: vi.fn((callback) => {
        hubSubscriber = callback;
      }),
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = wsFactory({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    hubSubscriber({ type: "session_status", isStreaming: true }, sessionPath);
    hubSubscriber({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "<think>reasoning</think>" },
    }, sessionPath);
    hubSubscriber({ type: "turn_end" }, sessionPath);

    const messages = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(messages.find((msg) => msg.type === "error")).toBeUndefined();
    expect(messages.find((msg) => msg.type === "text_delta")).toMatchObject({
      sessionPath,
      delta: "reasoning",
    });
  });
});
