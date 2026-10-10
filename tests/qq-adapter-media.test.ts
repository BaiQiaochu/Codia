// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ws", () => {
  class MockWebSocket {
    static OPEN = 1;
    readyState = 0;
    on() {}
    send() {}
    close() {}
  }
  return { default: MockWebSocket };
});

const mockFetch = vi.fn();

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetch: (...args) => mockFetch(...args),
  };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
}));

import { createQQAdapter } from "../lib/bridge/qq-adapter.js";

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe("createQQAdapter markdown replies", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes("/app/getAppAccessToken")) {
        return jsonResponse({ access_token: "qq-token", expires_in: 7200 });
      }
      if (href.endsWith("/gateway")) {
        return jsonResponse({ url: "ws://localhost/qq" });
      }
      if (href.includes("/files")) {
        return jsonResponse({ file_uuid: "file-uuid", file_info: "file-info", ttl: 3600 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends group replies as markdown passive replies with increasing msg_seq", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "codia",
      onMessage: vi.fn(),
    });

    await adapter.sendReply("group-openid", "first", {
      messageId: "qq-mid-1",
      targetType: "group",
      isGroup: true,
    });
    await adapter.sendReply("group-openid", "second", {
      messageId: "qq-mid-1",
      targetType: "group",
      isGroup: true,
    });

    const messageCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(messageCalls).toHaveLength(2);
    expect(JSON.parse(messageCalls[0][1].body)).toMatchObject({
      content: " ",
      msg_type: 2,
      markdown: { content: "first" },
      msg_id: "qq-mid-1",
      msg_seq: 1,
    });
    expect(JSON.parse(messageCalls[1][1].body)).toMatchObject({
      content: " ",
      msg_type: 2,
      markdown: { content: "second" },
      msg_id: "qq-mid-1",
      msg_seq: 2,
    });
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/v2/users/group-openid/messages"))).toBe(false);
    adapter.stop();
  });

  it("sends C2C replies as official markdown messages", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "codia",
      onMessage: vi.fn(),
    });

    await adapter.sendReply("user-openid", "**bold**\n- item", {
      messageId: "qq-dm-1",
      targetType: "user",
      isGroup: false,
    });

    const messageCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/v2/users/user-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      content: " ",
      msg_type: 2,
      markdown: { content: "**bold**\n- item" },
      msg_id: "qq-dm-1",
      msg_seq: 1,
    });
    adapter.stop();
  });

  it("sends legacy QQ channel replies with channel markdown body", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "codia",
      onMessage: vi.fn(),
    });

    await adapter.sendReply("channel-id", "# Title", {
      messageId: "qq-channel-mid-1",
      targetType: "channel",
      isGroup: true,
    });

    const messageCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/channels/channel-id/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      markdown: { content: "# Title" },
      msg_id: "qq-channel-mid-1",
      msg_seq: 1,
    });
    expect(JSON.parse(messageCall[1].body)).not.toHaveProperty("msg_type");
    adapter.stop();
  });

  it("sends QQ rich media replies with passive reply context", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "codia",
      onMessage: vi.fn(),
    });

    await adapter.sendMedia("group-openid", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
      replyContext: {
        messageId: "qq-mid-1",
        targetType: "group",
      },
    });

    const messageCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
      msg_id: "qq-mid-1",
      msg_seq: 1,
    });
    adapter.stop();
  });
});
