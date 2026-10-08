import WebSocket from "ws";
import { createModuleLogger, debugLog } from "../debug-log.ts";
import { webSocketOptionsForUrl } from "../net/outbound-proxy.ts";
import { createMediaCapabilities } from "./media-capabilities.ts";
import { createBridgeOutboundHttp } from "./outbound-http.ts";
import { createStreamingCapabilities } from "./streaming-capabilities.ts";
import {
  DINGTALK_ACCESS_TOKEN_URL,
  DINGTALK_BOT_CALLBACK_TOPIC,
  DINGTALK_DM_SEND_URL,
  DINGTALK_GROUP_SEND_URL,
  DINGTALK_STREAM_OPEN_URL,
} from "./dingtalk-contract.ts";

export {
  DINGTALK_ACCESS_TOKEN_URL,
  DINGTALK_BOT_CALLBACK_TOPIC,
  DINGTALK_DM_SEND_URL,
  DINGTALK_GROUP_SEND_URL,
  DINGTALK_STREAM_OPEN_URL,
} from "./dingtalk-contract.ts";

const log = createModuleLogger("dingtalk");

const MAX_MSG_SIZE = 100_000;
const MAX_OUTBOUND_TEXT_BYTES = 12_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_RECONNECT_DELAY_MS = 5_000;

export const DINGTALK_STREAMING_CAPABILITIES = createStreamingCapabilities({
  platform: "dingtalk",
  mode: "batch",
  scopes: ["dm", "group"],
  maxChars: 15_000,
  renderer: "text",
  source: "https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/",
});

export const DINGTALK_MEDIA_CAPABILITIES = createMediaCapabilities({
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
  maxBytes: {},
  source: "DingTalk robot sampleMarkdown public URL relay",
});

function asString(value: any) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function cleanString(value: any) {
  const s = asString(value).trim();
  return s || null;
}

function safeJsonParse(value: any) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    value = Buffer.concat(value.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part)));
  }
  if (value instanceof ArrayBuffer) value = Buffer.from(value);
  if (ArrayBuffer.isView(value) && !Buffer.isBuffer(value)) {
    value = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "object" && !Buffer.isBuffer(value)) return value;
  const text = Buffer.isBuffer(value) ? value.toString("utf-8") : String(value);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function responseJsonOrText(res: any) {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }
}

function dingTalkApiError(stage: string, data: any, status?: number) {
  const code = data?.code ?? data?.errcode ?? data?.errorCode ?? status ?? "unknown";
  const message = data?.message || data?.errmsg || data?.msg || data?.errorMessage || data?.error || JSON.stringify(data);
  return new Error(`[dingtalk:${stage}] ${message || "request failed"} (code=${code})`);
}

function validateDingTalkApiResponse(stage: string, res: any, data: any) {
  const code = data?.code ?? data?.errcode ?? data?.errorCode;
  if (!res?.ok) throw dingTalkApiError(stage, data, res?.status);
  if (code !== undefined && code !== 0 && code !== "0") throw dingTalkApiError(stage, data, res?.status);
}

function appendTicket(endpoint: string, ticket: string) {
  const url = new URL(endpoint);
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

function dingTalkTargetScope(options: Record<string, any> = {}) {
  const context = options.replyContext && typeof options.replyContext === "object"
    ? options.replyContext
    : {};
  if (options.targetScope) return String(options.targetScope);
  if (context.targetScope) return String(context.targetScope);
  if (options.isGroup === true || context.isGroup === true) return "group";
  if (options.isGroup === false || context.isGroup === false) return "dm";
  return "dm";
}

function splitTextByUtf8Bytes(text: string, maxBytes = MAX_OUTBOUND_TEXT_BYTES) {
  const value = asString(text);
  if (!value) return [""];
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (const char of Array.from(value)) {
    const bytes = Buffer.byteLength(char, "utf-8");
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function markdownPayload(text: string, index: number, total: number) {
  const title = total > 1 ? `BYOUNG ${index + 1}/${total}` : "BYOUNG";
  return JSON.stringify({ title, text });
}

function safeMarkdownLabel(value: any) {
  return (cleanString(value) || "media")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\[\]]/g, "")
    .trim()
    .slice(0, 80) || "media";
}

function assertHttpMediaUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DingTalk media URL must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("DingTalk media URL must use http or https");
  }
}

function markdownMediaPayload(url: string, metadata: Record<string, any> = {}) {
  const title = safeMarkdownLabel(metadata.filename || metadata.label || metadata.title);
  const caption = cleanString(metadata.caption || metadata.description);
  const kind = cleanString(metadata.kind) || "document";
  const mediaMarkdown = kind === "image"
    ? `![${title}](${url})`
    : `[${title}](${url})`;
  const text = caption ? `${mediaMarkdown}\n\n${caption}` : mediaMarkdown;
  return JSON.stringify({ title, text });
}

function extractDingTalkText(payload: Record<string, any>) {
  const msgtype = asString(payload.msgtype || payload.msgType).toLowerCase();
  if (msgtype === "text") return asString(payload.text?.content || payload.content?.text || payload.content || "");
  if (msgtype === "audio") {
    const recognition = cleanString(payload.content?.recognition || payload.audio?.recognition);
    if (recognition) return recognition;
  }
  if (Array.isArray(payload.content?.richText)) {
    return payload.content.richText.map((item: any) => asString(item?.text)).join("");
  }
  return "";
}

function unsupportedMessageNotice(payload: Record<string, any>) {
  const msgtype = cleanString(payload.msgtype || payload.msgType) || "unknown";
  return `DingTalk message type ${msgtype} is not supported yet. Please send text instead.`;
}

function normalizeDingTalkInboundMessage(payload: Record<string, any>, agentId: string) {
  const conversationId = cleanString(payload.conversationId);
  const userId = cleanString(payload.senderStaffId)
    || cleanString(payload.senderId)
    || cleanString(payload.senderUnionId)
    || "unknown";
  const isGroup = String(payload.conversationType || "") !== "1";
  const chatId = isGroup ? conversationId : userId;
  if (!chatId) return null;

  let text = extractDingTalkText(payload);
  if (!text) text = unsupportedMessageNotice(payload);
  if (text.length > MAX_MSG_SIZE) {
    log.warn(`message too large (${text.length} chars), truncated`);
    text = text.slice(0, MAX_MSG_SIZE);
  }

  const sessionKey = isGroup
    ? `dt_group_${chatId}@${agentId}`
    : `dt_dm_${userId}@${agentId}`;

  return {
    platform: "dingtalk",
    agentId,
    chatId,
    userId,
    sessionKey,
    text,
    senderName: cleanString(payload.senderNick) || "DingTalk User",
    isGroup,
    _msgId: cleanString(payload.msgId) || cleanString(payload.messageId) || null,
  };
}

export function createDingTalkAdapter({
  clientId,
  clientSecret,
  robotCode,
  agentId,
  onMessage,
  onStatus,
  fetchImpl,
  WebSocketImpl = WebSocket,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
}: {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  agentId: string;
  onMessage: (msg: Record<string, any>) => void;
  onStatus?: (status: string, error?: string) => void;
  fetchImpl?: any;
  WebSocketImpl?: any;
  reconnectDelayMs?: number;
}) {
  const http = createBridgeOutboundHttp({ platform: "dingtalk", fetchImpl });
  let accessToken: string | null = null;
  let tokenExpiresAt = 0;
  let ws: any = null;
  let stopped = false;
  let reconnectTimer: any = null;

  async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt - TOKEN_EXPIRY_SKEW_MS) return accessToken;
    const res = await http.request({
      stage: "token",
      url: DINGTALK_ACCESS_TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
      idempotent: true,
    });
    const data = await responseJsonOrText(res);
    validateDingTalkApiResponse("token", res, data);
    const token = data?.accessToken || data?.access_token;
    if (!token) throw dingTalkApiError("token", data, res?.status);
    const expiresIn = Number(data?.expireIn || data?.expiresIn || data?.expires_in || 7200);
    accessToken = String(token);
    tokenExpiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
    return accessToken;
  }

  async function openStreamRegistration() {
    const res = await http.request({
      stage: "stream_open",
      url: DINGTALK_STREAM_OPEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        subscriptions: [
          { topic: DINGTALK_BOT_CALLBACK_TOPIC, type: "CALLBACK" },
        ],
        ua: "gsap-bridge-dingtalk/1.0.0",
      }),
      idempotent: true,
    });
    const data = await responseJsonOrText(res);
    validateDingTalkApiResponse("stream_open", res, data);
    const endpoint = cleanString(data?.endpoint);
    const ticket = cleanString(data?.ticket);
    if (!endpoint || !ticket) throw dingTalkApiError("stream_open", data, res?.status);
    return { endpoint, ticket };
  }

  function acknowledge(envelope: Record<string, any>) {
    const messageId = envelope?.headers?.messageId;
    const closedState = WebSocketImpl.CLOSED ?? 3;
    if (!messageId || !ws) return;
    if (typeof ws.readyState === "number" && ws.readyState === closedState) return;
    ws.send(JSON.stringify({
      code: 200,
      headers: {
        contentType: "application/json",
        messageId,
      },
      message: "OK",
      data: "{}",
    }));
  }

  function handleStreamMessage(raw: any) {
    const envelope = safeJsonParse(raw);
    if (!envelope || typeof envelope !== "object") return;
    const topic = envelope.headers?.topic;
    const type = envelope.type;
    if (type === "SYSTEM" && topic === "disconnect") {
      try { ws?.close?.(); } catch {}
      return;
    }
    if (type !== "CALLBACK" || topic !== DINGTALK_BOT_CALLBACK_TOPIC) return;

    acknowledge(envelope);
    const payload = safeJsonParse(envelope.data);
    if (!payload || typeof payload !== "object") return;
    if (payload.robotCode && robotCode && payload.robotCode !== robotCode) return;

    const normalized = normalizeDingTalkInboundMessage(payload, agentId);
    if (!normalized) return;
    try {
      onMessage(normalized);
    } catch (err: any) {
      debugLog()?.warn("bridge", `[dingtalk] onMessage failed: ${err?.message || err}`);
    }
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(reason?: string) {
    if (stopped || reconnectTimer) return;
    onStatus?.("connecting", reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  async function connect() {
    if (stopped) return;
    clearReconnectTimer();
    try {
      const { endpoint, ticket } = await openStreamRegistration();
      if (stopped) return;
      const url = appendTicket(endpoint, ticket);
      ws = new WebSocketImpl(url, webSocketOptionsForUrl(url));
      ws.on("open", () => {
        log.log("stream connected");
        onStatus?.("connected");
      });
      ws.on("message", handleStreamMessage);
      ws.on("error", (err: any) => {
        const message = err?.message || String(err);
        log.error(`stream error: ${message}`);
        onStatus?.("error", message);
      });
      ws.on("close", () => {
        if (stopped) return;
        log.warn("stream closed, reconnecting");
        scheduleReconnect("stream closed");
      });
    } catch (err: any) {
      const message = err?.message || String(err);
      log.error(`connect failed: ${message}`);
      onStatus?.("error", message);
      scheduleReconnect(message);
    }
  }

  async function requestRobotApi(stage: string, url: string, body: Record<string, any>) {
    const token = await getAccessToken();
    const res = await http.request({
      stage,
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify(body),
      idempotent: false,
    });
    const data = await responseJsonOrText(res);
    validateDingTalkApiResponse(stage, res, data);
    return data;
  }

  void connect();

  return {
    streamingCapabilities: DINGTALK_STREAMING_CAPABILITIES,
    mediaCapabilities: DINGTALK_MEDIA_CAPABILITIES,

    async sendReply(chatId: string, text: string, options: Record<string, any> = {}) {
      const content = asString(text);
      const scope = dingTalkTargetScope(options);
      const chunks = splitTextByUtf8Bytes(content);
      const results = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const msgParam = markdownPayload(chunks[i], i, chunks.length);
        if (scope === "group") {
          results.push(await requestRobotApi("send_group", DINGTALK_GROUP_SEND_URL, {
            robotCode,
            openConversationId: String(chatId),
            msgKey: "sampleMarkdown",
            msgParam,
          }));
        } else {
          results.push(await requestRobotApi("send_dm", DINGTALK_DM_SEND_URL, {
            robotCode,
            userIds: [String(chatId)],
            msgKey: "sampleMarkdown",
            msgParam,
          }));
        }
      }
      return results.length === 1 ? results[0] : results;
    },

    async sendMedia(chatId: string, url: string, metadata: Record<string, any> = {}) {
      const mediaUrl = cleanString(url);
      if (!mediaUrl) throw new Error("DingTalk media URL is required");
      assertHttpMediaUrl(mediaUrl);
      const scope = dingTalkTargetScope(metadata);
      const msgParam = markdownMediaPayload(mediaUrl, metadata);
      if (scope === "group") {
        return requestRobotApi("send_group_media", DINGTALK_GROUP_SEND_URL, {
          robotCode,
          openConversationId: String(chatId),
          msgKey: "sampleMarkdown",
          msgParam,
        });
      }
      return requestRobotApi("send_dm_media", DINGTALK_DM_SEND_URL, {
        robotCode,
        userIds: [String(chatId)],
        msgKey: "sampleMarkdown",
        msgParam,
      });
    },

    stop() {
      stopped = true;
      clearReconnectTimer();
      const current = ws;
      ws = null;
      try { current?.close?.(); } catch {}
      onStatus?.("disconnected");
    },
  };
}
