// @ts-nocheck
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockContactUserGet = vi.fn();
const mockImageGet = vi.fn();
const mockMessageResourceGet = vi.fn();
const mockMessageCreate = vi.fn();
const mockMessageUpdate = vi.fn();
const mockImageCreate = vi.fn();
const mockFileCreate = vi.fn();
const mockWsStart = vi.fn();
const mockWsClose = vi.fn();

let registeredHandlers = {};
let mockWsInstances = [];

vi.mock("@larksuiteoapi/node-sdk", () => {
  class MockEventDispatcher {
    register(handlers) {
      registeredHandlers = handlers;
      return this;
    }
  }

  class MockWSClient {
    constructor() {
      this.wsConfig = { wsInstance: { readyState: 1 } };
      mockWsInstances.push(this);
    }

    start(...args) {
      return mockWsStart(...args);
    }

    close(...args) {
      return mockWsClose(...args);
    }
  }

  class MockClient {
    constructor() {
      this.contact = {
        user: {
          get: mockContactUserGet,
        },
      };
      this.im = {
        image: {
          get: mockImageGet,
          create: mockImageCreate,
        },
        file: {
          create: mockFileCreate,
        },
        messageResource: {
          get: mockMessageResourceGet,
        },
        message: {
          create: mockMessageCreate,
          update: mockMessageUpdate,
        },
      };
    }
  }

  return {
    Client: MockClient,
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
    LoggerLevel: { warn: "warn" },
  };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
}));

import { createFeishuAdapter } from "../lib/bridge/feishu-adapter.js";

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function latestWsClient() {
  return mockWsInstances[mockWsInstances.length - 1];
}

describe("createFeishuAdapter", () => {
  beforeEach(() => {
    registeredHandlers = {};
    mockWsInstances = [];
    mockContactUserGet.mockReset();
    mockImageGet.mockReset();
    mockMessageResourceGet.mockReset();
    mockMessageCreate.mockReset();
    mockMessageUpdate.mockReset();
    mockImageCreate.mockReset();
    mockFileCreate.mockReset();
    mockWsStart.mockReset();
    mockWsClose.mockReset();

    mockWsStart.mockResolvedValue(undefined);
    mockContactUserGet.mockResolvedValue({
      data: {
        user: {
          nickname: "TestUser",
          avatar: { avatar_240: "https://example.com/avatar.png" },
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps monitoring the Feishu websocket after the initial connection", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "gsap",
      onMessage: vi.fn(),
      onStatus,
    });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(500);
    expect(onStatus).toHaveBeenCalledWith("connected");

    const wsClient = latestWsClient();
    wsClient.wsConfig.wsInstance.readyState = 3;
    onStatus.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(onStatus).toHaveBeenCalledWith("error", "WebSocket disconnected");
    adapter.stop();
  });

  it("nudges the Feishu websocket client to restart when health check sees a closed socket", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "gsap",
      onMessage: vi.fn(),
      onStatus,
    });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(500);
    expect(mockWsStart).toHaveBeenCalledTimes(1);

    const wsClient = latestWsClient();
    wsClient.wsConfig.wsInstance.readyState = 3;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockWsStart).toHaveBeenCalledTimes(2);

    wsClient.wsConfig.wsInstance.readyState = 1;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(onStatus).toHaveBeenLastCalledWith("connected");
    adapter.stop();
  });

  it("keeps message_id on inbound image attachments", async () => {
    const onMessage = vi.fn();

    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage,
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_fake_msg_001",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_fake_key_001" }),
        chat_id: "oc_fake_chat_001",
        chat_type: "p2p",
      },
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_123",
          user_id: "ou_123",
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: "feishu",
      sessionKey: "fs_dm_ou_123@hana",
      attachments: [
        expect.objectContaining({
          type: "image",
          platformRef: "img_fake_key_001",
          _messageId: "om_fake_msg_001",
        }),
      ],
    }));
  });

  it("normalizes inbound post rich text into readable text and attachments", async () => {
    const onMessage = vi.fn();

    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "gsap",
      onMessage,
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_post_001",
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                { tag: "text", text: "hello " },
                { tag: "at", user_name: "Ghost" },
                { tag: "a", text: " docs", href: "https://example.com" },
              ],
              [
                { tag: "img", image_key: "img_post_001" },
                { tag: "media", file_key: "file_post_001", file_name: "clip.mp4", duration: 3000 },
              ],
            ],
          },
        }),
        chat_id: "oc_post_chat",
        chat_type: "p2p",
      },
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_post",
          user_id: "ou_post",
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: "feishu",
      sessionKey: "fs_dm_ou_post@gsap",
      text: "hello @Ghost docs",
      attachments: [
        expect.objectContaining({
          type: "image",
          platformRef: "img_post_001",
          _messageId: "om_post_001",
        }),
        expect.objectContaining({
          type: "video",
          platformRef: "file_post_001",
          filename: "clip.mp4",
          duration: 3,
          _messageId: "om_post_001",
        }),
      ],
    }));
  });

  it("keeps media-only post messages by falling back to the first available locale", async () => {
    const onMessage = vi.fn();

    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "gsap",
      onMessage,
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_post_002",
        message_type: "post",
        content: JSON.stringify({
          en_us: {
            content: [[{ tag: "img", image_key: "img_post_002" }]],
          },
        }),
        chat_id: "oc_post_chat",
        chat_type: "group",
      },
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_post",
          user_id: "ou_post",
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "fs_group_oc_post_chat@gsap",
      text: "",
      attachments: [
        expect.objectContaining({
          type: "image",
          platformRef: "img_post_002",
          _messageId: "om_post_002",
        }),
      ],
    }));
  });

  it("reports unsupported post tags as diagnostic text instead of dropping the message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onMessage = vi.fn();

    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "gsap",
      onMessage,
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_unknown_001",
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            content: [[{ tag: "widget", text: "unsupported" }]],
          },
        }),
        chat_id: "oc_post_chat",
        chat_type: "p2p",
      },
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_post",
          user_id: "ou_post",
        },
      },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unsupported Feishu post tag: widget"));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "[Unsupported Feishu post tag: widget]",
    }));
    warn.mockRestore();
  });

  it("downloads inbound images via message resource API", async () => {
    const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockMessageResourceGet.mockResolvedValue({
      getReadableStream: () => Readable.from([imageBuffer]),
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    const buffer = await adapter.downloadImage(
      "img_fake_key_001",
      "om_fake_msg_001",
    );

    expect(buffer).toEqual(imageBuffer);
    expect(mockMessageResourceGet).toHaveBeenCalledWith({
      path: {
        message_id: "om_fake_msg_001",
        file_key: "img_fake_key_001",
      },
      params: { type: "image" },
    });
    expect(mockImageGet).not.toHaveBeenCalled();
  });

  it("downloads self-uploaded images through the SDK stream wrapper", async () => {
    const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockImageGet.mockResolvedValue({
      getReadableStream: () => Readable.from([imageBuffer]),
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    const buffer = await adapter.downloadImage("img_uploaded_key_001");

    expect(buffer).toEqual(imageBuffer);
    expect(mockImageGet).toHaveBeenCalledWith({
      path: { image_key: "img_uploaded_key_001" },
    });
    expect(mockMessageResourceGet).not.toHaveBeenCalled();
  });

  it("uploads image buffers and sends image_key messages", async () => {
    mockImageCreate.mockResolvedValue({ image_key: "img_key_001" });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await adapter.sendMediaBuffer("oc_chat", buffer, {
      mime: "image/png",
      filename: "image.png",
    });

    expect(mockImageCreate).toHaveBeenCalledWith({
      data: { image_type: "message", image: buffer },
    });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "image",
        content: JSON.stringify({ image_key: "img_key_001" }),
      },
    });
  });

  it("sends MP4 buffers as Feishu media messages", async () => {
    mockFileCreate.mockResolvedValue({ file_key: "file_key_mp4" });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const buffer = Buffer.from("mp4");

    await adapter.sendMediaBuffer("oc_chat", buffer, {
      mime: "video/mp4",
      filename: "clip.mp4",
    });

    expect(mockFileCreate).toHaveBeenCalledWith({
      data: {
        file_type: "mp4",
        file_name: "clip.mp4",
        file: buffer,
      },
    });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "media",
        content: JSON.stringify({ file_key: "file_key_mp4" }),
      },
    });
  });

  it("declares Feishu edit-message streaming and updates the same post markdown message", async () => {
    mockMessageCreate.mockResolvedValue({ data: { message_id: "om_stream_001" } });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "gsap",
      onMessage: vi.fn(),
    });

    expect(adapter.streamingCapabilities).toMatchObject({
      platform: "feishu",
      mode: "edit_message",
      renderer: "post",
      receiptMode: "fold_into_stream",
    });

    const state = await adapter.startStreamReply("oc_chat", "hello");
    await adapter.updateStreamReply("oc_chat", state, "hello world");
    await adapter.finishStreamReply("oc_chat", state, "done");

    expect(state).toEqual({ messageId: "om_stream_001", updatable: true });
    expect(mockMessageUpdate).toHaveBeenCalledTimes(2);
    expect(mockMessageUpdate).toHaveBeenCalledWith({
      path: { message_id: "om_stream_001" },
      data: {
        msg_type: "post",
        content: expect.stringContaining("hello world"),
      },
    });
  });

  it("marks created Feishu stream messages without message_id as non-updatable instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockMessageCreate.mockResolvedValue({ data: {} });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "gsap",
      onMessage: vi.fn(),
    });

    const state = await adapter.startStreamReply("oc_chat", "hello");
    await adapter.updateStreamReply("oc_chat", state, "ignored");
    await adapter.finishStreamReply("oc_chat", state, "ignored");

    expect(state).toEqual({ messageId: null, updatable: false });
    expect(mockMessageUpdate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("message_id"));
    warn.mockRestore();
  });

  it("rejects upload responses without an image_key", async () => {
    mockImageCreate.mockResolvedValue({});
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(adapter.sendMediaBuffer("oc_chat", Buffer.from("png"), {
      mime: "image/png",
      filename: "image.png",
    })).rejects.toThrow(/image_key/);

    expect(mockMessageCreate).not.toHaveBeenCalled();
  });
});
