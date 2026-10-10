import { describe, expect, it, vi } from "vitest";

import {
  DINGTALK_BOT_CALLBACK_TOPIC,
  DINGTALK_MEDIA_CAPABILITIES,
  DINGTALK_STREAMING_CAPABILITIES,
  createDingTalkAdapter,
} from "../lib/bridge/dingtalk-adapter.ts";

type FakeWebSocketHandler = (payload?: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CLOSED = 3;

  url: string;
  options: any;
  sent: string[] = [];
  readyState = 1;
  handlers = new Map<string, FakeWebSocketHandler[]>();

  constructor(url: string, options?: any) {
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  on(event: string, handler: FakeWebSocketHandler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, payload?: any) {
    for (const handler of this.handlers.get(event) || []) {
      handler(payload);
    }
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }
}

function jsonResponse(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function makeAdapter(fetchMock: ReturnType<typeof vi.fn>, onMessage = vi.fn(), onStatus = vi.fn()) {
  return createDingTalkAdapter({
    clientId: "dt-client",
    clientSecret: "dt-secret",
    robotCode: "ding-robot",
    agentId: "codia",
    onMessage,
    onStatus,
    fetchImpl: fetchMock as any,
    WebSocketImpl: FakeWebSocket as any,
  });
}

function streamEnvelope(data: any, messageId = "msg-1") {
  return JSON.stringify({
    type: "CALLBACK",
    headers: {
      topic: DINGTALK_BOT_CALLBACK_TOPIC,
      contentType: "application/json",
      messageId,
      time: Date.now(),
    },
    data: JSON.stringify(data),
  });
}

describe("DingTalk bridge adapter", () => {
  it("opens the official stream connection and subscribes to bot callbacks", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-1",
    }));
    const onStatus = vi.fn();

    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus);

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/gateway/connections/open",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(DINGTALK_BOT_CALLBACK_TOPIC),
      }),
    );
    const registerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(registerBody).toMatchObject({
      clientId: "dt-client",
      clientSecret: "dt-secret",
      subscriptions: [{ topic: DINGTALK_BOT_CALLBACK_TOPIC, type: "CALLBACK" }],
    });
    expect(FakeWebSocket.instances[0].url).toBe("wss://api.dingtalk.com/connect?ticket=ticket-1");

    FakeWebSocket.instances[0].emit("open");
    expect(onStatus).toHaveBeenCalledWith("connected");

    adapter.stop();
  });

  it("normalizes private text callbacks and acknowledges the stream message", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-1",
    }));
    const onMessage = vi.fn();

    const adapter = makeAdapter(fetchMock, onMessage);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].emit("message", streamEnvelope({
      conversationId: "cid-private",
      conversationType: "1",
      msgId: "ding-msg-1",
      senderNick: "Alice",
      senderStaffId: "manager1234",
      senderId: "sender-open-id",
      msgtype: "text",
      text: { content: "hello DingTalk!" },
      robotCode: "ding-robot",
    }, "stream-msg-1"));

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: "dingtalk",
      agentId: "codia",
      chatId: "manager1234",
      userId: "manager1234",
      sessionKey: "dt_dm_manager1234@codia",
      text: "hello DingTalk!",
      senderName: "Alice",
      isGroup: false,
      _msgId: "ding-msg-1",
    }));
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toMatchObject({
      code: 200,
      headers: {
        contentType: "application/json",
        messageId: "stream-msg-1",
      },
      message: "OK",
    });

    adapter.stop();
  });

  it("uses conversation-scoped session keys for group callbacks", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-1",
    }));
    const onMessage = vi.fn();

    const adapter = makeAdapter(fetchMock, onMessage);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].emit("message", streamEnvelope({
      conversationId: "cid-group",
      conversationType: "2",
      msgId: "ding-msg-2",
      senderNick: "Bob",
      senderStaffId: "staff-bob",
      msgtype: "text",
      text: { content: "group hello" },
      robotCode: "ding-robot",
    }));

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "cid-group",
      userId: "staff-bob",
      sessionKey: "dt_group_cid-group@codia",
      text: "group hello",
      isGroup: true,
    }));

    adapter.stop();
  });

  it("sends private and group replies through DingTalk robot REST APIs", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "token-1", expireIn: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "dm-task" }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "group-task" }));

    const adapter = makeAdapter(fetchMock);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await adapter.sendReply("manager1234", "direct hello", { targetScope: "dm" });
    await adapter.sendReply("cid-group", "group hello", { targetScope: "group" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.dingtalk.io/v1.0/oauth2/accessToken",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ appKey: "dt-client", appSecret: "dt-secret" }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      robotCode: "ding-robot",
      userIds: ["manager1234"],
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title: "CODIA", text: "direct hello" }),
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      robotCode: "ding-robot",
      openConversationId: "cid-group",
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title: "CODIA", text: "group hello" }),
    });

    adapter.stop();
  });

  it("sends public image URLs as DingTalk markdown media payloads", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "token-1", expireIn: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "media-task" }));

    const adapter = makeAdapter(fetchMock);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await adapter.sendMedia("cid-group", "https://cdn.example.com/cat.png", {
      targetScope: "group",
      kind: "image",
      filename: "cat.png",
    });

    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      robotCode: "ding-robot",
      openConversationId: "cid-group",
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title: "cat.png", text: "![cat.png](https://cdn.example.com/cat.png)" }),
    });

    adapter.stop();
  });

  it("splits long replies before sending DingTalk markdown payloads", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "token-1", expireIn: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "part-1" }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "part-2" }));
    const adapter = makeAdapter(fetchMock);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const text = "你".repeat(5000);
    await adapter.sendReply("manager1234", text, { targetScope: "dm" });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const first = JSON.parse(JSON.parse(fetchMock.mock.calls[2][1].body).msgParam);
    const second = JSON.parse(JSON.parse(fetchMock.mock.calls[3][1].body).msgParam);
    expect(first.title).toBe("CODIA 1/2");
    expect(second.title).toBe("CODIA 2/2");
    expect(first.text + second.text).toBe(text);

    adapter.stop();
  });

  it("declares batch text streaming only after the final message is ready", () => {
    expect(DINGTALK_STREAMING_CAPABILITIES).toMatchObject({
      platform: "dingtalk",
      mode: "batch",
      scopes: ["dm", "group"],
      renderer: "text",
    });
  });

  it("declares public URL media capabilities for DingTalk markdown relay", () => {
    expect(DINGTALK_MEDIA_CAPABILITIES).toMatchObject({
      platform: "dingtalk",
      inputModes: ["remote_url", "public_url"],
      supportedKinds: ["image", "video", "audio", "document"],
      requiresReplyContext: false,
      deliveryByKind: {
        image: "markdown_image",
        video: "markdown_link",
        audio: "markdown_link",
        document: "markdown_link",
      },
    });
  });
});
