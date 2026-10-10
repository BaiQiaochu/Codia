import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DISCONNECT_ABORT_GRACE_MS,
  DEFAULT_TURN_STALL_ABORT_MS,
  createChatRoute,
  resolveDisconnectAbortGraceMs,
  resolveTurnStallAbortMs,
} from "../server/routes/chat.ts";
import { createRuntimeDiagnosticsService } from "../server/runtime-diagnostics-service.ts";

describe("chat route model switch guard", () => {
  it("records provider, model, classification, and a redacted underlying cause for model failures", async () => {
    let createHandlers;
    const sessionPath = "/tmp/diagnostic-session.jsonl";
    const secret = `sk-${"a".repeat(24)}`;
    const cause = Object.assign(
      new Error(`fetch failed with Authorization: Bearer ${secret}`),
      { code: "UND_ERR_CONNECT_TIMEOUT" },
    );
    const timeoutError = Object.assign(new Error("Request timed out."), {
      name: "APIConnectionTimeoutError",
      code: "ETIMEDOUT",
      cause,
    });
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn(async () => {
        throw timeoutError;
      }),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({
        model: { provider: "provider-a", id: "shared-model" },
        entries: [],
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };
    const runtimeDiagnostics = createRuntimeDiagnosticsService();

    createChatRoute(engine, hub, { upgradeWebSocket, runtimeDiagnostics });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "hello", sessionPath }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const diagnostic = runtimeDiagnostics.snapshot().diagnostics[0];
    expect(diagnostic).toMatchObject({
      category: "model",
      errorClassification: "timeout",
      model: { provider: "provider-a", id: "shared-model" },
      sanitizedDetails: {
        classification: "timeout",
        error: {
          name: "APIConnectionTimeoutError",
          code: "ETIMEDOUT",
          message: "Request timed out.",
        },
        cause: {
          name: "Error",
          code: "UND_ERR_CONNECT_TIMEOUT",
        },
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(diagnostic.sanitizedDetails.cause.message).toContain("[redacted]");

    handlers.onClose({}, ws);
  });

  it("uses a minute-scale default WS disconnect abort grace and allows disabling it", () => {
    expect(DEFAULT_DISCONNECT_ABORT_GRACE_MS).toBeGreaterThanOrEqual(60_000);
    expect(resolveDisconnectAbortGraceMs(undefined)).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
    expect(resolveDisconnectAbortGraceMs("0")).toBe(0);
    expect(resolveDisconnectAbortGraceMs("45000")).toBe(45_000);
    expect(resolveDisconnectAbortGraceMs("-1")).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
    expect(resolveDisconnectAbortGraceMs("bad")).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
    expect(DEFAULT_TURN_STALL_ABORT_MS).toBeGreaterThanOrEqual(60_000);
    expect(resolveTurnStallAbortMs(undefined)).toBe(DEFAULT_TURN_STALL_ABORT_MS);
    expect(resolveTurnStallAbortMs("0")).toBe(0);
    expect(resolveTurnStallAbortMs("120000")).toBe(120_000);
    expect(resolveTurnStallAbortMs("-1")).toBe(DEFAULT_TURN_STALL_ABORT_MS);
    expect(resolveTurnStallAbortMs("bad")).toBe(DEFAULT_TURN_STALL_ABORT_MS);
  });

  it("rejects prompts through the engine public switching API", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => null),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => true),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };

    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "hello",
        sessionPath: "/tmp/session.jsonl",
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.isSessionSwitching).toHaveBeenCalledWith("/tmp/session.jsonl");
    expect(hub.send).not.toHaveBeenCalled();
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "error",
      message: "正在切换模型，请稍候",
      sessionPath: "/tmp/session.jsonl",
    });
  });

  it("queues prompts received while the session is streaming and sends them after turn end", async () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/session.jsonl";
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };

    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "second",
        sessionPath,
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).not.toHaveBeenCalled();
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toContainEqual(expect.objectContaining({
      type: "turn_queued",
      sessionPath,
      queuedCount: 1,
    }));

    engine.isSessionStreaming.mockReturnValue(false);
    subscriber({ type: "turn_end" }, sessionPath);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).toHaveBeenCalledTimes(1);
    expect(hub.send).toHaveBeenCalledWith("second", expect.objectContaining({ sessionPath }));
  });

  it("routes websocket compact through the engine cache-preserving compact entrypoint", async () => {
    let createHandlers;
    const sessionPath = "/tmp/session.jsonl";
    const session = {
      isCompacting: false,
      compact: vi.fn(async () => undefined),
    };
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      compactDesktopSession: vi.fn(async () => ({
        tokensBefore: 120_000,
        tokensAfter: 20_000,
        contextWindow: 200_000,
      })),
      getSessionByPath: vi.fn(() => session),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    handlers.onOpen({}, ws);
    handlers.onMessage({
      data: JSON.stringify({ type: "compact", sessionPath }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.compactDesktopSession).toHaveBeenCalledWith(sessionPath);
    expect(session.compact).not.toHaveBeenCalled();
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "compaction_start", sessionPath }),
      expect.objectContaining({
        type: "compaction_end",
        sessionPath,
        tokens: 20_000,
        contextWindow: 200_000,
        percent: null,
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("drains queued prompts through follow-up mode when the SDK is still busy", async () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/session.jsonl";
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async (_text, opts) => {
        if (!opts?.streamingBehavior) throw new Error("session_busy");
      }),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };

    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "queued follow-up",
        sessionPath,
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    engine.isSessionStreaming.mockReturnValue(false);
    subscriber({ type: "turn_end" }, sessionPath);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).toHaveBeenCalledTimes(2);
    expect(hub.send).toHaveBeenNthCalledWith(1, "queued follow-up", expect.objectContaining({ sessionPath }));
    expect(hub.send).toHaveBeenNthCalledWith(2, "queued follow-up", expect.objectContaining({
      sessionPath,
      streamingBehavior: "followUp",
    }));
    const messages = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(messages).not.toContainEqual(expect.objectContaining({
      type: "error",
      sessionPath,
      message: expect.stringContaining("还在说话"),
    }));
  });

  it("reports engine runtime streaming separately when resume replay state is missing", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn((sessionPath) => sessionPath === "/tmp/running-session.jsonl"),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    handlers.onOpen({}, ws);

    handlers.onMessage({
      data: JSON.stringify({
        type: "resume_stream",
        sessionPath: "/tmp/running-session.jsonl",
        sinceSeq: 42,
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.isSessionStreaming).toHaveBeenCalledWith("/tmp/running-session.jsonl");
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "stream_resume",
      sessionPath: "/tmp/running-session.jsonl",
      streamId: null,
      sinceSeq: 42,
      nextSeq: 1,
      isStreaming: false,
      runtimeIsStreaming: true,
      events: [],
    });

    handlers.onClose({}, ws);
  });

  it("keeps remote and host clients on the same server-side session stream", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const hostWs = { readyState: 1, send: vi.fn() };
    const phoneWs = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, hostWs);
    handlers.onOpen({}, phoneWs);

    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "hello from phone",
        sessionPath: "/tmp/shared-session.jsonl",
      }),
    }, phoneWs);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).toHaveBeenCalledWith("hello from phone", expect.objectContaining({
      sessionPath: "/tmp/shared-session.jsonl",
    }));

    subscriber?.({
      type: "session_user_message",
      message: { id: "u1", text: "hello from phone" },
    }, "/tmp/shared-session.jsonl");

    for (const ws of [hostWs, phoneWs]) {
      expect(ws.send).toHaveBeenCalledWith(expect.any(String));
      const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(payloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "session_user_message",
          sessionPath: "/tmp/shared-session.jsonl",
          message: { id: "u1", text: "hello from phone" },
        }),
      ]));
    }

    handlers.onClose({}, hostWs);
    handlers.onClose({}, phoneWs);
  });

  it("emits file content blocks for deferred result session files", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "deferred_result",
      taskId: "img-task-1",
      status: "success",
      result: {
        files: ["abc.png"],
        sessionFiles: [{
          fileId: "sf_generated",
          filePath: "/tmp/generated/abc.png",
          label: "abc.png",
          ext: "png",
          mime: "image/png",
          kind: "image",
          storageKind: "plugin_data",
          status: "available",
        }],
      },
      meta: { type: "image-generation" },
    }, "/tmp/image-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "deferred_result",
        sessionPath: "/tmp/image-session.jsonl",
        taskId: "img-task-1",
        status: "success",
      }),
      expect.objectContaining({
        type: "content_block",
        sessionPath: "/tmp/image-session.jsonl",
        block: expect.objectContaining({
          type: "file",
          fileId: "sf_generated",
          filePath: "/tmp/generated/abc.png",
          label: "abc.png",
          ext: "png",
          mime: "image/png",
          kind: "image",
          storageKind: "plugin_data",
          status: "available",
        }),
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("delays visible deferred result blocks until the parent turn ends", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "派出去了。\n" },
    }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "deferred_result",
      taskId: "subagent-fast",
      status: "success",
      result: "回来了。",
      meta: {
        type: "subagent",
        executorAgentNameSnapshot: "Codia",
        label: "凌晨诗行",
        summary: "写一首关于凌晨五点三十九分的三行短诗。要求：不要使用常见意象。",
      },
    }, "/tmp/interlude-session.jsonl");

    let payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.some((payload) => payload.type === "deferred_result")).toBe(true);
    expect(payloads.some((payload) => payload.type === "content_block" && payload.block?.type === "interlude")).toBe(false);

    subscriber?.({ type: "turn_end" }, "/tmp/interlude-session.jsonl");

    payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const turnEndIndex = payloads.findIndex((payload) => payload.type === "turn_end");
    const interludeIndex = payloads.findIndex((payload) => payload.type === "content_block" && payload.block?.type === "interlude");
    expect(turnEndIndex).toBeGreaterThanOrEqual(0);
    expect(interludeIndex).toBeGreaterThan(turnEndIndex);
    expect(payloads[interludeIndex].block).toMatchObject({
      type: "interlude",
      taskId: "subagent-fast",
      sourceLabel: "Codia / 凌晨诗行",
    });

    handlers.onClose({}, ws);
  });

  it("delivers a turn completion desktop notification when the preference is enabled", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ turnCompletion: "when_unfocused" })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({
        entries: [],
        agentId: "agent-2",
        agentName: "小蓝",
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/notified-session.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "完成了。" },
    }, "/tmp/notified-session.jsonl");
    subscriber?.({ type: "turn_end" }, "/tmp/notified-session.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "小蓝",
        body: expect.any(String),
        channels: ["desktop"],
        desktopFocusPolicy: "when_unfocused",
        idempotencyKey: expect.stringContaining("turn-completion:/tmp/notified-session.jsonl:"),
      }),
      { agentId: "agent-2" },
    );

    handlers.onClose({}, ws);
  });

  it("delivers a session-aware turn completion notification with the completed sessionPath", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ turnCompletion: "when_session_unfocused" })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({
        entries: [],
        agentId: "agent-2",
        agentName: "小蓝",
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/session-aware.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "完成了。" },
    }, "/tmp/session-aware.jsonl");
    subscriber?.({ type: "turn_end" }, "/tmp/session-aware.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "小蓝",
        sessionPath: "/tmp/session-aware.jsonl",
        desktopFocusPolicy: "when_session_unfocused",
      }),
      { agentId: "agent-2" },
    );

    handlers.onClose({}, ws);
  });

  it("defers turn completion notification until runtime streaming stops", async () => {
    let createHandlers;
    let subscriber;
    let runtimeStreaming = true;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ turnCompletion: "when_session_unfocused" })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({
        entries: [],
        agentId: "agent-2",
        agentName: "Codia",
      })),
      isSessionStreaming: vi.fn(() => runtimeStreaming),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/deferred-notification.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "done" },
    }, "/tmp/deferred-notification.jsonl");
    subscriber?.({ type: "turn_end" }, "/tmp/deferred-notification.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).not.toHaveBeenCalled();

    runtimeStreaming = false;
    subscriber?.({ type: "session_status", isStreaming: false }, "/tmp/deferred-notification.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionPath: "/tmp/deferred-notification.jsonl",
        desktopFocusPolicy: "when_session_unfocused",
      }),
      { agentId: "agent-2" },
    );

    handlers.onClose({}, ws);
  });

  it("does not deliver turn completion notification after an aborted turn", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ turnCompletion: "when_unfocused" })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({ entries: [], agentId: "agent-2", agentName: "小蓝" })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/aborted-session.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "一半" },
    }, "/tmp/aborted-session.jsonl");
    handlers.onMessage({
      data: JSON.stringify({ type: "abort", sessionPath: "/tmp/aborted-session.jsonl" }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));
    subscriber?.({ type: "turn_end" }, "/tmp/aborted-session.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).not.toHaveBeenCalled();

    handlers.onClose({}, ws);
  });

  it("keeps standalone deferred results immediate across repeated deliveries", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    for (const taskId of ["standalone-1", "standalone-2"]) {
      subscriber?.({
        type: "deferred_result",
        taskId,
        status: "success",
        result: `result ${taskId}`,
        meta: { type: "subagent", executorAgentNameSnapshot: "明", label: "回执" },
      }, "/tmp/standalone-deferred.jsonl");
    }

    const interludeTaskIds = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((payload) => payload.type === "content_block" && payload.block?.type === "interlude")
      .map((payload) => payload.block.taskId);

    expect(interludeTaskIds).toEqual(["standalone-1", "standalone-2"]);

    handlers.onClose({}, ws);
  });

  it("emits plugin_card blocks from extension custom messages", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "message_end",
      message: {
        role: "custom",
        customType: "finance-market",
        content: "",
        display: true,
        details: {
          card: {
            pluginId: "finance-market",
            route: "/card?id=quote",
            title: "Quote",
          },
        },
      },
    }, "/tmp/plugin-card-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "content_block",
        sessionPath: "/tmp/plugin-card-session.jsonl",
        block: {
          type: "plugin_card",
          card: {
            pluginId: "finance-market",
            route: "/card?id=quote",
            title: "Quote",
            type: "iframe",
          },
        },
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("broadcasts browser_status events emitted outside tool execution", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "browser_status",
      running: false,
      url: null,
    }, "/tmp/browser-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "browser_status",
        running: false,
        url: null,
        sessionPath: "/tmp/browser-session.jsonl",
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("broadcasts session metadata updates emitted outside tool execution", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "session_metadata_updated",
      metadata: { pinnedAt: "2026-04-29T08:00:00.000Z", thinkingLevel: "high" },
    }, "/tmp/metadata-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session_metadata_updated",
        sessionPath: "/tmp/metadata-session.jsonl",
        metadata: {
          pinnedAt: "2026-04-29T08:00:00.000Z",
          thinkingLevel: "high",
        },
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("does not serialize broadcast payloads for closed clients", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Codia",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const closedWs = { readyState: 3, send: vi.fn() };
    handlers.onOpen({}, closedWs);

    const toxicSession = {
      toJSON() {
        throw new Error("closed clients must not force serialization");
      },
    };

    expect(() => {
      subscriber?.({
        type: "session_created",
        session: toxicSession,
      }, "/tmp/closed-client-session.jsonl");
    }).not.toThrow();
    expect(closedWs.send).not.toHaveBeenCalled();

    handlers.onClose({}, closedWs);
  });
});
