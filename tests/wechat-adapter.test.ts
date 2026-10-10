// @ts-nocheck
import os from "os";
import path from "path";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  decodeIlinkMediaAesKey,
  encodeIlinkMediaAesKey,
} from "../lib/bridge/wechat-ilink-media-crypto.js";
import { createWechatAdapter } from "../lib/bridge/wechat-adapter.js";

function jsonResponse(body) {
  return {
    ok: true,
    text: async () => JSON.stringify(body),
  };
}

function cdnUploadResponse(downloadParam = "download-param") {
  return {
    ok: true,
    headers: new Headers({ "x-encrypted-param": downloadParam }),
  };
}

describe("createWechatAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports session_expired when getupdates returns a business error payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ret: -14, errcode: -14, errmsg: "session expired" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const statuses = [];
    const adapter = createWechatAdapter({
      botToken: "test-token",
      codiaHome: path.join(os.tmpdir(), "codia-wechat-test"),
      agentId: "codia",
      onMessage: vi.fn(),
      onStatus: (status, error) => statuses.push({ status, error }),
    });

    await vi.waitFor(() => {
      expect(statuses.some((entry) => entry.status === "error" && entry.error === "session_expired")).toBe(true);
    });

    adapter.stop();
  });

  it("encodes outbound media aes keys as base64 hex strings and still decodes legacy raw-key base64", () => {
    const aesKeyHex = "00112233445566778899aabbccddeeff";
    const wireKey = encodeIlinkMediaAesKey(aesKeyHex);

    expect(Buffer.from(wireKey, "base64").toString("ascii")).toBe(aesKeyHex);
    expect(decodeIlinkMediaAesKey(wireKey).toString("hex")).toBe(aesKeyHex);

    const legacyRawWireKey = Buffer.from(aesKeyHex, "hex").toString("base64");
    expect(decodeIlinkMediaAesKey(legacyRawWireKey).toString("hex")).toBe(aesKeyHex);
  });

  it("uploads image buffers with iLink-compatible media aes_key encoding", async () => {
    let getUpdatesCount = 0;
    const fetchMock = vi.fn(async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl.includes("ilink/bot/getupdates")) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ret: 0,
            get_updates_buf: "buf-1",
            msgs: [{
              from_user_id: "user-1",
              context_token: "ctx-1",
              item_list: [{ type: 1, text_item: { text: "hi" } }],
            }],
          });
        }
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (requestUrl.includes("ilink/bot/getuploadurl")) {
        return jsonResponse({ ret: 0, upload_param: "upload-param" });
      }
      if (requestUrl.includes("/c2c/upload")) {
        return cdnUploadResponse();
      }
      if (requestUrl.includes("ilink/bot/sendmessage")) {
        return jsonResponse({ ret: 0 });
      }
      throw new Error(`unexpected fetch: ${requestUrl} ${options.method || "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onMessage = vi.fn();
    const adapter = createWechatAdapter({
      botToken: "wx-token",
      agentId: "codia",
      onMessage,
      onStatus: vi.fn(),
    });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(adapter.canReply("user-1")).toBe(true);

    await adapter.sendMediaBuffer("user-1", Buffer.from("file"), {
      mime: "image/png",
      filename: "image.png",
    });

    const sendMessageCall = fetchMock.mock.calls.find(([url]) => String(url).includes("ilink/bot/sendmessage"));
    expect(sendMessageCall).toBeTruthy();
    const payload = JSON.parse(sendMessageCall[1].body);
    const item = payload.msg.item_list[0];
    expect(payload.msg.context_token).toBe("ctx-1");
    expect(item.type).toBe(2);
    const media = item.image_item.media;
    expect(Buffer.from(media.aes_key, "base64").toString("ascii")).toMatch(/^[0-9a-f]{32}$/);
    expect(decodeIlinkMediaAesKey(media.aes_key)).toHaveLength(16);

    adapter.stop();
  });

  it("declares and cancels native typing status through the iLink typing ticket", async () => {
    let getUpdatesCount = 0;
    const fetchMock = vi.fn(async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl.includes("ilink/bot/getupdates")) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ret: 0,
            get_updates_buf: "buf-1",
            msgs: [{
              from_user_id: "user-1",
              context_token: "ctx-1",
              item_list: [{ type: 1, text_item: { text: "hi" } }],
            }],
          });
        }
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (requestUrl.includes("ilink/bot/getconfig")) {
        return jsonResponse({ ret: 0, typing_ticket: "ticket-1" });
      }
      if (requestUrl.includes("ilink/bot/sendtyping")) {
        return jsonResponse({ ret: 0 });
      }
      throw new Error(`unexpected fetch: ${requestUrl} ${options.method || "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onMessage = vi.fn();
    const adapter = createWechatAdapter({
      botToken: "wx-token",
      agentId: "codia",
      onMessage,
      onStatus: vi.fn(),
    });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(adapter.receiptCapabilities).toMatchObject({
      platform: "wechat",
      mode: "native_typing",
      scopes: ["dm"],
      cancellable: true,
    });

    await adapter.sendTypingIndicator("user-1");
    await adapter.cancelTypingIndicator("user-1");

    const sendTypingCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("ilink/bot/sendtyping"));
    expect(sendTypingCalls).toHaveLength(2);
    const startPayload = JSON.parse(sendTypingCalls[0][1].body);
    const cancelPayload = JSON.parse(sendTypingCalls[1][1].body);
    expect(startPayload).toMatchObject({
      ilink_user_id: "user-1",
      typing_ticket: "ticket-1",
      status: 1,
    });
    expect(cancelPayload).toMatchObject({
      ilink_user_id: "user-1",
      typing_ticket: "ticket-1",
      status: 2,
    });

    adapter.stop();
  });
});
