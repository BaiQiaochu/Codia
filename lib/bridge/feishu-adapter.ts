// @ts-nocheck
/**
  *
  * */

import * as lark from "@larksuiteoapi/node-sdk";
import { debugLog } from "../debug-log.ts";
import { downloadMedia, detectMime, formatSize, streamToBuffer } from "./media-utils.ts";
import { createMediaCapabilities } from "./media-capabilities.ts";
import { createStreamingCapabilities } from "./streaming-capabilities.ts";

export const FEISHU_ADAPTER_VERSION = "feishu-bot-ws";

export const FEISHU_MEDIA_CAPABILITIES = createMediaCapabilities({
  platform: "feishu",
  inputModes: ["buffer", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"],
  requiresReplyContext: false,
  deliveryByKind: {
    image: "native_image",
    video: "native_file",
    audio: "native_file",
    document: "native_file",
  },
  maxBytes: {
    buffer: {
      image: 10 * 1024 * 1024,
      video: 30 * 1024 * 1024,
      audio: 30 * 1024 * 1024,
      document: 30 * 1024 * 1024,
    },
  },
  source: ".docs/BRIDGE-MEDIA-CAPABILITIES.md#feishu",
});

export const FEISHU_STREAMING_CAPABILITIES = createStreamingCapabilities({
  platform: "feishu",
  mode: "edit_message",
  scopes: ["dm"],
  minIntervalMs: 500,
  maxChars: 150_000,
  source: "https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/update",
});

const FEISHU_WS_OPEN = 1;
const FEISHU_WS_HEALTH_INTERVAL_MS = 30_000;
const FEISHU_WS_DISCONNECTED_ERROR = "WebSocket disconnected";
const FEISHU_AT_TOKEN_RE = /<at\s+user_id=(["'])([^"']+)\1\s*>([\s\S]*?)<\/at>/gi;

function unrefTimer(timer) {
  if (typeof timer?.unref === "function") timer.unref();
  return timer;
}

function renderFeishuPostParagraph(text) {
  const parts = [];
  let cursor = 0;
  FEISHU_AT_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = FEISHU_AT_TOKEN_RE.exec(text)) !== null) {
    const before = text.slice(cursor, match.index);
    if (before) parts.push({ tag: "md", text: before });
    const userId = match[2].trim();
    const userName = match[3].trim() || userId;
    if (userId) parts.push({ tag: "at", user_id: userId, user_name: userName });
    cursor = match.index + match[0].length;
  }
  const tail = text.slice(cursor);
  if (tail || parts.length === 0) parts.push({ tag: "md", text: tail });
  return parts;
}

function markdownPostMessageContent(text) {
  const paragraphs = String(text || "")
    .split(/\r?\n/)
    .map(renderFeishuPostParagraph);
  return JSON.stringify({
    zh_cn: {
      content: paragraphs,
    },
  });
}

function isSelfFeishuBotSender(sender, appId) {
  const senderType = sender?.sender_type;
  if (senderType !== "bot" && senderType !== "app") return false;
  return Boolean(appId && sender?.sender_id?.app_id === appId);
}

function isFeishuBotSender(sender) {
  return sender?.sender_type === "bot" || sender?.sender_type === "app";
}

function extractFeishuMessageId(res) {
  const candidates = [
    res?.data?.message_id,
    res?.message_id,
    res?.data?.message?.message_id,
    res?.message?.message_id,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function describeFeishuError(err) {
  const data = err?.response?.data || err?.data || err?.body || null;
  if (data && typeof data === "object") {
    const parts = [];
    if (data.code !== undefined) parts.push(`code=${data.code}`);
    if (data.msg) parts.push(`msg=${data.msg}`);
    const logId = data.error?.log_id || data.log_id;
    if (logId) parts.push(`log_id=${logId}`);
    if (parts.length) return parts.join(", ");
  }
  return err?.message || String(err);
}

function wrapFeishuError(label, err) {
  const wrapped = new Error(`Feishu ${label} failed: ${describeFeishuError(err)}`);
  wrapped.cause = err;
  return wrapped;
}

async function callFeishu(label, fn) {
  try {
    return await fn();
  } catch (err) {
    throw wrapFeishuError(label, err);
  }
}

function assertUploadBuffer(buffer, label, maxBytes) {
  if (!buffer || typeof buffer.length !== "number") {
    throw new Error(`Feishu ${label} upload failed: media content must be a Buffer`);
  }
  if (buffer.length === 0) {
    throw new Error(`Feishu ${label} upload failed: file size cannot be 0`);
  }
  if (Number.isFinite(maxBytes) && buffer.length > maxBytes) {
    throw new Error(`Feishu ${label} upload failed: file size ${formatSize(buffer.length)} exceeds ${formatSize(maxBytes)}`);
  }
}

function requireUploadKey(res, key, label) {
  const value = res?.[key] || res?.data?.[key];
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`Feishu ${label} upload failed: missing ${key}`);
}

function feishuFileDelivery({ mime = "", filename = "" } = {}) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const lowerMime = String(mime || "").toLowerCase();
  if (ext === "mp4" || lowerMime === "video/mp4") {
    return { fileType: "mp4", msgType: "media" };
  }
  if (ext === "opus" || lowerMime === "audio/opus") {
    return { fileType: "opus", msgType: "audio" };
  }
  const fileType = { pdf: "pdf", doc: "doc", docx: "doc", xls: "xls",
    xlsx: "xls", ppt: "ppt", pptx: "ppt" }[ext] || "stream";
  return { fileType, msgType: "file" };
}

function fileMessageContent(msgType, fileKey, metadata = {}) {
  const content = { file_key: fileKey };
  if (msgType === "media") {
    const imageKey = metadata.imageKey || metadata.image_key;
    if (imageKey) content.image_key = imageKey;
  }
  return content;
}

function parseFeishuMessageContent(message) {
  if (message?.content && typeof message.content === "object") return message.content;
  try {
    return JSON.parse(message?.content || "{}");
  } catch (err) {
    throw new Error(`Invalid Feishu ${message?.message_type || "unknown"} content JSON: ${err.message}`);
  }
}

function warnFeishuInbound(message) {
  console.warn(`[feishu] ${message}`);
  debugLog()?.warn("bridge", message);
}

function diagnosticText(message) {
  return `[${message}]`;
}

function normalizePostAtText(item) {
  const id = item.user_name || item.name || item.user_id || item.open_id || item.id || "";
  return id ? `@${id}` : "@unknown";
}

function normalizeFeishuPost(message, content) {
  const attachments = [];
  const diagnostics = [];
  const localePayload = content?.zh_cn
    || content?.en_us
    || Object.values(content || {}).find(value => value && typeof value === "object" && Array.isArray(value.content))
    || (Array.isArray(content?.content) ? content : null);
  if (!localePayload) {
    const detail = "Unsupported Feishu post content: missing locale content";
    warnFeishuInbound(detail);
    return { text: diagnosticText(detail), attachments };
  }

  const paragraphs = Array.isArray(localePayload.content) ? localePayload.content : [];
  const lines = [];

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    let line = "";
    for (const item of paragraph) {
      const tag = item?.tag || item?.type;
      if (tag === "text" || tag === "md") {
        line += item.text || "";
      } else if (tag === "a") {
        line += item.text || item.href || "";
      } else if (tag === "at") {
        line += normalizePostAtText(item);
      } else if (tag === "img" || tag === "image") {
        const imageKey = item.image_key || item.imageKey;
        if (imageKey) {
          attachments.push({
            type: "image",
            platformRef: imageKey,
            mimeType: "image/jpeg",
            _messageId: message.message_id,
          });
        } else {
          diagnostics.push("Unsupported Feishu post img: missing image_key");
        }
      } else if (tag === "media") {
        const fileKey = item.file_key || item.fileKey;
        if (fileKey) {
          attachments.push({
            type: "video",
            platformRef: fileKey,
            filename: item.file_name || item.fileName,
            duration: item.duration ? item.duration / 1000 : undefined,
            _messageId: message.message_id,
          });
        } else {
          diagnostics.push("Unsupported Feishu post media: missing file_key");
        }
      } else {
        diagnostics.push(`Unsupported Feishu post tag: ${tag || "unknown"}`);
      }
    }
    if (line) lines.push(line);
  }

  for (const detail of diagnostics) warnFeishuInbound(detail);
  const textParts = [...lines, ...diagnostics.map(diagnosticText)];
  return { text: textParts.join("\n"), attachments };
}

function normalizeFeishuInboundMessage(message) {
  let content;
  try {
    content = parseFeishuMessageContent(message);
  } catch (err) {
    warnFeishuInbound(err.message);
    return { text: diagnosticText(err.message), attachments: [] };
  }

  if (message.message_type === "text") {
    return { text: content.text || "", attachments: [] };
  }
  if (message.message_type === "post") {
    return normalizeFeishuPost(message, content);
  }
  if (message.message_type === "image") {
    return {
      text: "",
      attachments: [{
        type: "image",
        platformRef: content.image_key,
        mimeType: "image/jpeg",
        _messageId: message.message_id,
      }].filter(att => att.platformRef),
    };
  }
  if (message.message_type === "file") {
    return {
      text: "",
      attachments: [{
        type: "file",
        platformRef: content.file_key,
        filename: content.file_name,
        _messageId: message.message_id,
      }].filter(att => att.platformRef),
    };
  }
  if (message.message_type === "audio") {
    return {
      text: "",
      attachments: [{
        type: "audio",
        platformRef: content.file_key,
        duration: content.duration ? content.duration / 1000 : undefined,
        _messageId: message.message_id,
      }].filter(att => att.platformRef),
    };
  }
  if (message.message_type === "media") {
    return {
      text: "",
      attachments: [{
        type: "video",
        platformRef: content.file_key,
        filename: content.file_name,
        duration: content.duration ? content.duration / 1000 : undefined,
        _messageId: message.message_id,
      }].filter(att => att.platformRef),
    };
  }

  const detail = `Unsupported Feishu message type: ${message.message_type || "unknown"}`;
  warnFeishuInbound(detail);
  return { text: diagnosticText(detail), attachments: [] };
}

async function bufferFromFeishuDownload(resp, label) {
  let stream;
  try {
    stream = resp?.getReadableStream ? resp.getReadableStream() : resp;
  } catch (err) {
    throw wrapFeishuError(label, err);
  }
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw new Error(`Feishu ${label} failed: SDK did not return a readable stream`);
  }
  try {
    return await streamToBuffer(stream);
  } catch (err) {
    throw wrapFeishuError(label, err);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.appId - 椋炰功 App ID
 * @param {string} opts.appSecret - 椋炰功 App Secret
 * @param {(msg: BridgeMessage) => void} opts.onMessage
  *
 * @returns {{ sendReply, stop }}
 */
export function createFeishuAdapter({ appId, appSecret, agentId, onMessage, onStatus }) {
  const client = new lark.Client({ appId, appSecret });

 /** 用户信息缓存 { [openId]: { name, avatarUrl } }，LRU 上限 200 */
  const userCache = new Map();
  const USER_CACHE_MAX = 200;

  async function getUserInfo(openId) {
    const cached = userCache.get(openId);
 // 只使用成功缓存（-name 的），失败的下次重试
    if (cached?.name) {
 // LRU touch：删除后重新插入，保-Map 尾部是最新的
      userCache.delete(openId);
      userCache.set(openId, cached);
      return cached;
    }

    try {
      const res = await client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" },
      });
      const user = res?.data?.user;
 //
      const displayName = user?.nickname || user?.en_name || user?.name || null;
      const avatarUrl = user?.avatar?.avatar_240 || user?.avatar?.avatar_72 || null;
      console.log("[feishu] getUserInfo succeeded (cached:", !!cached, ")");
      const info = { name: displayName, avatarUrl };
      if (info.name) {
        userCache.set(openId, info);
 //
        if (userCache.size > USER_CACHE_MAX) {
          const oldest = userCache.keys().next().value;
          userCache.delete(oldest);
        }
      }
      return info;
    } catch {
      console.error("[feishu] getUserInfo failed");
      return { name: null, avatarUrl: null };
    }
  }

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const { message, sender } = data;

      //
      if (isSelfFeishuBotSender(sender, appId)) return;

      const normalized = normalizeFeishuInboundMessage(message);
      const attachments = normalized.attachments || [];
      let text = normalized.text || "";

      if (!text && !attachments.length) return;

      const MAX_MSG_SIZE = 100_000;
      if (text.length > MAX_MSG_SIZE) {
        console.warn(`[feishu] message too large (${text.length} chars), truncated`);
        text = text.slice(0, MAX_MSG_SIZE);
      }

      const chatId = message.chat_id;
      const openId = sender.sender_id?.open_id || sender.sender_id?.app_id || "unknown";
      const userId = sender.sender_id?.user_id || sender.sender_id?.open_id || sender.sender_id?.app_id || openId;
      const chatType = message.chat_type; // "p2p" | "group"
      const isGroup = chatType === "group";
      const sessionKey = isGroup ? `fs_group_${chatId}@${agentId}` : `fs_dm_${openId}@${agentId}`;

      const userInfo = isFeishuBotSender(sender)
        ? { name: sender.sender_id?.app_id || "Feishu Bot", avatarUrl: null }
        : await getUserInfo(openId);

      onMessage({
        platform: "feishu",
        agentId,
        chatId,
        userId,
        sessionKey,
        text,
        senderName: userInfo.name,
        avatarUrl: userInfo.avatarUrl,
        isGroup,
        attachments: attachments.length ? attachments : undefined,
      });
    },
  });

  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.warn,
  });

 //
  wsClient.start({ eventDispatcher }).then(() => {
 // 轮询棢查连接状态（SDK 不暴露连接事件）
    let checks = 0;
    const maxChecks = 20; // 20 脳 500ms = 10s
    const timer = setInterval(() => {
      checks++;
      const wsInstance = wsClient.wsConfig?.wsInstance;
      if (wsInstance && wsInstance.readyState === 1) {
        clearInterval(timer);
        onStatus?.("connected");
      } else if (checks >= maxChecks) {
        clearInterval(timer);
        console.error("[feishu] WSClient not connected after 10s");
        onStatus?.("error", "WebSocket connection failed");
      }
    }, 500);
  }).catch((err) => {
    console.error("[feishu] WSClient start failed:", err.message);
    debugLog()?.error("bridge", `feishu WSClient start failed: ${err.message}`);
    onStatus?.("error", err.message);
  });

 /** */
  let stopped = false;
  let healthRestartPromise = null;
  let lastHealthStatus = null;
  let lastHealthError = null;

  function reportHealthStatus(status, error) {
    const normalizedError = error || null;
    if (lastHealthStatus === status && lastHealthError === normalizedError) return;
    lastHealthStatus = status;
    lastHealthError = normalizedError;
    if (error === undefined) onStatus?.(status);
    else onStatus?.(status, error);
  }

  const healthTimer = unrefTimer(setInterval(() => {
    if (stopped) return;
    const wsInstance = wsClient.wsConfig?.wsInstance;
    if (wsInstance && wsInstance.readyState === FEISHU_WS_OPEN) {
      reportHealthStatus("connected");
      return;
    }
    console.error("[feishu] WSClient disconnected");
    reportHealthStatus("error", FEISHU_WS_DISCONNECTED_ERROR);
    if (healthRestartPromise) return;
    healthRestartPromise = wsClient.start({ eventDispatcher })
      .catch((err) => {
        const message = err?.message || String(err);
        console.error("[feishu] WSClient restart failed:", message);
        debugLog()?.error("bridge", `feishu WSClient restart failed: ${message}`);
        reportHealthStatus("error", message);
      })
      .finally(() => {
        healthRestartPromise = null;
      });
  }, FEISHU_WS_HEALTH_INTERVAL_MS));

  const lastBlockTsMap = new Map();
  const BLOCK_TS_MAX = 200;

  return {
    mediaCapabilities: FEISHU_MEDIA_CAPABILITIES,
    streamingCapabilities: FEISHU_STREAMING_CAPABILITIES,

    getStatus() {
      return { adapterVersion: FEISHU_ADAPTER_VERSION };
    },

    async sendReply(chatId, text) {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "post",
          content: markdownPostMessageContent(text),
        },
      });
    },

 /** */
    async sendBlockReply(chatId, text) {
      const now = Date.now();
      const lastTs = lastBlockTsMap.get(chatId) || 0;
      const elapsed = now - lastTs;
      const delay = 800 + Math.random() * 1200; // 800~2000ms
      if (lastTs && elapsed < delay) {
        await new Promise(r => setTimeout(r, delay - elapsed));
      }
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "post",
          content: markdownPostMessageContent(text),
        },
      });
 //
      lastBlockTsMap.delete(chatId);
      lastBlockTsMap.set(chatId, Date.now());
      if (lastBlockTsMap.size > BLOCK_TS_MAX) {
        lastBlockTsMap.delete(lastBlockTsMap.keys().next().value);
      }
    },

 /** */
    async startStreamReply(chatId, text) {
      const res = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "post",
          content: markdownPostMessageContent(text),
        },
      });
      const messageId = extractFeishuMessageId(res);
      if (!messageId) {
        warnFeishuInbound("Feishu stream message create returned no message_id; updates disabled for this lifecycle");
        return { messageId: null, updatable: false };
      }
      return { messageId, updatable: true };
    },

    async updateStreamReply(_chatId, state, text) {
      if (state?.updatable === false) return;
      if (!state?.messageId) throw new Error("Feishu stream update requires messageId");
      await client.im.message.update({
        path: { message_id: state.messageId },
        data: {
          msg_type: "post",
          content: markdownPostMessageContent(text),
        },
      });
    },

    async finishStreamReply(chatId, state, text) {
      if (state?.updatable === false) return;
      await this.updateStreamReply(chatId, state, text);
    },

    async downloadImage(imageKey, messageId) {
      const resp = messageId
        ? await callFeishu("image download", () => client.im.messageResource.get({
          path: { message_id: messageId, file_key: imageKey },
          params: { type: "image" },
        }))
        : await callFeishu("image download", () => client.im.image.get({ path: { image_key: imageKey } }));
      return bufferFromFeishuDownload(resp, "image download");
    },

 /** */
    async downloadFile(messageId, fileKey) {
      const resp = await callFeishu("file download", () => client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: "file" },
      }));
      return bufferFromFeishuDownload(resp, "file download");
    },

 /** */
    async sendMedia(chatId, url, metadata = {}) {
      const buffer = await downloadMedia(url);
      const filename = metadata.filename || (() => { try { return new URL(url).pathname.split("/").pop() || "file"; } catch { return "file"; } })();
      const mime = metadata.mime || detectMime(buffer, "application/octet-stream", filename);
      await this.sendMediaBuffer(chatId, buffer, { ...metadata, mime, filename });
    },

 /** */
    async sendMediaBuffer(chatId, buffer, metadata = {}) {
      const filename = metadata.filename || "file";
      const mime = metadata.mime || detectMime(buffer, "application/octet-stream", filename);
      if (mime.startsWith("image/")) {
        assertUploadBuffer(buffer, "image", FEISHU_MEDIA_CAPABILITIES.maxBytes.buffer.image);
        const res = await callFeishu("image upload", () => client.im.image.create({
          data: { image_type: "message", image: buffer },
        }));
        const imageKey = requireUploadKey(res, "image_key", "image");
        await callFeishu("message send", () => client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId, msg_type: "image",
            content: JSON.stringify({ image_key: imageKey }),
          },
        }));
      } else {
        assertUploadBuffer(buffer, "file", FEISHU_MEDIA_CAPABILITIES.maxBytes.buffer.document);
        const { fileType, msgType } = feishuFileDelivery({ mime, filename });
        const res = await callFeishu("file upload", () => client.im.file.create({
          data: { file_type: fileType, file_name: filename || "file", file: buffer },
        }));
        const fileKey = requireUploadKey(res, "file_key", "file");
        await callFeishu("message send", () => client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: msgType,
            content: JSON.stringify(fileMessageContent(msgType, fileKey, metadata)),
          },
        }));
      }
    },

    stop() {
      stopped = true;
      clearInterval(healthTimer);
      try { wsClient.close(); } catch {}
    },
  };
}
