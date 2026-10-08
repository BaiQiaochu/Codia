// @ts-nocheck
import WebSocket from "ws";
import { debugLog } from "../debug-log.ts";
import { webSocketOptionsForUrl } from "../net/outbound-proxy.ts";
import { createMediaCapabilities } from "./media-capabilities.ts";
import { createBridgeOutboundHttp } from "./outbound-http.ts";
import { QQApiError, QQ_FILE_TYPE, QQ_UPLOAD_SIZE_LIMITS, uploadQQLocalFile } from "./qq-local-upload.ts";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const MAX_MSG_SIZE = 100_000;

export const QQ_ADAPTER_VERSION = "qq-bot-v2";
export const QQ_MEDIA_CAPABILITIES = createMediaCapabilities({
  platform: "qq",
  inputModes: ["local_file", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"],
  requiresReplyContext: false,
  deliveryByKind: {
    image: "native_image",
    video: "native_video",
    audio: "native_audio",
    document: "native_file",
  },
  maxBytes: {
    local_file: {
      image: QQ_UPLOAD_SIZE_LIMITS[QQ_FILE_TYPE.IMAGE],
      video: QQ_UPLOAD_SIZE_LIMITS[QQ_FILE_TYPE.VIDEO],
      audio: QQ_UPLOAD_SIZE_LIMITS[QQ_FILE_TYPE.VOICE],
      document: QQ_UPLOAD_SIZE_LIMITS[QQ_FILE_TYPE.FILE],
    },
  },
  source: "https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/rich-media.html",
});

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

function qqFileTypeForMedia(url, metadata = {}) {
  const kind = metadata.kind;
  if (kind === "image") return QQ_FILE_TYPE.IMAGE;
  if (kind === "video") return QQ_FILE_TYPE.VIDEO;
  if (kind === "audio") return QQ_FILE_TYPE.VOICE;
  if (kind === "document") return QQ_FILE_TYPE.FILE;

  const name = metadata.filename || (() => {
    try { return new URL(url).pathname; } catch { return url; }
  })();
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  const mime = String(metadata.mime || "").toLowerCase();
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return QQ_FILE_TYPE.IMAGE;
  if (mime.startsWith("video/") || ["mp4", "mov"].includes(ext)) return QQ_FILE_TYPE.VIDEO;
  if (mime.startsWith("audio/") || ["mp3", "ogg", "wav", "silk", "amr", "flac"].includes(ext)) return QQ_FILE_TYPE.VOICE;
  return QQ_FILE_TYPE.FILE;
}

function qqTargetType(metadata = {}) {
  const ctx = metadata.replyContext || metadata;
  if (ctx.targetType) return String(ctx.targetType);
  if (metadata.isGroup === true || ctx.isGroup === true || metadata.targetScope === "group" || ctx.targetScope === "group") return "group";
  if (metadata.isGroup === false || ctx.isGroup === false || metadata.targetScope === "dm" || ctx.targetScope === "dm") return "user";
  return null;
}

function qqMediaEndpoints(chatId, metadata = {}, resource) {
  const targetType = qqTargetType(metadata);
  if (targetType === "group") return [`/v2/groups/${chatId}/${resource}`];
  if (targetType === "user") return [`/v2/users/${chatId}/${resource}`];
  return [`/v2/users/${chatId}/${resource}`, `/v2/groups/${chatId}/${resource}`];
}

function qqMessageEndpoints(chatId, replyContext = {}) {
  const targetType = qqTargetType(replyContext);
  if (targetType === "group") return [{ path: `/v2/groups/${chatId}/messages`, label: "Group" }];
  if (targetType === "user") return [{ path: `/v2/users/${chatId}/messages`, label: "C2C" }];
  if (targetType === "channel") return [{ path: `/channels/${chatId}/messages`, label: "Channel", channel: true }];
  return [
    { path: `/v2/users/${chatId}/messages`, label: "C2C" },
    { path: `/v2/groups/${chatId}/messages`, label: "Group" },
    { path: `/channels/${chatId}/messages`, label: "Channel", channel: true },
  ];
}

function qqMessageIdFromContext(replyContext = null) {
  if (!replyContext) return null;
  if (typeof replyContext === "string") return replyContext;
  if (replyContext.messageId) return String(replyContext.messageId);
  if (replyContext.msgId) return String(replyContext.msgId);
  if (replyContext._msgId) return String(replyContext._msgId);
  if (replyContext.replyContext) return qqMessageIdFromContext(replyContext.replyContext);
  return null;
}

function normalizeQQReplyContext(replyContext = null) {
  if (!replyContext) return {};
  if (typeof replyContext === "string") return { messageId: replyContext };
  if (typeof replyContext !== "object") return {};
  const nested = replyContext.replyContext && typeof replyContext.replyContext === "object"
    ? replyContext.replyContext
    : {};
  const messageId = qqMessageIdFromContext(replyContext);
  return {
    ...nested,
    ...replyContext,
    ...(messageId ? { messageId } : {}),
  };
}

export function createQQAdapter({ appID, appSecret, agentId, onMessage, dmGuildMap, onDmGuildDiscovered, onStatus }) {
  const http = createBridgeOutboundHttp({ platform: "qq" });
  let accessToken = null;
  let tokenExpiresAt = 0;
  let ws = null;
  let heartbeatTimer = null;
  let lastSeq = null;
  let sessionId = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let heartbeatAckReceived = true;
  let lastConnectedAt = 0;
  let tokenRefreshFailures = 0;
  let lastBlockTs = 0;

  const userGuildMap = new Map(Object.entries(dmGuildMap || {}));
  const passiveReplySeq = new Map();

  function nextPassiveReplySeq(messageId) {
    if (!messageId) return undefined;
    const now = Date.now();
    for (const [key, entry] of passiveReplySeq) {
      if (now - entry.ts > 10 * 60 * 1000) passiveReplySeq.delete(key);
    }
    const current = passiveReplySeq.get(messageId)?.seq || 0;
    const seq = current + 1;
    passiveReplySeq.set(messageId, { seq, ts: now });
    return seq;
  }

  function attachPassiveReplyFields(body, replyContext) {
    const messageId = qqMessageIdFromContext(replyContext);
    if (!messageId) return body;
    body.msg_id = messageId;
    body.msg_seq = nextPassiveReplySeq(messageId);
    return body;
  }

  function buildMarkdownReplyBody(endpoint, content) {
    const markdown = { content };
    if (endpoint?.channel) return { markdown };
    return { content: " ", msg_type: 2, markdown };
  }

  async function refreshToken() {
    const res = await http.request({
      stage: "token",
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: appID, clientSecret: appSecret }),
      idempotent: true,
    });
    const data = await res.json();
    if (!data.access_token) {
      throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
    }
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;
    debugLog()?.log("bridge", `[qq] token refreshed, expires in ${data.expires_in}s`);
    return accessToken;
  }

  async function getToken() {
    if (!accessToken || Date.now() > tokenExpiresAt - 5 * 60 * 1000) {
      return refreshToken();
    }
    return accessToken;
  }

  async function apiRequest(method, path, body, opts = {}) {
    const stage = opts.stage;
    if (!stage) throw new Error(`QQ apiRequest [${path}] requires explicit stage`);
    const token = await getToken();
    const res = await http.request({
      stage,
      url: `${API_BASE}${path}`,
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      idempotent: opts.idempotent === true,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let bizCode;
      let message = text;
      try {
        const parsed = JSON.parse(text);
        bizCode = parsed.code ?? parsed.err_code;
        message = parsed.message || parsed.msg || text;
      } catch {}
      throw new QQApiError(`QQ API [${stage} ${path}] ${res.status}: ${String(message).slice(0, 200)}`, {
        status: res.status,
        path,
        bizCode,
      });
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new QQApiError(`QQ API [${stage} ${path}] returned invalid JSON: ${text.slice(0, 200)}`, {
        status: res.status,
        path,
      });
    }
  }

  async function connect() {
    if (stopped) return;
    try {
      const token = await getToken();
      const { url } = await apiRequest("GET", "/gateway", undefined, { stage: "gateway", idempotent: true });
      ws = new WebSocket(url, webSocketOptionsForUrl(url));

      ws.on("open", () => {
        debugLog()?.log("bridge", "[qq] WebSocket connected");
        lastConnectedAt = Date.now();
        reconnectAttempts = 0;
      });

      ws.on("message", (raw) => {
        let payload;
        try { payload = JSON.parse(raw); } catch { return; }
        handlePayload(payload, token);
      });

      ws.on("close", (code) => {
        debugLog()?.log("bridge", `[qq] WebSocket closed (code: ${code})`);
        stopHeartbeat();
        if (!stopped) scheduleReconnect();
      });

      ws.on("error", (err) => {
        console.error("[qq] WebSocket error:", err.message);
        debugLog()?.error("bridge", `[qq] WebSocket error: ${err.message}`);
        onStatus?.("error", err.message);
      });
    } catch (err) {
      console.error("[qq] connection failed:", err.message);
      onStatus?.("error", err.message);
      if (!stopped) scheduleReconnect();
    }
  }

  function handlePayload(payload, token) {
    const { op, d, s, t } = payload;
    if (s) lastSeq = s;

    switch (op) {
      case OP.HELLO:
        startHeartbeat(d.heartbeat_interval);
        if (sessionId) {
          wsSend({ op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq } });
        } else {
          wsSend({
            op: OP.IDENTIFY,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
              shard: [0, 1],
            },
          });
        }
        break;
      case OP.DISPATCH:
        if (t === "READY") {
          sessionId = d.session_id;
          debugLog()?.log("bridge", `[qq] identified session: ${sessionId}`);
          onStatus?.("connected");
        } else if (t === "RESUMED") {
          debugLog()?.log("bridge", "[qq] session resumed");
          onStatus?.("connected");
        } else {
          handleEvent(t, d);
        }
        break;
      case OP.HEARTBEAT_ACK:
        heartbeatAckReceived = true;
        break;
      case OP.RECONNECT:
        debugLog()?.log("bridge", "[qq] reconnect requested");
        ws?.close();
        break;
      case OP.INVALID_SESSION:
        debugLog()?.log("bridge", "[qq] invalid session, reconnecting");
        sessionId = null;
        lastSeq = null;
        ws?.close();
        break;
    }
  }

  function extractAttachments(data) {
    const attachments = [];
    if (data.attachments?.length) {
      for (const att of data.attachments) {
        const ct = att.content_type || "";
        const type = ct.startsWith("image/") ? "image"
          : ct.startsWith("video/") ? "video"
          : ct.startsWith("audio/") ? "audio"
            : "file";
        attachments.push({
          type,
          url: att.url,
          filename: att.filename,
          mimeType: ct,
          size: att.size,
          width: att.width,
          height: att.height,
        });
      }
    }
    return attachments;
  }

  function handleEvent(type, data) {
    if (type === "C2C_MESSAGE_CREATE") {
      const text = (data.content || "").trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      if (text.length > MAX_MSG_SIZE) return;
      onMessage({
        platform: "qq",
        agentId,
        chatId: data.author?.user_openid || data.author?.id,
        userId: data.author?.user_openid || data.author?.id,
        sessionKey: `qq_dm_${data.author?.user_openid || data.author?.id}@${agentId}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: false,
        _msgId: data.id,
        replyTargetType: "user",
        attachments: attachments.length ? attachments : undefined,
      });
    } else if (type === "GROUP_AT_MESSAGE_CREATE") {
      const text = (data.content || "").replace(/<@!?\d+>/g, "").trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      if (text.length > MAX_MSG_SIZE) return;
      onMessage({
        platform: "qq",
        agentId,
        chatId: data.group_openid,
        userId: data.author?.member_openid || data.author?.id,
        sessionKey: `qq_group_${data.group_openid}@${agentId}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: true,
        _msgId: data.id,
        replyTargetType: "group",
        attachments: attachments.length ? attachments : undefined,
      });
    } else if (type === "AT_MESSAGE_CREATE") {
      const text = (data.content || "").replace(/<@!?\d+>/g, "").trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      onMessage({
        platform: "qq",
        agentId,
        chatId: data.channel_id,
        userId: data.author?.id,
        sessionKey: `qq_group_${data.channel_id}@${agentId}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: true,
        _msgId: data.id,
        replyTargetType: "channel",
        attachments: attachments.length ? attachments : undefined,
      });
    } else if (type === "DIRECT_MESSAGE_CREATE") {
      const text = (data.content || "").trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      const chatId = data.guild_id;
      if (data.author?.id && chatId && userGuildMap.get(data.author.id) !== chatId) {
        userGuildMap.set(data.author.id, chatId);
        onDmGuildDiscovered?.(data.author.id, chatId);
      }
      onMessage({
        platform: "qq",
        agentId,
        chatId,
        userId: data.author?.id,
        sessionKey: `qq_dm_${data.author?.id}@${agentId}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: false,
        _msgId: data.id,
        attachments: attachments.length ? attachments : undefined,
      });
    }
  }

  function wsSend(data) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function startHeartbeat(interval) {
    stopHeartbeat();
    heartbeatAckReceived = true;
    heartbeatTimer = setInterval(() => {
      if (!heartbeatAckReceived) {
        debugLog()?.log("bridge", "[qq] heartbeat timed out, reconnecting");
        ws?.close();
        return;
      }
      heartbeatAckReceived = false;
      wsSend({ op: OP.HEARTBEAT, d: lastSeq });
    }, interval);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (lastConnectedAt && Date.now() - lastConnectedAt > 5 * 60 * 1000) {
      reconnectAttempts = 0;
    }
    const delays = [1000, 2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(reconnectAttempts, delays.length - 1)];
    reconnectAttempts++;
    debugLog()?.log("bridge", `[qq] reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);
    setTimeout(() => connect(), delay);
  }

  connect();

  const tokenRefreshTimer = setInterval(async () => {
    try {
      await refreshToken();
      tokenRefreshFailures = 0;
    } catch (err) {
      tokenRefreshFailures++;
      console.error(`[qq] token refresh failed (${tokenRefreshFailures} consecutive):`, err.message);
      debugLog()?.error("bridge", `[qq] token refresh failed: ${err.message}`);
      if (tokenRefreshFailures >= 3) {
        onStatus?.("error", `Token refresh failed ${tokenRefreshFailures} consecutive times`);
      }
    }
  }, 60 * 60 * 1000);

  async function sendRichMediaMessage(chatId, fileInfo, metadata = {}) {
    const msgBody = { msg_type: 7, media: { file_info: fileInfo }, content: " " };
    attachPassiveReplyFields(msgBody, metadata.replyContext || metadata);
    const messageEndpoints = qqMediaEndpoints(chatId, metadata, "messages");
    for (const endpoint of messageEndpoints) {
      try {
        await apiRequest("POST", endpoint, msgBody, { stage: "send_media_message" });
        return;
      } catch (err) {
        if (endpoint === messageEndpoints.at(-1)) {
          debugLog()?.error("bridge", `[qq] rich media message failed: ${err.message}`);
          throw err;
        }
      }
    }
  }

  return {
    mediaCapabilities: QQ_MEDIA_CAPABILITIES,

    getStatus() {
      return { adapterVersion: QQ_ADAPTER_VERSION };
    },

    async sendReply(chatId, text, replyContext = null) {
      const context = normalizeQQReplyContext(replyContext);
      const messageEndpoints = qqMessageEndpoints(chatId, context);
      const MAX = 2000;
      for (let i = 0; i < text.length; i += MAX) {
        const chunk = text.slice(i, i + MAX);
        let lastError = null;
        const errors = [];
        for (const endpoint of messageEndpoints) {
          const body = buildMarkdownReplyBody(endpoint, chunk);
          attachPassiveReplyFields(body, context);
          try {
            await apiRequest("POST", endpoint.path, body, { stage: "send_reply" });
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
            errors.push(`${endpoint.label}=${err.message}`);
          }
        }
        if (lastError) {
          debugLog()?.error("bridge", `[qq] message delivery failed chatId=${chatId}: ${errors.join(", ")}`);
          throw lastError;
        }
      }
    },

    async sendBlockReply(chatId, text, replyContext = null) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200;
      if (lastBlockTs && elapsed < delay) {
        await new Promise((r) => setTimeout(r, delay - elapsed));
      }
      await this.sendReply(chatId, text, replyContext);
      lastBlockTs = Date.now();
    },

    async sendMedia(chatId, url, metadata = {}) {
      const fileType = qqFileTypeForMedia(url, metadata);
      if (metadata.isGroup === true && fileType === QQ_FILE_TYPE.FILE) {
        throw new Error("QQ group chats do not currently support document media delivery");
      }

      const uploadBody = { file_type: fileType, url, srv_send_msg: false };
      let fileInfo;
      const uploadEndpoints = qqMediaEndpoints(chatId, metadata, "files");
      for (const endpoint of uploadEndpoints) {
        try {
          const res = await apiRequest("POST", endpoint, uploadBody, { stage: "media_upload" });
          fileInfo = res.file_info;
          break;
        } catch (err) {
          if (endpoint === uploadEndpoints.at(-1)) {
            debugLog()?.error("bridge", `[qq] media upload failed: ${err.message}`);
            throw err;
          }
        }
      }
      await sendRichMediaMessage(chatId, fileInfo, metadata);
    },

    async sendMediaFile(chatId, filePath, metadata = {}) {
      const fileType = qqFileTypeForMedia(metadata.filename || filePath, metadata);
      if (metadata.isGroup === true && fileType === QQ_FILE_TYPE.FILE) {
        throw new Error("QQ group chats do not currently support document media delivery");
      }
      const uploadResult = await uploadQQLocalFile({ apiRequest, outboundHttp: http, chatId, filePath, fileType, metadata });
      if (!uploadResult?.file_info) {
        throw new Error("QQ local file upload succeeded without file_info");
      }
      await sendRichMediaMessage(chatId, uploadResult.file_info, metadata);
    },

    async sendMediaBuffer(_chatId, _buffer, { filename } = {}) {
      const label = filename ? `: ${filename}` : "";
      throw new Error(`QQ local media delivery requires a registered staged file${label}`);
    },

    stop() {
      stopped = true;
      stopHeartbeat();
      clearInterval(tokenRefreshTimer);
      if (ws) {
        try { ws.close(); } catch {}
        ws = null;
      }
    },

    async getMe() {
      return apiRequest("GET", "/users/@me", undefined, { stage: "get_me", idempotent: true });
    },

    resolveOwnerChatId(userId) {
      return userGuildMap.get(userId) || null;
    },
  };
}
