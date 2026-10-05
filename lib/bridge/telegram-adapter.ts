// @ts-nocheck
/**
  *
 * 使用原生 Telegram Bot API 客户端监听消息，
  * */

import TelegramBot from "./telegram-client.ts";
import { debugLog } from "../debug-log.ts";
import { createMediaCapabilities } from "./media-capabilities.ts";
import { createStreamingCapabilities } from "./streaming-capabilities.ts";
import { createReceiptCapabilities } from "./receipt-capabilities.ts";
import { formatTelegramMessageChunks } from "./telegram-format.ts";

const MAX_MSG_SIZE = 100_000; // 100KB
export const TELEGRAM_ADAPTER_VERSION = "telegram-bot-api";

export const TELEGRAM_MEDIA_CAPABILITIES = createMediaCapabilities({
  platform: "telegram",
  inputModes: ["buffer", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"],
  requiresReplyContext: false,
  deliveryByKind: {
    image: "native_image",
    video: "native_video",
    audio: "native_audio",
    document: "native_document",
  },
  maxBytes: {
    buffer: {
      image: 10 * 1024 * 1024,
      video: 50 * 1024 * 1024,
      audio: 50 * 1024 * 1024,
      document: 50 * 1024 * 1024,
    },
    remote_url: {
      image: 5 * 1024 * 1024,
      video: 20 * 1024 * 1024,
      audio: 20 * 1024 * 1024,
      document: 20 * 1024 * 1024,
    },
  },
  source: ".docs/BRIDGE-MEDIA-CAPABILITIES.md#telegram",
});

export const TELEGRAM_STREAMING_CAPABILITIES = createStreamingCapabilities({
  platform: "telegram",
  mode: "draft",
  scopes: ["dm"],
  minIntervalMs: 500,
  maxChars: 4096,
  source: "https://core.telegram.org/bots/api#sendmessagedraft",
});

export const TELEGRAM_RECEIPT_CAPABILITIES = createReceiptCapabilities({
  platform: "telegram",
  mode: "native_typing",
  scopes: ["dm", "group"],
  refreshIntervalMs: 4000,
  source: "https://core.telegram.org/bots/api#sendchataction",
});

/** */
function safeExtFromUrl(url) {
  try { return new URL(url).pathname.split(".").pop()?.toLowerCase() || ""; }
  catch { return ""; }
}

function telegramMessageOptions(options = {}) {
  const messageThreadId = options.messageThreadId || options.replyContext?.messageThreadId;
  return messageThreadId ? { message_thread_id: messageThreadId } : {};
}

function telegramTextOptions(options = {}) {
  return { parse_mode: "HTML", ...telegramMessageOptions(options) };
}

/**
 * @param {object} opts
  *
  *
 * @returns {{ sendReply, stop, getMe }}
 */
export function createTelegramAdapter({ token, agentId, onMessage, onStatus }) {
  let bot = new TelegramBot(token, { polling: true });
  let stopped = false;
  let consecutiveErrors = 0;
  let restartTimer = null;

  function attachListeners(b) {
    b.on("message", async (msg) => {
      const text = msg.text || msg.caption || "";
      consecutiveErrors = 0;

 //
      const attachments = [];
      if (msg.photo?.length) {
        try {
          const best = msg.photo[msg.photo.length - 1];
          const url = await bot.getFileLink(best.file_id);
          attachments.push({ type: "image", url, mimeType: "image/jpeg",
            width: best.width, height: best.height, platformRef: best.file_id });
        } catch (err) {
          debugLog()?.warn("bridge", `[telegram] failed to extract photo: ${err.message}`);
        }
      }
      if (msg.document) {
        try {
          const url = await bot.getFileLink(msg.document.file_id);
          attachments.push({ type: "file", url, filename: msg.document.file_name,
            mimeType: msg.document.mime_type, size: msg.document.file_size,
            platformRef: msg.document.file_id });
        } catch (err) {
          debugLog()?.warn("bridge", `[telegram] failed to extract document: ${err.message}`);
        }
      }
      if (msg.voice) {
        try {
          const url = await bot.getFileLink(msg.voice.file_id);
          attachments.push({ type: "audio", url, mimeType: msg.voice.mime_type,
            duration: msg.voice.duration, platformRef: msg.voice.file_id });
        } catch (err) {
          debugLog()?.warn("bridge", `[telegram] failed to extract voice: ${err.message}`);
        }
      }
      if (msg.video) {
        try {
          const url = await bot.getFileLink(msg.video.file_id);
          attachments.push({ type: "video", url, filename: msg.video.file_name,
            mimeType: msg.video.mime_type, duration: msg.video.duration,
            platformRef: msg.video.file_id });
        } catch (err) {
          debugLog()?.warn("bridge", `[telegram] failed to extract video: ${err.message}`);
        }
      }

      if (!text && !attachments.length) return;

      const trimmed = text.length > MAX_MSG_SIZE
        ? (console.warn(`[telegram] message too large (${text.length} chars), truncated`), text.slice(0, MAX_MSG_SIZE))
        : text;

      const chatId = String(msg.chat.id);
      const userId = String(msg.from.id);
      const chatType = msg.chat.type; // "private" | "group" | "supergroup" | "channel"
      const isGroup = chatType !== "private";
      const sessionKey = isGroup ? `tg_group_${chatId}@${agentId}` : `tg_dm_${userId}@${agentId}`;

      onMessage({
        platform: "telegram",
        agentId,
        chatId,
        userId,
        sessionKey,
        text: trimmed,
        senderName: msg.from.first_name || "User",
        isGroup,
        messageThreadId: msg.message_thread_id,
        attachments: attachments.length ? attachments : undefined,
      });
    });

    b.on("polling_error", (err) => {
      consecutiveErrors++;
      const errMsg = err.message || String(err);
      console.error("[telegram] polling error:", errMsg);
      debugLog()?.error("bridge", `telegram polling error (${consecutiveErrors}): ${errMsg}`);

 // 连续错误超过 3 次且没有 pending restart，尝试重-polling
      if (consecutiveErrors >= 3 && !stopped && !restartTimer) {
        debugLog()?.warn("bridge", `telegram polling failed ${consecutiveErrors}x, restarting...`);
        scheduleRestart();
      }
    });
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    const delay = Math.min(5000 * consecutiveErrors, 30_000);
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (stopped) return;
      const oldBot = bot;
      try {
        oldBot.removeAllListeners();
        await oldBot.stopPolling();
      } catch (e) {
        debugLog()?.warn("bridge", `telegram old bot cleanup: ${e.message}`);
      }
      try {
        bot = new TelegramBot(token, { polling: true });
        attachListeners(bot);
        consecutiveErrors = 0;
        debugLog()?.log("bridge", "telegram polling restarted");
        onStatus?.("connected");
      } catch (err) {
        debugLog()?.error("bridge", `telegram restart failed: ${err.message}`);
        onStatus?.("error", err.message);
      }
    }, delay);
  }

  attachListeners(bot);

 /** */
  let lastBlockTs = 0;

  return {
    mediaCapabilities: TELEGRAM_MEDIA_CAPABILITIES,
    streamingCapabilities: TELEGRAM_STREAMING_CAPABILITIES,
    receiptCapabilities: TELEGRAM_RECEIPT_CAPABILITIES,

    getStatus() {
      return { adapterVersion: TELEGRAM_ADAPTER_VERSION };
    },

    async sendTypingIndicator(chatId) {
      try { await bot.sendChatAction(chatId, "typing"); } catch {}
    },

    async sendReply(chatId, text, options = {}) {
 // Telegram 单条消息限制 4096 字符，超长时分段发-
      const chunks = formatTelegramMessageChunks(text);
      const sendOptions = telegramTextOptions(options);
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, sendOptions);
      }
    },

 /** */
    async sendBlockReply(chatId, text, options = {}) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200; // 800~2000ms
      if (lastBlockTs && elapsed < delay) {
        await new Promise(r => setTimeout(r, delay - elapsed));
      }
      const chunks = formatTelegramMessageChunks(text);
      const sendOptions = telegramTextOptions(options);
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, sendOptions);
      }
      lastBlockTs = Date.now();
    },

 /** */
    async sendDraft(chatId, text, options = {}) {
      const draftId = Number(options.draftId);
      if (!Number.isInteger(draftId) || draftId === 0) {
        throw new Error("Telegram sendDraft requires a non-zero integer draftId");
      }
      const form = { chat_id: chatId, draft_id: draftId, text };
      if (options.messageThreadId) form.message_thread_id = options.messageThreadId;
      return bot._request("sendMessageDraft", { form });
    },

 /** */
    async sendMedia(chatId, url, options = {}) {
      const ext = safeExtFromUrl(url);
      const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
      const videoExts = ["mp4", "mov", "avi", "mkv"];
      const audioExts = ["mp3", "ogg", "wav", "m4a", "opus"];
      const sendOptions = telegramMessageOptions(options);
      try {
        if (imageExts.includes(ext)) await bot.sendPhoto(chatId, url, sendOptions);
        else if (videoExts.includes(ext)) await bot.sendVideo(chatId, url, sendOptions);
        else if (audioExts.includes(ext)) await bot.sendAudio(chatId, url, sendOptions);
        else await bot.sendDocument(chatId, url, sendOptions);
      } catch (err) {
        debugLog()?.warn("bridge", `[telegram] sendMedia failed (${ext}): ${err.message}`);
        throw err;
      }
    },

 /** */
    async sendMediaBuffer(chatId, buffer, { mime, filename, replyContext } = {}) {
      try {
        const opts = { filename, contentType: mime };
        const sendOptions = telegramMessageOptions({ replyContext });
        if (mime.startsWith("image/")) await bot.sendPhoto(chatId, buffer, sendOptions, opts);
        else if (mime.startsWith("video/")) await bot.sendVideo(chatId, buffer, sendOptions, opts);
        else if (mime.startsWith("audio/")) await bot.sendAudio(chatId, buffer, sendOptions, opts);
        else await bot.sendDocument(chatId, buffer, sendOptions, opts);
      } catch (err) {
        debugLog()?.warn("bridge", `[telegram] sendMediaBuffer failed (${mime}): ${err.message}`);
        throw err;
      }
    },

    stop() {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      bot.removeAllListeners();
      bot.stopPolling();
    },

 /** */
    async getMe() {
      return bot.getMe();
    },
  };
}
