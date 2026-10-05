// @ts-nocheck
import { EventEmitter } from "node:events";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const LONG_POLL_TIMEOUT_SECONDS = 25;
const POLL_RETRY_DELAY_MS = 2000;

function toError(data, response) {
  const description = data?.description || response?.statusText || "Telegram API request failed";
  const error = new Error(description);
  error.code = data?.error_code || response?.status || null;
  return error;
}

function isBinaryPayload(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function asBlob(value, contentType) {
  if (value instanceof ArrayBuffer) return new Blob([value], { type: contentType });
  if (value instanceof Uint8Array) return new Blob([value], { type: contentType });
  return new Blob([value], { type: contentType });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramBotClient extends EventEmitter {
  constructor(token, options = {}) {
    super();
    if (!token || typeof token !== "string") {
      throw new Error("Telegram bot token is required");
    }
    this.token = token;
    this._polling = false;
    this._offset = 0;
    this._abort = null;

    if (options.polling) {
      this.startPolling();
    }
  }

  _apiUrl(method) {
    return `${TELEGRAM_API_BASE}/bot${this.token}/${method}`;
  }

  async _request(method, options = {}) {
    return this._requestJson(method, options.form || options.body || {});
  }

  async _requestJson(method, payload = {}, requestOptions = {}) {
    const response = await fetch(this._apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: requestOptions.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) throw toError(data, response);
    return data.result;
  }

  async _requestMultipart(method, fields, mediaField, media, fileOptions = {}) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields || {})) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }

    const contentType = fileOptions.contentType || "application/octet-stream";
    const filename = fileOptions.filename || "upload.bin";
    form.append(mediaField, asBlob(media, contentType), filename);

    const response = await fetch(this._apiUrl(method), {
      method: "POST",
      body: form,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) throw toError(data, response);
    return data.result;
  }

  startPolling() {
    if (this._polling) return;
    this._polling = true;
    this._pollLoop().catch((err) => {
      if (this._polling) this.emit("polling_error", err);
    });
  }

  async stopPolling() {
    this._polling = false;
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }
  }

  async _pollLoop() {
    while (this._polling) {
      const controller = new AbortController();
      this._abort = controller;

      try {
        const updates = await this._requestJson("getUpdates", {
          offset: this._offset || undefined,
          timeout: LONG_POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message"],
        }, { signal: controller.signal });

        if (!this._polling) break;
        for (const update of updates || []) {
          this._offset = Math.max(this._offset, Number(update.update_id || 0) + 1);
          if (update.message) this.emit("message", update.message);
        }
      } catch (err) {
        if (!this._polling || err?.name === "AbortError") break;
        this.emit("polling_error", err);
        await sleep(POLL_RETRY_DELAY_MS);
      } finally {
        if (this._abort === controller) this._abort = null;
      }
    }
  }

  async getMe() {
    return this._requestJson("getMe");
  }

  async getFile(fileId) {
    return this._requestJson("getFile", { file_id: fileId });
  }

  async getFileLink(fileId) {
    const file = await this.getFile(fileId);
    if (!file?.file_path) throw new Error("Telegram file_path missing");
    return `${TELEGRAM_API_BASE}/file/bot${this.token}/${file.file_path}`;
  }

  async sendChatAction(chatId, action) {
    return this._requestJson("sendChatAction", { chat_id: chatId, action });
  }

  async sendMessage(chatId, text, options = {}) {
    return this._requestJson("sendMessage", { chat_id: chatId, text, ...options });
  }

  async sendPhoto(chatId, media, options = {}, fileOptions = {}) {
    return this._sendMedia("sendPhoto", "photo", chatId, media, options, fileOptions);
  }

  async sendVideo(chatId, media, options = {}, fileOptions = {}) {
    return this._sendMedia("sendVideo", "video", chatId, media, options, fileOptions);
  }

  async sendAudio(chatId, media, options = {}, fileOptions = {}) {
    return this._sendMedia("sendAudio", "audio", chatId, media, options, fileOptions);
  }

  async sendDocument(chatId, media, options = {}, fileOptions = {}) {
    return this._sendMedia("sendDocument", "document", chatId, media, options, fileOptions);
  }

  async _sendMedia(method, mediaField, chatId, media, options = {}, fileOptions = {}) {
    if (typeof media === "string") {
      return this._requestJson(method, { chat_id: chatId, [mediaField]: media, ...options });
    }
    if (!isBinaryPayload(media)) {
      throw new Error(`Unsupported Telegram ${mediaField} payload`);
    }
    return this._requestMultipart(method, { chat_id: chatId, ...options }, mediaField, media, fileOptions);
  }
}

export default TelegramBotClient;
