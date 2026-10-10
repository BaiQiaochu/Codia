// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

const botInstances = vi.hoisted(() => []);

vi.mock("../lib/bridge/telegram-client.js", () => {
  class MockTelegramBot {
    constructor() {
      this.on = vi.fn();
      this.removeAllListeners = vi.fn();
      this.stopPolling = vi.fn();
      this.sendMessage = vi.fn(async () => {});
      this.sendPhoto = vi.fn(async () => {});
      this.sendVideo = vi.fn(async () => {});
      this.sendAudio = vi.fn(async () => {});
      this.sendDocument = vi.fn(async () => {});
      this._request = vi.fn(async () => {});
      this.getMe = vi.fn(async () => ({ username: "codia" }));
      botInstances.push(this);
    }
  }

  return { default: MockTelegramBot };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
}));

import { createTelegramAdapter } from "../lib/bridge/telegram-adapter.js";

describe("createTelegramAdapter Telegram formatting", () => {
  beforeEach(() => {
    botInstances.length = 0;
  });

  function makeAdapter() {
    const adapter = createTelegramAdapter({
      token: "tg-token",
      agentId: "codia",
      onMessage: vi.fn(),
    });
    return { adapter, bot: botInstances[0] };
  }

  it("renders common Markdown replies as Telegram HTML at the adapter boundary", async () => {
    const { adapter, bot } = makeAdapter();

    await adapter.sendReply("chat-1", "**bold** and `code`");
    await adapter.sendBlockReply("chat-1", "- first\n- second");

    expect(bot.sendMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      "<b>bold</b> and <code>code</code>",
      { parse_mode: "HTML" },
    );
    expect(bot.sendMessage).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      "- first\n- second",
      { parse_mode: "HTML" },
    );
    adapter.stop();
  });

  it("keeps Telegram replies and media inside the inbound forum topic", async () => {
    const { adapter, bot } = makeAdapter();
    const png = Buffer.from("png");

    await adapter.sendReply("chat-1", "hello", { messageThreadId: 67890 });
    await adapter.sendBlockReply("chat-1", "block", { messageThreadId: 67890 });
    await adapter.sendMedia("chat-1", "https://example.com/image.png", {
      replyContext: { messageThreadId: 67890 },
    });
    await adapter.sendMediaBuffer("chat-1", png, {
      mime: "image/png",
      filename: "image.png",
      replyContext: { messageThreadId: 67890 },
    });

    expect(bot.sendMessage).toHaveBeenNthCalledWith(1, "chat-1", "hello", {
      parse_mode: "HTML",
      message_thread_id: 67890,
    });
    expect(bot.sendMessage).toHaveBeenNthCalledWith(2, "chat-1", "block", {
      parse_mode: "HTML",
      message_thread_id: 67890,
    });
    expect(bot.sendPhoto).toHaveBeenNthCalledWith(1, "chat-1", "https://example.com/image.png", {
      message_thread_id: 67890,
    });
    expect(bot.sendPhoto).toHaveBeenNthCalledWith(2, "chat-1", png, {
      message_thread_id: 67890,
    }, { filename: "image.png", contentType: "image/png" });
    adapter.stop();
  });
});
