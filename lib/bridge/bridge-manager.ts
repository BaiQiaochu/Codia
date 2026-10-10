// @ts-nocheck
/**
  *
  * */

import fs from "fs";
import path from "path";
import { debugLog } from "../debug-log.ts";
import { createTelegramAdapter } from "./telegram-adapter.ts";
import { createFeishuAdapter } from "./feishu-adapter.ts";
import { createDingTalkAdapter } from "./dingtalk-adapter.ts";
import { createQQAdapter } from "./qq-adapter.ts";
import { createWechatAdapter } from "./wechat-adapter.ts";
import { createWhatsAppAdapter } from "./whatsapp-adapter.ts";
import { createAgentlyMailAdapter } from "./agently-mail.ts";
import { downloadMedia, bufferToBase64, detectMime, splitMediaFromOutput, formatSize, setMediaLocalRoots, isExtractableReplyMediaSource } from "./media-utils.ts";
import { mediaItemKey, normalizeMediaItems } from "./media-item-normalizer.ts";
import { MediaDeliveryService } from "./media-delivery-service.ts";
import { MediaPublisher } from "./media-publisher.ts";
import { collectBridgeMediaAllowedRoots } from "./media-roots.ts";
import { isBridgeOwner, resolveBridgeOwnerDeliveryTarget } from "./owner-policy.ts";
import { normalizeBridgePlatforms } from "./bridge-context.ts";
import { AppError } from "../../shared/errors.ts";
import { errorBus } from "../../shared/error-bus.ts";
import { handleRcPendingInput } from "../../core/slash-commands/rc-pending-handler.ts";
import { collectMediaItems } from "../tools/media-details.ts";
import { formatSettingsUpdateText } from "../tools/settings-update-result.ts";
import { backoffMs, BridgeReliabilityLedger } from "./bridge-reliability-ledger.ts";

const MAX_INBOUND_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function unrefTimer(timer) {
  try { timer?.unref?.(); } catch {}
  return timer;
}

// ── Adapter Registry ─────────────────────────────────────
//
const ADAPTER_REGISTRY = {
  telegram: {
    create: (creds, onMessage, hooks, agentId) => createTelegramAdapter({ token: creds.token, agentId, onMessage, onStatus: hooks?.onStatus }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.token ? { token: cfg.token } : null,
    ownerSessionKey: (userId, agentId) => `tg_dm_${userId}@${agentId}`,
  },
  feishu: {
    create: (creds, onMessage, hooks, agentId) => createFeishuAdapter({ appId: creds.appId, appSecret: creds.appSecret, agentId, onMessage, onStatus: hooks?.onStatus }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.appId && cfg?.appSecret ? { appId: cfg.appId, appSecret: cfg.appSecret } : null,
    ownerSessionKey: (userId, agentId) => `fs_dm_${userId}@${agentId}`,
    connectsAsync: true,
  },
  dingtalk: {
    create: (creds, onMessage, hooks, agentId) => createDingTalkAdapter({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      robotCode: creds.robotCode,
      agentId,
      onMessage,
      onStatus: hooks?.onStatus,
    }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.clientId && cfg?.clientSecret && cfg?.robotCode
      ? { clientId: cfg.clientId, clientSecret: cfg.clientSecret, robotCode: cfg.robotCode }
      : null,
    ownerSessionKey: (userId, agentId) => `dt_dm_${userId}@${agentId}`,
    connectsAsync: true,
  },
  qq: {
    create: (creds, onMessage, hooks, agentId) => createQQAdapter({
      appID: creds.appID, appSecret: creds.appSecret, agentId, onMessage,
      dmGuildMap: creds.dmGuildMap,
      onDmGuildDiscovered: hooks?.onQqDmGuild,
      onStatus: hooks?.onStatus,
    }),
    getCredentials: (cfg) => {
      const secret = cfg?.appSecret || cfg?.token; // Backward compatible token field.
      return cfg?.enabled && cfg?.appID && secret
        ? { appID: cfg.appID, appSecret: secret, dmGuildMap: cfg.dmGuildMap }
        : null;
    },
    ownerSessionKey: (userId, agentId) => `qq_dm_${userId}@${agentId}`,
  },
  wechat: {
    create: (creds, onMessage, hooks, agentId) => createWechatAdapter({
      botToken: creds.botToken,
      codiaHome: creds.codiaHome,
      agentId,
      onMessage,
      onStatus: hooks?.onStatus,
    }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.botToken ? { botToken: cfg.botToken, codiaHome: cfg._codiaHome || "" } : null,
    ownerSessionKey: (userId, agentId) => `wx_dm_${userId}@${agentId}`,
    connectsAsync: true,
  },
  whatsapp: {
    create: (creds, onMessage, hooks, agentId) => createWhatsAppAdapter({
      codiaHome: creds.codiaHome,
      agentId,
      onMessage,
      onStatus: hooks?.onStatus,
    }),
    getCredentials: (cfg) => cfg?.enabled ? { codiaHome: cfg._codiaHome || "" } : null,
    ownerSessionKey: (userId, agentId) => `wa_dm_${userId}@${agentId}`,
    connectsAsync: true,
  },
  agentlyMail: {
    create: (creds, onMessage, hooks, agentId) => createAgentlyMailAdapter({
      email: creds.email,
      agentId,
      onStatus: hooks?.onStatus,
    }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.email ? { email: cfg.email } : null,
    ownerSessionKey: (userId, agentId) => `am_dm_${encodeURIComponent(userId)}@${agentId}`,
  },
};

/* ── StreamCleaner ─────────────────────────────────────────
  * */
const STRIP_TAGS = ["mood", "pulse", "reflect", "tool_code", "think", "thinking"];

function stripUnprotectedInternalTags(value) {
  let cleaned = value;
  cleaned = cleaned.replace(/<(?:mood|pulse|reflect|tool_code|think|thinking)\b[^>]*>[\s\S]*?<\/(?:mood|pulse|reflect|tool_code|think|thinking)\s*>\s*/gi, "");
  cleaned = cleaned.replace(/<(?:[a-z][\w-]*:)?(?:tool_calls|function_calls)\b[^>]*>[\s\S]*?<\/(?:[a-z][\w-]*:)?(?:tool_calls|function_calls)\s*>\s*/gi, "");
  cleaned = cleaned.replace(/<t>\d{2}-\d{2}\s+\d{2}:\d{2}<\/t>/gi, "");
  cleaned = cleaned.replace(/<\|[^|<>]+\|>/g, "");
  cleaned = cleaned.replace(/<\/(?:mood|pulse|reflect|tool_code|think|thinking|(?:[a-z][\w-]*:)?(?:invoke|parameter|tool_calls|function_calls))\s*>/gi, "");

  const protocolOpen = /<(?:[a-z][\w-]*:)?(?:invoke|parameter|tool_calls|function_calls)\b([^>]*)>/i;
  while (true) {
    const match = protocolOpen.exec(cleaned);
    if (!match) break;
    const after = cleaned.slice(match.index + match[0].length);
    const hasProtocolAttributes = match[1].trim().length > 0;
    const continuesProtocol = /^\s*<(?:[a-z][\w-]*:)?(?:invoke|parameter|tool_calls|function_calls)\b/i.test(after);
    if (hasProtocolAttributes || continuesProtocol) {
      cleaned = cleaned.slice(0, match.index);
      break;
    }
    cleaned = cleaned.slice(0, match.index) + cleaned.slice(match.index + match[0].length);
  }

  cleaned = cleaned.replace(/<(?:mood|pulse|reflect|tool_code|think|thinking)\b[^>]*>[\s\S]*$/gi, "");
  return cleaned;
}

export function stripInternalTags(value) {
  let text = typeof value === "string" ? value : "";
  text = text.replace(/```(?:mood|pulse|reflect)\b[\s\S]*?```\s*/gi, "");

  const protectedSegments = [];
  text = text.replace(/```[\s\S]*?```|`[^`\r\n]*`/g, (segment) => {
    const token = `\uE000${protectedSegments.length}\uE001`;
    protectedSegments.push(segment);
    return token;
  });

  text = stripUnprotectedInternalTags(text);
  text = text.replace(/\uE000(\d+)\uE001/g, (_token, index) => protectedSegments[Number(index)] || "");
  return text.trim();
}

export class StreamCleaner {
  constructor() {
    this._buf = "";
    this._inTag = false;
    this._tagName = null;
    this.cleaned = "";
 /** 流式过程中提取到的媒-URL */
    this.extractedMedia = [];
    this._inCodeFence = false;
 /** 媒体拦截的行缓冲（处-delta 分片边界-*/
    this._lineBuf = "";
  }

 /** */
  feed(delta) {
    this._buf += delta;
    let out = "";

    while (true) {
      if (this._inTag) {
        const close = `</${this._tagName}>`;
        const ci = this._buf.toLowerCase().indexOf(close);
        if (ci === -1) break; // Wait for more buffered data.
        this._buf = this._buf.slice(ci + close.length).replace(/^\s*/, "");
        this._inTag = false;
        this._tagName = null;
      } else {
 //
        let bestIdx = Infinity;
        let best = null;
        const lower = this._buf.toLowerCase();
        for (const tag of STRIP_TAGS) {
          const open = `<${tag}>`;
          const idx = lower.indexOf(open);
          if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = tag; }
        }

        if (best) {
          out += this._buf.slice(0, bestIdx);
          this._buf = this._buf.slice(bestIdx + `<${best}>`.length);
          this._inTag = true;
          this._tagName = best;
        } else {
 // 保留可能的不完整弢标签（如 "<Moo"-
          let hold = 0;
          const lower = this._buf.toLowerCase();
          for (const tag of STRIP_TAGS) {
            const open = `<${tag}>`;
            for (let len = 1; len < open.length; len++) {
              if (lower.endsWith(open.slice(0, len)) && len > hold) hold = len;
            }
          }
          out += this._buf.slice(0, this._buf.length - hold);
          this._buf = this._buf.slice(this._buf.length - hold);
          break;
        }
      }
    }

 //
    out = this._interceptMedia(out);

    this.cleaned += out;
    return out;
  }

  /**
 * 从文本增量中拦截媒体标记，返回剥离后的干凢文本- * 使用行缓冲处-delta 分片边界（如 "MED" + "IA:https://..."）- * 只有遇到换行时才处理完整行，未完成的-hold -_lineBuf 中- */
  _interceptMedia(text) {
    if (!text) return text;

 // 把新文本追加到行缓冲
    this._lineBuf += text;

 //
    const parts = this._lineBuf.split("\n");
    this._lineBuf = parts.pop(); // 最后一段（可能不完整）留着

    const cleaned = [];
    for (const line of parts) {
      const processed = this._processLine(line);
      if (processed !== null) cleaned.push(processed);
    }

    return cleaned.length ? cleaned.join("\n") + "\n" : "";
  }

 /** 处理丢行完整文本，返回 null 表示该行被媒体拦截移-*/
  _processLine(line) {
    const trimmed = line.trim();
    //
    if (trimmed.startsWith("```")) {
      this._inCodeFence = !this._inCodeFence;
      return line;
    }
    if (this._inCodeFence) return line;

    line = stripInternalTags(line);
    if (!line && trimmed) return null;

 // MEDIA:<source> 指令行（支持 URL 和本地路径，路径可含空格-
    const mediaMatch = /^MEDIA:\s*<?(.+?)>?\s*$/.exec(line.trim());
    if (mediaMatch) {
      const source = mediaMatch[1].trim();
      if (isExtractableReplyMediaSource(source)) {
        this.extractedMedia.push(source);
      }
      return null; // Always remove local media tags from bridge output.
    }

 // ![alt](url) -整行是图片标记时拦截
    const imgMatch = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)\s*$/.exec(line.trim());
    if (imgMatch) {
      this.extractedMedia.push(imgMatch[1]);
      return null;
    }

    return line;
  }

 /** */
  flushLineBuf() {
    if (!this._lineBuf) return "";
    const line = this._lineBuf;
    this._lineBuf = "";
    const processed = this._processLine(line);
    return processed !== null ? processed : "";
  }
}

/* ── BlockChunker ─────────────────────────────────────────
 * 将流式文本按行拆成多条消息（block streaming）- *
  *
 * 下一个标题触-flush 并开启新- * 结构块结束后恢复逐行发- */
class BlockChunker {
  /**
   * @param {object} opts
  *
   */
  constructor({ onFlush, maxChars = 2000 }) {
    this._onFlush = onFlush;
    this._maxChars = maxChars;
    this._buf = "";
    this._flushing = Promise.resolve();
    this._inCodeFence = false;
    this._structured = false;
    this._inSection = false;
    this._currentLine = "";
  }

 /** 喂入清理后的文本增量 */
  feed(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      this._buf += ch;
      this._currentLine += ch;
      if (ch === '\n') {
        this._onLineEnd(this._currentLine);
        this._currentLine = "";
      }
    }
 // 安全：无换行的超长文本强-flush
    if (this._buf.length >= this._maxChars && !this._inCodeFence) {
      this._flushBuf();
    }
  }

  /** 流结束：flush 剩余 buffer */
  async finish() {
    await this._flushing;
    const rest = this._buf.trim();
    if (rest) {
      await this._onFlush(rest);
      this._buf = "";
    }
    this._currentLine = "";
  }

  _onLineEnd(line) {
    const stripped = line.replace(/\n$/, '');
    const trimmed = stripped.trim();
    const isEmpty = trimmed === '';

    // ── 代码围栏 ──
    if (trimmed.startsWith('```')) {
      if (this._inCodeFence) {
 //
        this._inCodeFence = false;
        this._flushBuf();
      } else {
 // 打开围栏：先 flush 围栏前的内容
        this._inCodeFence = true;
        const cutAt = this._buf.length - line.length;
        if (cutAt > 0) this._flushAt(cutAt);
      }
      return;
    }
    if (this._inCodeFence) return;

 //
    const isHeading = /^#{1,6} /.test(trimmed);
    if (isHeading) {
 // flush 标题前的内容（上丢-/ 普行 / 结构块）
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      this._inSection = true;
      this._sectionHasContent = false;
      this._structured = false;
      return;
    }

 //
    if (this._inSection) {
      if (!isEmpty) this._sectionHasContent = true;
      if (isEmpty && this._sectionHasContent && this._buf.slice(0, -1).endsWith('\n')) {
        this._flushBuf();
        this._inSection = false;
      }
      return;
    }

 //
    const isList = /^[ \t]*[-*+] /.test(stripped) || /^[ \t]*\d+[.)]\s/.test(stripped);
    const isTable = /^[ \t]*\|.*\|/.test(stripped);
    const isBlockquote = /^[ \t]*>/.test(stripped);
    const isStructured = isList || isTable || isBlockquote;

    if (isStructured) {
      this._structured = true;
      return;
    }
    if (this._structured && isEmpty) return; // 结构块内空行

    if (this._structured) {
 // 结构块结束：flush 结构内容，当前行留在 buf
      this._structured = false;
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
 // fall through：当前行按普通行处理
    }

 //
    if (!isEmpty && this._buf.trim()) {
      this._flushBuf();
    }
  }

/** flush 整个 buf */
  _flushBuf() {
    const content = this._buf.trim();
    this._buf = "";
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content)).catch((err) => {
        console.error("[BlockChunker] flush error:", err.message);
      });
    }
  }

 /** flush buf -cutAt 个字符，保留剩余 */
  _flushAt(cutAt) {
    const content = this._buf.slice(0, cutAt).trim();
    this._buf = this._buf.slice(cutAt);
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content)).catch((err) => {
        console.error("[BlockChunker] flush error:", err.message);
      });
    }
  }
}

export function __test_cleanReplyForPlatform(text) {
  return stripInternalTags(text);
}

export function __test_cleanStreamSnapshot(text) {
  let cleaned = stripInternalTags(text || "");
  cleaned = cleaned.replace(/<(?:t|th|thi|thin|think|thinki|thinkin|thinking)$/i, "");
  cleaned = cleaned.replace(/<[^>\s]*$/g, "");
  const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned);
  return { text: textOnly, mediaUrls };
}

/** 生成紧凑时间标记-t>MM-DD HH:mm</t> */
function timeTag(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `<t>${mm}-${dd} ${hh}:${mi}</t>`;
}

export class BridgeManager {
  /**
   * @param {object} opts
   * @param {import('../../core/engine.ts').CodiaEngine} opts.engine
   * @param {import('../../hub/index.ts').Hub} opts.hub
   */
  constructor({ engine, hub }) {
    this.engine = engine;
    this._hub = hub;
    /** */
    this._platforms = new Map();
    /** per-platform diagnostics metadata */
    this._platformMeta = new Map();
 /** */
    this._pending = new Map();
 /** */
    this._processing = new Set();
 /** */
    this._messageLogs = new Map();
    this._messageLogMax = 200;
    this._reconnectTimers = new Map();
    this._reliability = new BridgeReliabilityLedger({
      dataDir: path.join(engine.codiaHome || engine.codiaHome || process.cwd(), "bridge"),
    });

    // Initialize local media allow roots for bridge attachment delivery.
    const roots = this._collectMediaAllowedRoots();
	    setMediaLocalRoots(roots);
	    this.mediaPublisher = new MediaPublisher({
	      baseUrl: engine.getBridgeMediaPublicBaseUrl?.() || process.env.CODIA_BRIDGE_PUBLIC_BASE_URL || "",
	      allowedRoots: roots,
	    });
    this._mediaDelivery = new MediaDeliveryService({ engine, mediaPublisher: this.mediaPublisher });
 /** */
    this.blockStreaming = true;
    this._draftCounter = 0;
    this._rcMirrorStreams = new Map();
    this._rcMirrorUnsubscribe = typeof hub?.subscribe === "function"
      ? hub.subscribe((event, sessionPath) => {
        this._handleRcMirrorEvent(event, sessionPath).catch((err) => {
          debugLog()?.warn("bridge", `rc mirror event failed: ${err.message}`);
        });
      })
      : null;
  }

 /** */
  _getPlatformKey(platform, agentId) {
    return agentId ? `${platform}:${agentId}` : platform;
  }

  _collectMediaAllowedRoots(agentId = null) {
    return collectBridgeMediaAllowedRoots(this.engine, { agentId });
  }

  _refreshMediaAllowedRoots(agentId = null) {
    const roots = this._collectMediaAllowedRoots(agentId);
    setMediaLocalRoots(roots);
    this.mediaPublisher?.setAllowedRoots?.(roots);
    return roots;
  }

 /** 按平台名+agentId 查找 entry */
  _findPlatformEntry(platform, agentId) {
    if (agentId) {
      return this._platforms.get(this._getPlatformKey(platform, agentId)) || null;
    }
    // No agentId: return first matching platform entry (legacy compat)
    for (const [, entry] of this._platforms) {
      if (entry.platform === platform) return entry;
    }
    return null;
  }

  _ensurePlatformMeta(platform, agentId) {
    const key = this._getPlatformKey(platform, agentId);
    if (!this._platformMeta.has(key)) {
      this._platformMeta.set(key, {
        platform,
        agentId: agentId || null,
        status: "disconnected",
        error: null,
        errorType: null,
        errorDetail: null,
        lastConnectedAt: null,
        lastErrorAt: null,
        lastSyncAt: null,
        lastStatusAt: null,
        retryCount: 0,
      });
    }
    return this._platformMeta.get(key);
  }

  _recordPlatformStatus(platform, agentId, status, error = null, errorType = null, errorDetail = null) {
    const meta = this._ensurePlatformMeta(platform, agentId);
    const now = Date.now();

    meta.platform = platform;
    meta.agentId = agentId || null;
    meta.status = status;
    meta.error = error || null;
    meta.errorType = errorType || null;
    meta.errorDetail = errorDetail || null;
    meta.lastStatusAt = now;

    if (status === "connected") {
      meta.lastConnectedAt = now;
      meta.retryCount = 0;
      meta.error = null;
      meta.errorType = null;
      meta.errorDetail = null;
      this._clearReconnect(platform, agentId);
    } else if (status === "error") {
      meta.retryCount += 1;
      this._scheduleReconnect(platform, agentId, meta.retryCount);
    } else if (status === "disconnected") {
      this._clearReconnect(platform, agentId);
    }

    if (error) {
      meta.lastErrorAt = now;
    }

    return meta;
  }

  _recordPlatformSync(platform, agentId) {
    const meta = this._ensurePlatformMeta(platform, agentId);
    meta.lastSyncAt = Date.now();
    return meta;
  }

  _reconnectKey(platform, agentId) {
    return this._getPlatformKey(platform, agentId);
  }

  _clearReconnect(platform, agentId) {
    const key = this._reconnectKey(platform, agentId);
    const timer = this._reconnectTimers.get(key);
    if (timer) clearTimeout(timer);
    this._reconnectTimers.delete(key);
  }

  _scheduleReconnect(platform, agentId, retryCount = 0) {
    const key = this._reconnectKey(platform, agentId);
    if (this._reconnectTimers.has(key)) return;
    const agent = agentId ? this.engine.getAgent?.(agentId) : null;
    const cfg = agent?.config?.bridge?.[platform];
    if (!cfg?.enabled) return;
    const delayMs = Math.min(60_000, backoffMs(Math.max(0, retryCount - 1)));
    const timer = setTimeout(() => {
      this._reconnectTimers.delete(key);
      try {
        this.startPlatformFromConfig(platform, { ...cfg }, agentId);
      } catch (err) {
        debugLog()?.warn("bridge", `scheduled reconnect failed (${platform}/${agentId || "global"}): ${err.message}`);
      }
    }, delayMs);
    this._reconnectTimers.set(key, timer);
  }

  getReliabilitySummary() {
    return this._reliability.summary();
  }

  getDeadLetters(options = {}) {
    return this._reliability.listDeadLetters(options);
  }

  async retryDueDeadLetters() {
    const due = this._reliability.listDueDeadLetters();
    const summary = { attempted: 0, delivered: 0, failed: 0, skipped: 0 };

    for (const letter of due) {
      summary.attempted += 1;
      const entry = this._findPlatformEntry(letter.platform, letter.agentId);
      if (!entry?.adapter || entry.status !== "connected") {
        const retryCount = Number(letter.retryCount || 0) + 1;
        this._reliability.updateDeadLetter(letter.id, {
          retryCount,
          nextRetryAt: Date.now() + backoffMs(retryCount),
          error: `platform ${letter.platform || "unknown"} not connected`,
        });
        summary.skipped += 1;
        continue;
      }

      try {
        if (letter.kind === "text" || letter.kind === "block_text") {
          const text = String(letter.payload?.text || "").trim();
          if (!text) throw new Error("dead letter text payload is empty");
          if (letter.kind === "block_text" && typeof entry.adapter.sendBlockReply === "function") {
            await entry.adapter.sendBlockReply(letter.chatId, text, {});
          } else {
            await entry.adapter.sendReply(letter.chatId, text, {});
          }
          this._pushMessage({
            platform: letter.platform,
            direction: "out",
            sessionKey: letter.sessionKey || `${letter.platform}_group_${letter.chatId}${letter.agentId ? `@${letter.agentId}` : ""}`,
            chatId: letter.chatId,
            agentId: letter.agentId || entry.agentId || null,
            sender: this.engine.getAgent?.(letter.agentId)?.agentName || this.engine.agentName || "助手",
            text,
            isGroup: true,
            ts: Date.now(),
          });
        } else {
          throw new Error(`dead letter kind "${letter.kind}" is not retryable`);
        }
        this._reliability.updateDeadLetter(letter.id, {
          status: "delivered",
          deliveredAt: Date.now(),
          error: null,
        });
        summary.delivered += 1;
      } catch (err) {
        const retryCount = Number(letter.retryCount || 0) + 1;
        this._reliability.updateDeadLetter(letter.id, {
          retryCount,
          nextRetryAt: Date.now() + backoffMs(retryCount),
          error: err?.message || String(err),
          status: "pending",
        });
        summary.failed += 1;
      }
    }

    return summary;
  }

  _clearPending(sessionKey) {
    const pending = this._pending.get(sessionKey);
    if (pending?.timer) clearTimeout(pending.timer);
    this._pending.delete(sessionKey);
  }

  _appendPendingAttachments(entry, target, attachments) {
    if (!attachments?.length) return;
    for (const att of attachments) {
      if (att.type === "image" && !att.url && att.platformRef && entry?.adapter?.downloadImage) {
        entry.adapter.downloadImage(att.platformRef, att._messageId)
          .then(buf => { att._prefetched = buf; })
          .catch(err => debugLog()?.warn("bridge", `image prefetch failed: ${err.message}`));
      }
      target.push(att);
    }
  }

  _triggerPendingFlush(sessionKey) {
    void this._flushPending(sessionKey).catch((err) => {
      console.error(`[bridge] pending flush failed (${sessionKey}):`, err.message);
      debugLog()?.error("bridge", `pending flush failed (${sessionKey}): ${err.message}`);
      this._processing.delete(sessionKey);
    });
  }

  _schedulePendingFlush(sessionKey, delayMs) {
    const pending = this._pending.get(sessionKey);
    if (!pending) return;
    if (delayMs <= 0) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
      this._triggerPendingFlush(sessionKey);
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this._triggerPendingFlush(sessionKey), delayMs);
  }

  _takePendingBatch(sessionKey) {
    const pending = this._pending.get(sessionKey);
    if (!pending) return null;

    if (pending.kind === "group-queue") {
      const batch = pending.batches.shift() || null;
      if (!pending.batches.length) this._pending.delete(sessionKey);
      return batch;
    }

    if (!pending.lines?.length) return null;
    if (pending.timer) clearTimeout(pending.timer);
    const batch = {
      lines: pending.lines.splice(0),
      attachments: pending.attachments?.splice(0) || [],
      platform: pending.platform,
      chatId: pending.chatId,
      senderName: pending.senderName,
      avatarUrl: pending.avatarUrl,
      userId: pending.userId,
      isGroup: pending.isGroup,
      isOwner: pending.isOwner,
      agentId: pending.agentId,
      messageThreadId: pending.messageThreadId,
      replyContext: pending.replyContext,
    };
    this._pending.delete(sessionKey);
    return batch;
  }

 /** */
  autoStart(agents) {
    if (!agents) return;
    for (const [agentId, agent] of agents) {
      const bridgeCfg = agent.config?.bridge;
      if (!bridgeCfg) continue;
      for (const [platform, spec] of Object.entries(ADAPTER_REGISTRY)) {
        const cfg = { ...(bridgeCfg[platform] || {}) };
        if (platform === "wechat") cfg._codiaHome = this.engine.codiaHome;
        if (platform === "whatsapp") cfg._codiaHome = this.engine.codiaHome;
        const creds = spec.getCredentials(cfg);
        if (creds) this.startPlatform(platform, creds, agentId);
      }
    }
  }

  /**
 * 从配置启动平台（route 层用，不需要知道凭证结构）
   * @param {string} platform
  *
   */
  startPlatformFromConfig(platform, cfg, agentId) {
    const spec = ADAPTER_REGISTRY[platform];
    if (!spec) return;
    if (platform === "wechat") cfg._codiaHome = this.engine.codiaHome;
    if (platform === "whatsapp") cfg._codiaHome = this.engine.codiaHome;
    const creds = spec.getCredentials(cfg);
    if (creds) this.startPlatform(platform, creds, agentId);
  }

  /**
 * 启动指定平台
   * @param {string} platform
   * @param {object} credentials
  * */
  async startPlatform(platform, credentials, agentId) {
    const key = this._getPlatformKey(platform, agentId);
    const spec = ADAPTER_REGISTRY[platform];
    if (!spec) throw new Error(`Unknown platform: ${platform}`);

    // stopPlatform removes the prior entry synchronously before awaiting an
    // adapter's asynchronous shutdown. Publish the new lifecycle state before
    // yielding so callers can render a reliable connecting status immediately.
    const stopPromise = this.stopPlatform(platform, agentId);
    this._recordPlatformStatus(platform, agentId, "connecting", null, null, null);
    this._emitStatus(platform, "connecting", null, agentId, null, null);
    await stopPromise;

    try {
      const onMessage = (msg) => this._handleMessage(platform, msg);
      let pendingStatus = null;
      const hooks = {
        onEvent: (evt) => this._hub.eventBus.emit(evt, null),
        onQqDmGuild: (userId, guildId) => this._persistQqDmGuild(userId, guildId, agentId),
        onStatus: (status, error, errorType, errorDetail) => {
          const entry = this._platforms.get(key);
          if (entry) {
            entry.status = status;
            entry.error = error || null;
            entry.errorType = errorType || null;
            entry.errorDetail = errorDetail || null;
          } else {
            pendingStatus = {
              status,
              error: error || null,
              errorType: errorType || null,
              errorDetail: errorDetail || null,
            };
          }
          this._recordPlatformStatus(platform, agentId, status, error || null, errorType || null, errorDetail || null);
          this._emitStatus(platform, status, error, agentId, errorType, errorDetail);
        },
      };
      const adapter = spec.create(credentials, onMessage, hooks, agentId);
      try {
        Object.defineProperties(adapter, {
          __bridgePlatform: { value: platform, configurable: true },
          __bridgeAgentId: { value: agentId || null, configurable: true },
        });
      } catch {
        adapter.__bridgePlatform = platform;
        adapter.__bridgeAgentId = agentId || null;
      }

      // Platforms with async connections start as "connecting";
      // their onStatus callback will promote to "connected" or "error".
      const isAsync = !!spec.connectsAsync;
      const initialStatus = pendingStatus?.status || (isAsync ? "connecting" : "connected");

      this._platforms.set(key, {
        adapter,
        status: initialStatus,
        error: pendingStatus?.error || null,
        errorType: pendingStatus?.errorType || null,
        errorDetail: pendingStatus?.errorDetail || null,
        agentId: agentId || null,
        platform,
      });
      this._recordPlatformStatus(platform, agentId, initialStatus, null, null, null);
      console.log(`[bridge] ${platform} started`);
      debugLog()?.log("bridge", `${platform} started`);

      this._emitStatus(platform, initialStatus, null, agentId, null, null);
    } catch (err) {
      console.error(`[bridge] ${platform} start failed:`, err.message);
      debugLog()?.error("bridge", `${platform} start failed: ${err.message}`);
      this._platforms.set(key, {
        adapter: null,
        status: "error",
        error: err.message,
        errorType: null,
        errorDetail: null,
        agentId: agentId || null,
        platform,
      });
      this._recordPlatformStatus(platform, agentId, "error", err.message, null, null);
      this._emitStatus(platform, "error", err.message, agentId, null, null);
    }
  }

 /** */
  _persistQqDmGuild(userId, guildId, agentId) {
    try {
      const agent = agentId ? this.engine.getAgent(agentId) : null;
      if (!agent) return;
      const existing = agent.config?.bridge?.qq?.dmGuildMap || {};
      if (existing[userId] === guildId) return;
      agent.updateConfig({ bridge: { qq: { dmGuildMap: { ...existing, [userId]: guildId } } } });
    } catch (err) {
      console.error("[bridge] persist QQ dmGuildMap failed:", err.message);
      errorBus.report(new AppError('BRIDGE_SEND_FAILED', { cause: err, context: { platform: 'qq', operation: 'flush dmGuildMap' } }));
    }
  }

 /** 停止指定平台 */
  async stopPlatform(platform, agentId) {
    const key = this._getPlatformKey(platform, agentId);
    const entry = this._platforms.get(key);
    if (!entry) return;
    let stopPromise = Promise.resolve();

    try {
      stopPromise = Promise.resolve(entry.adapter?.stop?.());
    } catch {
      // Adapter stop failures should not block state cleanup.
    }
    this._platforms.delete(key);
    this._recordPlatformStatus(platform, agentId, "disconnected", null, null, null);
    console.log(`[bridge] ${platform} stopped`);
    debugLog()?.log("bridge", `${platform} stopped`);
    this._emitStatus(platform, "disconnected", null, agentId, null, null);
    await stopPromise.catch(() => {});
  }

  _llmWaitingReceiptText(agentId) {
    if (this.engine.getBridgeReceiptEnabled?.() === false) return undefined;
    const agentObj = this.engine.getAgent?.(agentId);
    const agentName = agentObj?.agentName || this.engine.agentName || "";
    return agentName ? `[${agentName}] is typing...` : "";
  }

  _resolveReceiptCapability(adapter, isGroup) {
    const capability = adapter?.receiptCapabilities;
    if (!capability) return null;
    const scope = isGroup ? "group" : "dm";
    if (capability.scopes?.length && !capability.scopes.includes(scope)) return null;
    if (capability.mode === "native_typing" && adapter?.sendTypingIndicator) return capability;
    if (capability.mode === "text" && adapter?.sendReply) return capability;
    return null;
  }

  _receiptOptions(replyContext = null) {
    const context = this._normalizeReplyContext(replyContext);
    if (!context) return {};
    return {
      replyContext: context,
      ...(context.messageThreadId != null ? { messageThreadId: context.messageThreadId } : {}),
    };
  }

  _startNativeTypingReceipt(adapter, chatId, capability, replyContext = null) {
    const options = this._receiptOptions(replyContext);
    const refreshIntervalMs = Number.isFinite(capability.refreshIntervalMs)
      ? capability.refreshIntervalMs
      : 0;
    let stopped = false;
    let timer = null;

    const send = () => {
      if (stopped) return;
      adapter.sendTypingIndicator(chatId, options).catch(() => {});
    };
    send();

    if (refreshIntervalMs > 0) {
      timer = unrefTimer(setInterval(send, refreshIntervalMs));
    }

    return {
      mode: "native_typing",
      stop: async () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        if (capability.cancellable && adapter.cancelTypingIndicator) {
          try { await adapter.cancelTypingIndicator(chatId, options); } catch {}
        }
      },
    };
  }

  async _startLlmWaitingReceipt({ platform, chatId, agentId, replyContext, isGroup = false }) {
    const empty = { mode: "none", stop: async () => {} };
    const receiptText = this._llmWaitingReceiptText(agentId);
    if (receiptText === undefined) return empty;

    const entry = this._platforms.get(this._getPlatformKey(platform, agentId));
    const adapter = entry?.adapter;
    if (!adapter) return empty;

    const capability = this._resolveReceiptCapability(adapter, isGroup);
    if (capability?.mode === "native_typing") {
      return this._startNativeTypingReceipt(adapter, chatId, capability, replyContext);
    }

    if (receiptText && adapter.sendReply) {
      this._sendAdapterReply(adapter, chatId, receiptText, replyContext).catch(() => {});
      return { mode: "text", stop: async () => {} };
    }

    if (adapter.sendTypingIndicator) {
      adapter.sendTypingIndicator(chatId, this._receiptOptions(replyContext)).catch(() => {});
    }
    return empty;
  }

 /** */
  async stopAll() {
    try { this._rcMirrorUnsubscribe?.(); } catch {}
    this._rcMirrorUnsubscribe = null;
    this._rcMirrorStreams?.clear?.();
    for (const timer of this._reconnectTimers.values()) clearTimeout(timer);
    this._reconnectTimers.clear();
    const stopPromises = [];
    for (const [key, entry] of this._platforms) {
      try {
        stopPromises.push(Promise.resolve(entry.adapter?.stop?.()).catch(() => {}));
      } catch {
        // Adapter stop failures should not block shutdown.
      }
      const name = entry.platform || key;
      this._recordPlatformStatus(name, entry.agentId, "disconnected", null, null, null);
      console.log(`[bridge] ${name} stopped`);
      debugLog()?.log("bridge", `${name} stopped`);
      this._emitStatus(name, "disconnected", null, entry.agentId, null, null);
    }
    this._platforms.clear();
    await Promise.all(stopPromises);
  }

 /** */
  getStatus(agentId) {
    const result = {};
    for (const [, meta] of this._platformMeta) {
      if (agentId && meta.agentId !== agentId) continue;
      result[meta.platform] = { ...meta };
    }
    for (const [, entry] of this._platforms) {
      if (agentId && entry.agentId !== agentId) continue;
      const name = entry.platform || "unknown";
      const extra = entry.adapter?.getStatus?.() || {};
      const meta = this._ensurePlatformMeta(name, entry.agentId);
      result[name] = {
        ...meta,
        ...extra,
        status: entry.status,
        error: entry.error || null,
        errorType: extra.errorType ?? entry.errorType ?? null,
        errorDetail: extra.errorDetail ?? entry.errorDetail ?? null,
      };
    }
    return result;
  }

  _sendLlmWaitingReceipt(platform, chatId, agentId, replyContext = null) {
    this._startLlmWaitingReceipt({
      platform,
      chatId,
      agentId,
      replyContext,
      isGroup: false,
    }).catch(() => {});
  }

  /**
 * 核心：收到外部消- *
  *
  * */
  async _handleMessage(platform, msg) {
    const { sessionKey, text, senderName, avatarUrl, userId, isGroup, chatId, attachments, agentId: msgAgentId, messageThreadId } = msg;
    const replyContext = this._replyContextFromMessage({
      isGroup,
      messageId: msg._msgId || msg._messageId || msg.messageId || null,
      messageThreadId,
      targetType: msg.replyTargetType || null,
    });
 //
    const entry = this._platforms.get(this._getPlatformKey(platform, msgAgentId));
    const agentId = msgAgentId || entry?.agentId || null;
    if (!agentId) {
      console.error("[bridge] " + platform + " message missing agentId and adapter binding; dropped.");
      return;
    }
    if (!entry?.adapter) return;

    const hasAttachments = attachments?.length > 0;
    debugLog()?.log("bridge", `← ${platform} ${isGroup ? "group" : "dm"} (${text.length} chars${hasAttachments ? `, ${attachments.length} attachment(s)` : ""})`);

    //
    this._pushMessage({
      platform, direction: "in", sessionKey, agentId,
      sender: senderName || "用户", text: text || (hasAttachments ? `[${attachments.length} 个附件]` : ""),
      isGroup, ts: Date.now(),
    });

    const isOwner = this._isOwner(platform, userId, agentId, { isGroup });

    const dispatcher = this.engine.slashDispatcher;
    if (dispatcher && text && text.trim().startsWith("/") && isOwner) {
      const sendReply = (t) => this._sendAdapterReply(entry.adapter, chatId, t, replyContext).catch(() => {});
      const dispatchResult = await dispatcher.tryDispatch(text.trim(), {
        sessionRef: { kind: "bridge", agentId, sessionKey },
        source: platform,
        senderId: userId,
        senderName,
        isOwner,
        isGroup,
        chatId,
        reply: sendReply,
      });
      if (dispatchResult.handled) {
        this._clearPending(sessionKey);
        debugLog()?.log("bridge", `slash dispatched: ${text.trim().slice(0, 40)}`);
        return;
      }
    }

    const rcState = this.engine.rcState;
    if (rcState && !isGroup && rcState.isPending(sessionKey) && text && isOwner) {
      const sendReply = (t) => this._sendAdapterReply(entry.adapter, chatId, t, replyContext).catch(() => {});
      const r = await handleRcPendingInput({
        engine: this.engine,
        agentId,
        chatId,
        messageThreadId,
        sessionKey,
        text: text.trim(),
        isGroup,
        reply: async (t) => sendReply(t),
      });
      if (r?.handled) {
        this._clearPending(sessionKey);
        debugLog()?.log("bridge", `rc pending handled: ${text.trim().slice(0, 20)}`);
        return;
      }
    }

 //
    if (isOwner && /^\/(stop|abort)$/i.test(text.trim())) {
      this.engine.abortBridgeSession(sessionKey).catch(() => {});
      debugLog()?.log("bridge", `abort ${platform} active session: /stop command`);
      const pending = this._pending.get(sessionKey);
      if (pending?.timer) clearTimeout(pending.timer);
      this._pending.delete(sessionKey);
      return;
    }

 //
    if (isGroup) {
      const line = senderName ? `${senderName}: ${text}` : text;
      let pending = this._pending.get(sessionKey);
      if (!pending) {
        pending = { kind: "group-queue", batches: [] };
        this._pending.set(sessionKey, pending);
      }
      const batch = {
        lines: [line],
        attachments: [],
        platform,
        chatId,
        senderName,
        avatarUrl,
        userId,
        isGroup: true,
        isOwner,
        agentId,
        messageThreadId,
        replyContext,
      };
      this._appendPendingAttachments(entry, batch.attachments, attachments);
      pending.batches.push(batch);
      if (!this._processing.has(sessionKey) && pending.batches.length === 1) {
        this._schedulePendingFlush(sessionKey, 0);
      }
      return;
    }

 //
    const line = !isOwner && senderName
      ? `${senderName}: ${text}` : text;

    let pending = this._pending.get(sessionKey);
    if (!pending) {
      pending = { kind: "dm-buffer", lines: [], attachments: [], platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId, messageThreadId, replyContext };
      this._pending.set(sessionKey, pending);
    }
    pending.lines.push(line);
    this._appendPendingAttachments(entry, pending.attachments, attachments);
    Object.assign(pending, { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, messageThreadId, replyContext });

    const isActive = this.engine.isBridgeSessionStreaming(sessionKey);

    this._schedulePendingFlush(sessionKey, isActive ? 1000 : 2000);
  }

  /**
  * */
  async _downloadAttachment(adapter, att) {
    if (att.url) return downloadMedia(att.url);
    if (att.platformRef && adapter?.downloadFileByRef) {
      return adapter.downloadFileByRef(att.platformRef);
    }
    if (att.platformRef && att._messageId && adapter?.downloadFile) {
      return adapter.downloadFile(att._messageId, att.platformRef);
    }
    return null;
  }

  async _resolveAttachments(platform, attachments, agentId) {
    const images = [];
    const notes = [];
    const inboundFiles = [];
    if (!attachments?.length) return { images, textNotes: "", inboundFiles };

    const entry = this._findPlatformEntry(platform, agentId);
    const adapter = entry?.adapter;

    for (const att of attachments) {
      try {
        if (att.size && att.size > MAX_INBOUND_ATTACHMENT_BYTES) {
          throw new Error(`attachment too large: ${att.filename || att.type || "file"}`);
        }
        if (att.type === "image") {
          let buffer = att._prefetched || null;
          if (!buffer && att.url) {
            buffer = await downloadMedia(att.url);
          } else if (!buffer && att.platformRef && adapter?.downloadImage) {
            buffer = await adapter.downloadImage(att.platformRef, att._messageId);
          }
          if (buffer) {
            const mime = detectMime(buffer, att.mimeType || "image/jpeg");
            this._assertInboundAttachmentSize(buffer, att);
            images.push({ type: "image", data: bufferToBase64(buffer), mimeType: mime });
            inboundFiles.push(this._inboundFileFromAttachment(att, buffer, mime, "image"));
          }
        } else if (att.type === "audio") {
          const dur = att.duration ? ` ${Math.round(att.duration)}秒` : "";
          notes.push(`[收到语音${dur}]`);
        } else if (att.type === "video") {
          notes.push(`[收到视频: ${att.filename || "video"}]`);
        } else {
 // file 类型：文本文件下载内容，二进制文件保留占位符
          const filename = att.filename || "file";
          const size = att.size ? ` (${formatSize(att.size)})` : "";
          const textContent = await this._tryReadTextFile(adapter, att);
          if (textContent !== null) {
            notes.push(`[文件: ${filename}${size}]\n\`\`\`\n${textContent}\n\`\`\``);
          } else {
            notes.push(`[收到文件: ${filename}${size}]`);
          }
        }
      } catch (err) {
        debugLog()?.warn("bridge", `attachment parse failed: ${err.message}`);
        notes.push(`[附件加载失败: ${att.filename || att.type}]`);
      }
    }
    inboundFiles.push(...await this._materializeNonImageInboundAttachments(adapter, attachments));
    return { images, textNotes: notes.join("\n"), inboundFiles };
  }

  async _materializeNonImageInboundAttachments(adapter, attachments) {
    const inboundFiles = [];
    for (const att of attachments || []) {
      if (!att || att.type === "image") continue;
      try {
        const buffer = await this._downloadAttachment(adapter, att);
        if (!buffer) continue;
        this._assertInboundAttachmentSize(buffer, att);
        const fallbackName = att.type === "audio" ? "voice.ogg" : att.type === "video" ? "video.mp4" : (att.filename || "file");
        const mime = detectMime(buffer, att.mimeType || "application/octet-stream", att.filename || fallbackName);
        inboundFiles.push(this._inboundFileFromAttachment(att, buffer, mime, att.type || "file"));
      } catch (err) {
        debugLog()?.warn("bridge", `inbound attachment materialize failed: ${err.message}`);
      }
    }
    return inboundFiles;
  }

  _assertInboundAttachmentSize(buffer, att) {
    const size = buffer?.length || 0;
    if (size > MAX_INBOUND_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${att?.filename || att?.type || "file"}`);
    }
  }

  _inboundFileFromAttachment(att, buffer, mimeType, fallbackType) {
    return {
      type: att.type || fallbackType,
      filename: att.filename || this._defaultAttachmentFilename(att.type || fallbackType, mimeType),
      mimeType,
      buffer,
    };
  }

  _defaultAttachmentFilename(type, mimeType) {
    const ext = (() => {
      if (mimeType === "image/png") return "png";
      if (mimeType === "image/gif") return "gif";
      if (mimeType === "image/webp") return "webp";
      if (mimeType?.startsWith("image/")) return "jpg";
      if (mimeType === "video/mp4" || type === "video") return "mp4";
      if (mimeType === "audio/mpeg") return "mp3";
      if (mimeType?.startsWith("audio/") || type === "audio") return "ogg";
      return "bin";
    })();
    return `${type || "file"}.${ext}`;
  }

  /**
  * */
  async _tryReadTextFile(adapter, att) {
    const TEXT_EXTENSIONS = new Set([
      "txt", "md", "markdown", "json", "csv", "tsv", "xml", "yaml", "yml",
      "toml", "ini", "cfg", "conf", "log", "sql", "sh", "bash", "zsh",
      "py", "js", "ts", "jsx", "tsx", "mjs", "cjs",
      "java", "kt", "go", "rs", "rb", "php", "c", "h", "cpp", "hpp",
      "cs", "swift", "r", "lua", "pl", "html", "htm", "css", "scss",
      "less", "svg", "env", "gitignore", "dockerignore", "makefile",
      "dockerfile", "rst", "tex", "bib",
    ]);
    const MAX_TEXT_FILE_SIZE = 1024 * 1024; // 1MB

    const filename = (att.filename || "").toLowerCase();
    const ext = filename.split(".").pop() || "";
    if (!TEXT_EXTENSIONS.has(ext)) return null;

    // Skip known oversized files before downloading their contents.
    if (att.size && att.size > MAX_TEXT_FILE_SIZE) return null;

    try {
      const buffer = await this._downloadAttachment(adapter, att);
      if (!buffer) return null;
      if (buffer.length > MAX_TEXT_FILE_SIZE) return null;

 //
      const sample = buffer.slice(0, 8192);
      if (sample.includes(0x00)) return null;

      return buffer.toString("utf-8");
    } catch (err) {
      debugLog()?.warn("bridge", `file text read failed: ${err.message}`);
      return null;
    }
  }

  _replyContextFromMessage({ isGroup = null, messageId = null, messageThreadId = null, targetType = null } = {}) {
    const hasTransportContext = !!messageId || messageThreadId != null || !!targetType;
    if (!hasTransportContext) return null;
    return this._normalizeReplyContext({
      messageId,
      messageThreadId,
      targetType,
      ...(isGroup === true ? { isGroup: true, targetScope: "group" } : {}),
      ...(isGroup === false ? { isGroup: false, targetScope: "dm" } : {}),
    });
  }

  _normalizeReplyContext(context = null) {
    if (!context || typeof context !== "object") return null;
    const normalized = {};
    if (context.messageId) normalized.messageId = String(context.messageId);
    if (context.messageThreadId != null && context.messageThreadId !== "") {
      normalized.messageThreadId = context.messageThreadId;
    }
    if (context.targetType) normalized.targetType = String(context.targetType);
    if (context.isGroup === true) normalized.isGroup = true;
    if (context.isGroup === false) normalized.isGroup = false;
    if (context.targetScope) normalized.targetScope = String(context.targetScope);
    return Object.keys(normalized).length ? normalized : null;
  }

  _sendAdapterReply(adapter, chatId, text, replyContext = null) {
    const context = this._normalizeReplyContext(replyContext);
    return this._sendWithDeadLetter({
      adapter,
      chatId,
      kind: "text",
      payload: { text },
      replyContext: context || {},
      send: () => adapter.sendReply(chatId, text, context || {}),
    });
  }

  _sendAdapterBlockReply(adapter, chatId, text, replyContext = null) {
    const context = this._normalizeReplyContext(replyContext);
    return this._sendWithDeadLetter({
      adapter,
      chatId,
      kind: "block_text",
      payload: { text },
      replyContext: context || {},
      send: () => adapter.sendBlockReply(chatId, text, context || {}),
    });
  }

  async _sendWithDeadLetter({ adapter, chatId, kind, payload, replyContext, send }) {
    try {
      return await send();
    } catch (err) {
      this._reliability.recordDeadLetter({
        platform: adapter?.__bridgePlatform || replyContext?.platform || null,
        agentId: adapter?.__bridgeAgentId || null,
        chatId,
        kind,
        payload,
        error: err?.message || String(err),
      });
      throw err;
    }
  }

  _createStreamDelivery({ adapter, chatId, isGroup, platform, messageThreadId, replyContext }) {
    const capability = this._resolveStreamingCapability(adapter, isGroup);
    const mode = capability?.mode || "batch";
    const context = this._normalizeReplyContext({
      ...(replyContext || {}),
      messageThreadId: replyContext?.messageThreadId ?? messageThreadId,
      ...this._replyContextForPlatform(platform, messageThreadId),
    }) || {};

    if (mode === "draft") {
      return this._createDraftStreamDelivery({ adapter, chatId, capability, context });
    }
    if (mode === "edit_message") {
      return this._createEditMessageStreamDelivery({ adapter, chatId, capability, context });
    }
    if (mode === "block") {
      return this._createBlockStreamDelivery({ adapter, chatId, context });
    }
    return this._createBatchDelivery({ adapter, chatId, context });
  }

  _resolveStreamingCapability(adapter, isGroup) {
    if (!adapter || isGroup) return null;
    const capability = adapter.streamingCapabilities;
    if (!capability) {
      return this.blockStreaming && adapter.sendBlockReply ? { mode: "block" } : null;
    }
    if (capability.scopes?.length && !capability.scopes.includes("dm")) return null;
    if (capability.mode === "draft" && adapter.sendDraft && adapter.sendReply) return capability;
    if (
      capability.mode === "edit_message" &&
      adapter.startStreamReply &&
      adapter.updateStreamReply &&
      adapter.finishStreamReply
    ) return capability;
    if (capability.mode === "block" && this.blockStreaming && adapter.sendBlockReply) return capability;
    return null;
  }

  _createBatchDelivery({ adapter, chatId, context = {} }) {
    return {
      mode: "batch",
      onDelta: undefined,
      finish: async (cleaned) => {
        const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned);
        if (textOnly.trim()) await this._sendAdapterReply(adapter, chatId, textOnly.trim(), context);
        return mediaUrls;
      },
    };
  }

  _createBlockStreamDelivery({ adapter, chatId, context = {} }) {
    const cleaner = new StreamCleaner();
    let blockSentAny = false;
    const chunker = new BlockChunker({
      onFlush: async (text) => {
        blockSentAny = true;
        await this._sendAdapterBlockReply(adapter, chatId, text, context);
      },
    });

    return {
      mode: "block",
      onDelta: (delta) => {
        const inc = cleaner.feed(delta);
        if (inc) chunker.feed(inc);
      },
      finish: async (cleaned) => {
        const tail = cleaner.flushLineBuf();
        if (tail) {
          cleaner.cleaned += tail;
          chunker.feed(tail);
        }
        await chunker.finish();
        if (!blockSentAny) {
          const textOnly = (cleaner.cleaned || cleaned).trim();
          if (textOnly) await this._sendAdapterReply(adapter, chatId, textOnly, context);
        }
        const snapshot = this._cleanStreamSnapshot(cleaned);
        return [...cleaner.extractedMedia, ...snapshot.mediaUrls];
      },
    };
  }

  _createDraftStreamDelivery({ adapter, chatId, capability, context }) {
    const draftId = this._nextDraftId();
    const minIntervalMs = Number.isFinite(capability.minIntervalMs) ? capability.minIntervalMs : 500;
    const maxChars = Number.isFinite(capability.maxChars) ? capability.maxChars : 4096;
    let lastSentText = "";
    let lastDraftTs = 0;
    let failed = false;

    const sendSnapshot = (accumulated, force = false) => {
      if (failed) return;
      const { text } = this._cleanStreamSnapshot(accumulated);
      const next = this._truncateStreamText(text.trim(), maxChars);
      if (!next || next === lastSentText) return;
      const now = Date.now();
      if (!force && lastDraftTs && now - lastDraftTs < minIntervalMs) return;
      lastDraftTs = now;
      lastSentText = next;
      adapter.sendDraft(chatId, next, {
        draftId,
        messageThreadId: context.messageThreadId,
      }).catch(() => { failed = true; });
    };

    return {
      mode: "draft",
      onDelta: (_delta, accumulated) => sendSnapshot(accumulated || _delta),
      finish: async (cleaned) => {
        const { text, mediaUrls } = this._cleanStreamSnapshot(cleaned);
        const textOnly = text.trim();
        if (textOnly) {
          const finalText = this._truncateStreamText(textOnly, maxChars);
          if (!failed) {
            try {
              await adapter.sendDraft(chatId, finalText, {
                draftId,
                messageThreadId: context.messageThreadId,
              });
            } catch {
              failed = true;
            }
          }
          await this._sendAdapterReply(adapter, chatId, textOnly, context);
        }
        return mediaUrls;
      },
    };
  }

  _createEditMessageStreamDelivery({ adapter, chatId, capability, context }) {
    const minIntervalMs = Number.isFinite(capability.minIntervalMs) ? capability.minIntervalMs : 500;
    const maxChars = Number.isFinite(capability.maxChars) ? capability.maxChars : 150_000;
    let streamState = null;
    let lastSentText = "";
    let lastUpdateTs = 0;
    let failed = false;
    let chain = Promise.resolve();

    const enqueueSnapshot = (accumulated, force = false) => {
      if (failed) return;
      const { text } = this._cleanStreamSnapshot(accumulated);
      const next = this._truncateStreamText(text.trim(), maxChars);
      if (!next || next === lastSentText) return;
      const now = Date.now();
      if (!force && lastUpdateTs && now - lastUpdateTs < minIntervalMs) return;
      lastUpdateTs = now;
      lastSentText = next;
      chain = chain.then(async () => {
        if (!streamState) {
          streamState = await adapter.startStreamReply(chatId, next, context);
        } else {
          await adapter.updateStreamReply(chatId, streamState, next, context);
        }
      }).catch(() => { failed = true; });
    };

    return {
      mode: "edit_message",
      onDelta: (_delta, accumulated) => enqueueSnapshot(accumulated || _delta),
      finish: async (cleaned) => {
        const { text, mediaUrls } = this._cleanStreamSnapshot(cleaned);
        const textOnly = text.trim();
        await chain;
        if (!textOnly) return mediaUrls;
        const finalText = this._truncateStreamText(textOnly, maxChars);
        if (!failed) {
          try {
            if (!streamState) {
              streamState = await adapter.startStreamReply(chatId, finalText, context);
            } else {
              await adapter.finishStreamReply(chatId, streamState, finalText, context);
            }
            return mediaUrls;
          } catch {
            failed = true;
          }
        }
        await this._sendAdapterReply(adapter, chatId, textOnly, context);
        return mediaUrls;
      },
    };
  }

  _cleanStreamSnapshot(text) {
    let cleaned = this._cleanReplyForPlatform(text || "");
    for (const tag of STRIP_TAGS) {
      const open = new RegExp(`<${tag}>[\\s\\S]*$`, "i");
      cleaned = cleaned.replace(open, "");
    }
    cleaned = cleaned.replace(/<[^>\s]*$/g, "");
    const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned);
    return { text: textOnly, mediaUrls };
  }

  _truncateStreamText(text, maxChars) {
    if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  _nextDraftId() {
    this._draftCounter = (this._draftCounter + 1) % 1_000_000;
    return (Date.now() % 1_000_000_000) * 1000 + this._draftCounter;
  }

  async _flushGroupMessageLegacy(platform, chatId, sessionKey, line, meta, attachments, agentId) {
    const key = this._getPlatformKey(platform, agentId);
    const entry = this._platforms.get(key);
    if (!entry?.adapter) return;

    debugLog()?.log("bridge", `flush ${platform} group message (${line.length} chars)`);

    // typing indicator
    if (entry.adapter?.sendTypingIndicator) {
      entry.adapter.sendTypingIndicator(chatId).catch(() => {});
    }

 // 解析附件
    const { images, textNotes, inboundFiles } = await this._resolveAttachments(platform, attachments, agentId);
    const prompt = textNotes ? `${line}\n${textNotes}` : line;

    const tagged = `${timeTag()} ${prompt}`;
    try {
      let reply = await this._hub.send(tagged, {
        sessionKey,
        agentId,
        role: "guest",
        meta,
        isGroup: true,
        images: images.length ? images : undefined,
        inboundFiles: inboundFiles.length ? inboundFiles : undefined,
      });

 // __bridgeError 守卫（群聊路径之前缺失此棢查）
      if (typeof reply === "object" && reply.__bridgeError) {
        if (entry?.adapter) {
          const errMsg = `[Error] ${reply.message || "Unable to process message"}`;
          try { await this._sendAdapterReply(entry.adapter, chatId, errMsg); } catch {
            // Ignore bridge reply failures while surfacing the original error.
          }
        }
        return;
      }
      //
      let toolMedia = [];
      if (typeof reply === "object") {
        toolMedia = Array.isArray(reply.toolMedia) ? reply.toolMedia : [];
        reply = reply.text;
      }

      if (reply && entry?.adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
 //
        const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned);
        if (toolMedia.length) this._appendMediaItems(mediaUrls, toolMedia);
        const mediaItems = normalizeMediaItems(mediaUrls);
        if (textOnly.trim()) await this._sendAdapterReply(entry.adapter, chatId, textOnly);
        for (const item of mediaItems) {
          try { await this._sendMediaItem(entry.adapter, chatId, item, { platform, isGroup: true }); }
          catch (err) {
            debugLog()?.warn("bridge", `media send failed: ${err.message} (${this._describeMediaSource(item)})`);
            await this._mediaDelivery.sendFailureNotice(entry.adapter, chatId, err);
          }
        }
        debugLog()?.log("bridge", `→ ${platform} group reply (${cleaned.length} chars)`);
        const agentObj = this.engine.getAgent?.(agentId);
        const sender = agentObj?.agentName || this.engine.agentName;
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender, text: cleaned,
          isGroup: true, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        console.error(`[bridge] ${platform} group message handling failed:`, err.message);
        debugLog()?.error("bridge", `${platform} group message failed: ${err.message}`);
      }
    }
  }

  /**
  *
   */
  async _flushPendingLegacy(sessionKey) {
    const pending = this._pending.get(sessionKey);
    if (!pending || pending.lines.length === 0) return;

 // 防止并发触发
    if (this._processing.has(sessionKey)) return;

 // 取出所有缓冲消息和附件
    const lines = pending.lines.splice(0);
    const pendingAttachments = pending.attachments?.splice(0) || [];
    const { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId } = pending;
    this._pending.delete(sessionKey);

 // 解析附件
    const { images, textNotes, inboundFiles } = await this._resolveAttachments(platform, pendingAttachments, agentId);
    const prompt = textNotes ? `${lines.join("\n")}\n${textNotes}` : lines.join("\n");
    const merged = `${timeTag()} ${prompt}`;
    const meta = { name: senderName, avatarUrl, userId };

 // 如果 agent 正在 streaming，用 steer 注入而不是新-prompt
 // 但如果有图片附件，不-steer（Pi SDK 不支持往 streaming 中追加图片），等当前回复结束后正常处-
    if (!images.length && !inboundFiles.length && this.engine.steerBridgeSession(sessionKey, merged)) {
      debugLog()?.log("bridge", `steer ${platform} dm (${lines.length} msg(s))`);
      return;
    }

    this._processing.add(sessionKey);

 // typing indicator（Telegram 原生支持，其他平台忽略）
    {
      const _key = this._getPlatformKey(platform, agentId);
      const _adapter = this._platforms.get(_key)?.adapter;
      if (_adapter?.sendTypingIndicator) _adapter.sendTypingIndicator(chatId).catch(() => {});
    }

    debugLog()?.log("bridge", `flush ${platform} dm (${lines.length} msg(s), ${merged.length} chars${images.length ? `, ${images.length} image(s)` : ""})`);

    const platformKey = this._getPlatformKey(platform, agentId);
    const entry = this._platforms.get(platformKey);
    const adapter = entry?.adapter;

 //
    const canStream = !!adapter?.sendBlockReply && !isGroup;
    const useBlockStream = canStream && this.blockStreaming;
    const useDraft = canStream && !this.blockStreaming && !!adapter?.sendDraft;

    let cleaner = null;
    let chunker = null;
    let blockSentAny = false;
    let lastDraftTs = 0;
    let draftFailed = false;
    const THROTTLE = 500;

 //
    if (useBlockStream) {
      cleaner = new StreamCleaner();
      chunker = new BlockChunker({
        onFlush: async (text) => {
          blockSentAny = true;
          await adapter.sendBlockReply(chatId, text);
        },
      });
    }

    const onDelta = canStream ? (_delta) => {
      if (useBlockStream) {
        const inc = cleaner.feed(_delta);
        if (inc) chunker.feed(inc);
      } else if (useDraft) {
        if (draftFailed) return;
        if (!cleaner) cleaner = new StreamCleaner();
        cleaner.feed(_delta);
        const now = Date.now();
        if (now - lastDraftTs < THROTTLE) return;
        if (!cleaner.cleaned.trim()) return;
        lastDraftTs = now;
        adapter.sendDraft(chatId, cleaner.cleaned).catch(() => { draftFailed = true; });
      }
    } : undefined;

    try {
      let reply = await this._hub.send(merged, {
        sessionKey,
        agentId,
        role: isOwner ? "owner" : "guest",
        meta,
        isGroup: false,
        onDelta,
        images: images.length ? images : undefined,
        inboundFiles: inboundFiles.length ? inboundFiles : undefined,
      });

 // bridge-session 返回 error 标记时，发简短错误提示给用户
      if (reply && typeof reply === "object" && reply.__bridgeError) {
        if (adapter) {
          const errMsg = `[Error] ${reply.message || "Unable to process message"}`;
          try { await this._sendAdapterReply(adapter, chatId, errMsg); } catch {
            // Ignore bridge reply failures while surfacing the original error.
          }
        }
        reply = null;
      }

 //
      let toolMedia = [];
      if (reply && typeof reply === "object" && !reply.__bridgeError) {
        toolMedia = Array.isArray(reply.toolMedia) ? reply.toolMedia : [];
        reply = reply.text;
      }

      if (reply && adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        let allMediaUrls = [];

 //
        if (cleaner) {
          const tail = cleaner.flushLineBuf();
          if (tail) {
            cleaner.cleaned += tail;
            if (chunker) chunker.feed(tail);
          }
        }

        if (useBlockStream && chunker) {
          await chunker.finish();
          allMediaUrls = cleaner?.extractedMedia || [];
          if (!blockSentAny) {
            const textOnly = (cleaner?.cleaned || cleaned).trim();
            if (textOnly) await this._sendAdapterReply(adapter, chatId, textOnly);
          }
        } else if (useDraft && cleaner) {
 // draft 模式：用 cleaner.cleaned（已剥离媒体标记）发送最终文-
          allMediaUrls = cleaner.extractedMedia || [];
          const textOnly = cleaner.cleaned.trim();
          if (textOnly) {
            try { await adapter.sendDraft(chatId, textOnly); }
            catch { await this._sendAdapterReply(adapter, chatId, textOnly); }
          }
        } else {
 //
          const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned);
          allMediaUrls = mediaUrls;
          if (textOnly.trim()) await this._sendAdapterReply(adapter, chatId, textOnly);
        }

 //
        if (toolMedia.length) this._appendMediaItems(allMediaUrls, toolMedia);
        allMediaUrls = normalizeMediaItems(allMediaUrls);

 //
        for (const item of allMediaUrls) {
          try { await this._sendMediaItem(adapter, chatId, item, { platform, isGroup, agentId }); }
          catch (err) {
            debugLog()?.warn("bridge", `media send failed: ${err.message} (${this._describeMediaSource(item)})`);
            await this._mediaDelivery.sendFailureNotice(adapter, chatId, err);
          }
        }

        debugLog()?.log("bridge", `→ ${platform} reply (${cleaned.length} chars, mode: ${useBlockStream ? "block" : useDraft ? "draft" : "batch"}${allMediaUrls.length ? `, ${allMediaUrls.length} media` : ""})`);
        const agentObj = this.engine.getAgent?.(agentId);
        const sender = agentObj?.agentName || this.engine.agentName;
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender, text: cleaned,
          isGroup, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        console.error(`[bridge] ${platform} message handling failed:`, err.message);
        debugLog()?.error("bridge", `${platform} message handling failed: ${err.message}`);
      }
    } finally {
 //
      if (chunker) {
        try { await chunker.finish(); } catch {
          // Ignore trailing chunk flush failures during teardown.
        }
      }
      this._processing.delete(sessionKey);
    }

 // 处理期间可能又有新消息进来了，检查并重新 flush
    const newPending = this._pending.get(sessionKey);
    if (newPending && newPending.lines.length > 0) {
      if (newPending.timer) clearTimeout(newPending.timer);
      newPending.timer = setTimeout(() => this._flushPendingLegacy(sessionKey), 500);
    }
  }

  /**
  *
   */
  async _flushPending(sessionKey) {
    if (this._processing.has(sessionKey)) return;
    const batch = this._takePendingBatch(sessionKey);
    if (!batch || batch.lines.length === 0) return;
    this._processing.add(sessionKey);

    const { lines, attachments: pendingAttachments = [], platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId, messageThreadId, replyContext } = batch;
    let receiptDelivery = null;

    try {
      const { images, textNotes, inboundFiles } = await this._resolveAttachments(platform, pendingAttachments, agentId);
      const prompt = textNotes ? `${lines.join("\n")}\n${textNotes}` : lines.join("\n");
      const merged = `${timeTag()} ${prompt}`;
      const meta = { name: senderName, avatarUrl, userId };

      const rcState = this.engine.rcState;
      const rcAttachment = !isGroup && isOwner ? rcState?.getAttachment(sessionKey) : null;
      if (rcAttachment) {
        if (!(await this._desktopSessionStillExists(rcAttachment.desktopSessionPath))) {
          rcState?.detach(sessionKey);
          try {
            this.engine.emitEvent?.({
              type: "bridge_rc_detached",
              sessionKey,
              sessionPath: rcAttachment.desktopSessionPath,
            }, rcAttachment.desktopSessionPath);
          } catch {}
          const staleEntry = this._platforms.get(this._getPlatformKey(platform, agentId));
          try {
            await this._sendAdapterReply(staleEntry?.adapter, chatId, "接管已失效：目标桌面会话不存在，已自动退出 /rc", replyContext);
          } catch {}
          return;
        }
        await this._flushAttachedDesktopSession({
          sessionKey,
          desktopSessionPath: rcAttachment.desktopSessionPath,
          platform,
          chatId,
          agentId,
          text: prompt || (images.length ? "请查看图片" : ""),
          images,
          inboundFiles,
          messageThreadId,
          replyContext,
          alreadyLocked: true,
        });
        return;
      }

      const platformKey = this._getPlatformKey(platform, agentId);
      const entry = this._platforms.get(platformKey);
      const adapter = entry?.adapter;
      const delivery = this._createStreamDelivery({
        adapter,
        chatId,
        isGroup,
        platform,
        messageThreadId,
        replyContext,
      });

      if (!isGroup && !images.length && !inboundFiles.length && this.engine.steerBridgeSession(sessionKey, merged)) {
        debugLog()?.log("bridge", `steer ${platform} dm (${lines.length} msg(s))`);
        return;
      }

      receiptDelivery = await this._startLlmWaitingReceipt({
        platform,
        chatId,
        agentId,
        replyContext,
        isGroup,
      });

      debugLog()?.log("bridge", `flush ${platform} ${isGroup ? "group" : "dm"} (${lines.length} msg(s), ${merged.length} chars${images.length ? `, ${images.length} image(s)` : ""})`);

      let reply = await this._hub.send(merged, {
        sessionKey,
        agentId,
        role: isGroup ? "guest" : isOwner ? "owner" : "guest",
        meta,
        isGroup,
        onDelta: delivery.onDelta,
        images: images.length ? images : undefined,
        inboundFiles: inboundFiles.length ? inboundFiles : undefined,
      });

      if (reply && typeof reply === "object" && reply.__bridgeError) {
        if (adapter) {
          const errMsg = `[Error] ${reply.message || "Unable to process message"}`;
          try { await this._sendAdapterReply(adapter, chatId, errMsg, replyContext); } catch {}
        }
        reply = null;
      }

      let toolMedia = [];
      if (reply && typeof reply === "object" && !reply.__bridgeError) {
        toolMedia = Array.isArray(reply.toolMedia) ? reply.toolMedia : [];
        reply = reply.text;
      }

      if (reply && adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        let allMediaUrls = await delivery.finish(cleaned);

        if (toolMedia.length) this._appendMediaItems(allMediaUrls, toolMedia);
        allMediaUrls = normalizeMediaItems(allMediaUrls);

        for (const item of allMediaUrls) {
          try { await this._sendMediaItem(adapter, chatId, item, { platform, isGroup, agentId, replyContext }); }
          catch (err) {
            debugLog()?.warn("bridge", `media send failed: ${err.message} (${this._describeMediaSource(item)})`);
            await this._mediaDelivery.sendFailureNotice(adapter, chatId, err);
          }
        }

        debugLog()?.log("bridge", `→ ${platform} reply (${cleaned.length} chars, mode: ${delivery.mode}${allMediaUrls.length ? `, ${allMediaUrls.length} media` : ""})`);
        const agentObj = this.engine.getAgent?.(agentId);
        const sender = agentObj?.agentName || this.engine.agentName;
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender, text: cleaned,
          isGroup, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        console.error(`[bridge] ${platform} message handling failed:`, err.message);
        debugLog()?.error("bridge", `${platform} message handling failed: ${err.message}`);
      }
    } finally {
      try { await receiptDelivery?.stop?.(); } catch {}
      this._processing.delete(sessionKey);
    }

    const newPending = this._pending.get(sessionKey);
    if (newPending && ((newPending.kind === "group-queue" && newPending.batches.length > 0) || (newPending.kind !== "group-queue" && newPending.lines.length > 0))) {
      this._schedulePendingFlush(sessionKey, newPending.kind === "group-queue" ? 0 : 500);
    }
  }

  async _desktopSessionStillExists(sessionPath) {
    let hadAuthoritativeCheck = false;

    if (typeof this.engine?.listSessions === "function") {
      hadAuthoritativeCheck = true;
      const sessions = await this.engine.listSessions();
      if (sessions.some(session => session?.path === sessionPath)) return true;
    }

    if (typeof this.engine?.getSessionByPath === "function") {
      hadAuthoritativeCheck = true;
      if (this.engine.getSessionByPath(sessionPath)) return true;
    }

    if (typeof this.engine?.ensureSessionLoaded === "function") {
      hadAuthoritativeCheck = true;
      try {
        if (await this.engine.ensureSessionLoaded(sessionPath)) return true;
      } catch {
        return false;
      }
    }

    try {
      return fs.existsSync(sessionPath);
    } catch {
      return !hadAuthoritativeCheck;
    }
  }

  async _flushAttachedDesktopSession({ sessionKey, desktopSessionPath, platform, chatId, agentId, text, images, inboundFiles, messageThreadId, replyContext = null, alreadyLocked = false }) {
    if (!alreadyLocked) {
      if (this._processing.has(sessionKey)) return;
      this._processing.add(sessionKey);
    }

    const entry = this._platforms.get(this._getPlatformKey(platform, agentId));
    const adapter = entry?.adapter;
    const delivery = this._createStreamDelivery({
      adapter,
      chatId,
      isGroup: false,
      platform,
      messageThreadId,
      replyContext,
    });
    let receiptDelivery = null;

    debugLog()?.log("bridge", `rc-attached flush ${platform} (${text.length} chars -> ${desktopSessionPath})`);

    try {
      receiptDelivery = await this._startLlmWaitingReceipt({
        platform,
        chatId,
        agentId,
        replyContext,
        isGroup: false,
      });
      const displayMessage = {
        text,
        attachments: inboundFiles?.length ? undefined : images?.length
          ? images.map((img, idx) => ({
            path: `bridge-image-${idx}`,
            name: `bridge-image-${idx}.${(img.mimeType || "image/png").split("/")[1] || "png"}`,
            isDir: false,
            base64Data: img.data,
            mimeType: img.mimeType,
          }))
          : undefined,
      };
      const result = await this._hub.send(text, {
        sessionPath: desktopSessionPath,
        images: images?.length ? images : undefined,
        inboundFiles: inboundFiles?.length ? inboundFiles : undefined,
        displayMessage,
        uiContext: null,
        onDelta: delivery.onDelta,
      });
      const replyText = typeof result === "object" ? result?.text : result;
      const toolMedia = Array.isArray(result?.toolMedia) ? result.toolMedia : [];

      if (replyText && adapter) {
        const cleaned = this._cleanReplyForPlatform(replyText);
        let allMediaUrls = await delivery.finish(cleaned);
        if (toolMedia.length) this._appendMediaItems(allMediaUrls, toolMedia);
        allMediaUrls = normalizeMediaItems(allMediaUrls);

        for (const item of allMediaUrls) {
          try { await this._sendMediaItem(adapter, chatId, item, { platform, isGroup: false, agentId, replyContext }); }
          catch (err) {
            debugLog()?.warn("bridge", `rc-attached media send failed: ${err.message} (${this._describeMediaSource(item)})`);
            await this._mediaDelivery.sendFailureNotice(adapter, chatId, err);
          }
        }

        const agentObj = this.engine.getAgent?.(agentId);
        const sender = agentObj?.agentName || this.engine.agentName;
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender, text: cleaned,
          isGroup: false, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        const errMsg = err.message === "session_busy"
          ? "当前桌面会话仍在回复中，请稍后再试"
          : err.message;
        console.error(`[bridge] rc-attached prompt failed (${platform}, ${desktopSessionPath}):`, errMsg);
        debugLog()?.error("bridge", `rc-attached failed: ${errMsg}`);
        if (adapter) {
          try { await this._sendAdapterReply(adapter, chatId, `[Error] ${errMsg}`, replyContext); } catch {}
        }
      }
    } finally {
      try { await receiptDelivery?.stop?.(); } catch {}
      if (!alreadyLocked) this._processing.delete(sessionKey);
    }

    const newPending = this._pending.get(sessionKey);
    if (!alreadyLocked && newPending && ((newPending.kind === "group-queue" && newPending.batches.length > 0) || (newPending.kind !== "group-queue" && newPending.lines.length > 0))) {
      this._schedulePendingFlush(sessionKey, newPending.kind === "group-queue" ? 0 : 500);
    }
  }

  async _handleRcMirrorEvent(event, sessionPath) {
    if (!event || !sessionPath) return;

    if (event.type === "session_user_message") {
      const source = event.message?.source || "desktop";
      if (source === "bridge_rc") return;
      const target = this._resolveRcMirrorTarget(sessionPath);
      if (!target) return;

      const text = String(event.message?.text || "").trim();
      const attachments = Array.isArray(event.message?.attachments) ? event.message.attachments : [];
      const userLine = text ? `电脑端用户：${text}` : "电脑端用户发送了文件";
      await this._sendAdapterReply(target.adapter, target.chatId, userLine);
      this._pushMessage({
        platform: target.platform,
        direction: "out",
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        sender: target.sender,
        text: userLine,
        isGroup: false,
        ts: Date.now(),
      });

      for (const item of this._mediaItemsFromDesktopAttachments(attachments, sessionPath)) {
        try { await this._sendMediaItem(target.adapter, target.chatId, item, { platform: target.platform, isGroup: false, agentId: target.agentId }); }
        catch (err) {
          debugLog()?.warn("bridge", `rc mirror media send failed: ${err.message}`);
          await this._mediaDelivery.sendFailureNotice(target.adapter, target.chatId, err);
        }
      }

      const delivery = this._createStreamDelivery({
        adapter: target.adapter,
        chatId: target.chatId,
        isGroup: false,
        platform: target.platform,
        messageThreadId: target.messageThreadId,
      });
      this._rcMirrorStreams.set(sessionPath, {
        ...target,
        delivery,
        text: "",
        toolMedia: [],
      });
      return;
    }

    const state = this._rcMirrorStreams.get(sessionPath);
    if (!state) return;

    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") {
        const delta = sub.delta || "";
        state.text += delta;
        try { state.delivery.onDelta?.(delta, state.text); } catch {}
      }
      return;
    }

    if (event.type === "tool_execution_end" && !event.isError) {
      state.toolMedia.push(...collectMediaItems(event.result?.details?.media));
      const card = event.result?.details?.card;
      if (card?.description) {
        state.text += (state.text ? "\n\n" : "") + card.description;
      }
      const settingsUpdateText = formatSettingsUpdateText(event.result?.details?.settingsUpdate);
      if (settingsUpdateText) {
        state.text += (state.text ? "\n\n" : "") + settingsUpdateText;
      }
      return;
    }

    if (event.type === "session_status" && event.isStreaming === false) {
      this._rcMirrorStreams.delete(sessionPath);
      const cleaned = this._cleanReplyForPlatform(state.text || "");
      if (!cleaned) return;

      let allMediaItems = await state.delivery.finish(cleaned);
      if (state.toolMedia.length) this._appendMediaItems(allMediaItems, state.toolMedia);
      allMediaItems = normalizeMediaItems(allMediaItems);

      for (const item of allMediaItems) {
        try { await this._sendMediaItem(state.adapter, state.chatId, item, { platform: state.platform, isGroup: false, agentId: state.agentId }); }
        catch (err) {
          debugLog()?.warn("bridge", `rc mirror assistant media send failed: ${err.message}`);
          await this._mediaDelivery.sendFailureNotice(state.adapter, state.chatId, err);
        }
      }

      this._pushMessage({
        platform: state.platform,
        direction: "out",
        sessionKey: state.sessionKey,
        agentId: state.agentId,
        sender: state.sender,
        text: cleaned,
        isGroup: false,
        ts: Date.now(),
      });
    }
  }

  _resolveRcMirrorTarget(sessionPath) {
    const rcState = this.engine?.rcState;
    const sessionKey = rcState?.getAttachedBridgeSessionKey?.(sessionPath);
    if (!sessionKey) return null;
    const attachment = rcState.getAttachment?.(sessionKey) || {};
    const platform = attachment.platform || this._platformFromSessionKey(sessionKey);
    const agentId = attachment.agentId || this._extractAgentIdFromSessionKey(sessionKey);
    const entry = this._platforms.get(this._getPlatformKey(platform, agentId));
    const adapter = entry?.adapter;
    if (!adapter) return null;
    const chatId = attachment.chatId || this._chatIdFromBridgeSessionKey(sessionKey);
    if (!chatId) return null;
    const agentObj = this.engine.getAgent?.(agentId);
    return {
      sessionKey,
      platform,
      agentId,
      chatId,
      adapter,
      messageThreadId: attachment.messageThreadId || null,
      sender: agentObj?.agentName || this.engine.agentName,
    };
  }

  _mediaItemsFromDesktopAttachments(attachments, sessionPath) {
    return (attachments || []).map((attachment) => {
      if (attachment?.fileId) {
        return {
          type: "session_file",
          fileId: attachment.fileId,
          sessionPath,
          filePath: attachment.path,
          filename: attachment.name || (attachment.path ? path.basename(attachment.path) : undefined),
          label: attachment.name,
          mime: attachment.mimeType,
          kind: attachment.kind,
        };
      }
      if (attachment?.path && path.isAbsolute(attachment.path)) {
        return { type: "legacy_local_path", filePath: attachment.path };
      }
      return null;
    }).filter(Boolean);
  }

  _platformFromSessionKey(sessionKey) {
    const match = /^([a-z]+)_/i.exec(sessionKey || "");
    return match ? match[1] : "bridge";
  }

  _chatIdFromBridgeSessionKey(sessionKey) {
    const withoutAgent = String(sessionKey || "").split("@")[0] || "";
    const match = /^[a-z]+_(?:dm|group)_(.+)$/i.exec(withoutAgent);
    return match ? match[1] : null;
  }

  async _sendMediaItem(adapter, chatId, source, context = {}) {
    this._refreshMediaAllowedRoots(context.agentId || null);
    const replyContext = this._normalizeReplyContext({
      ...(context.replyContext || {}),
      ...this._replyContextForPlatform(context.platform, context.messageThreadId),
    }) || {};
    return this._sendWithDeadLetter({
      adapter,
      chatId,
      kind: "media",
      payload: { mediaItem: source },
      replyContext,
      send: () => this._mediaDelivery.send({
        adapter,
        chatId,
        platform: context.platform,
        isGroup: context.isGroup,
        replyContext: Object.keys(replyContext).length ? replyContext : undefined,
        mediaItem: source,
      }),
    });
  }

  _replyContextForPlatform(platform, messageThreadId) {
    if (platform !== "telegram" || !messageThreadId) return {};
    return { messageThreadId };
  }

  _appendMediaItems(target, items) {
    if (!Array.isArray(target)) return target;
    const merged = normalizeMediaItems([...(target || []), ...(items || [])]);
    target.length = 0;
    for (const item of merged) target.push(item);
    return target;
  }

  _describeMediaSource(item) {
    return this._mediaDelivery?.describe?.(item) || mediaItemKey(item);
  }

 /** */
  _isOwner(platform, userId, agentId, opts = {}) {
 // 微信 iLink 是私人协议，所有 DM 消息都来自 owner
    const agent = agentId ? this.engine.getAgent(agentId) : null;
    return isBridgeOwner({
      platform,
      chatType: opts.isGroup ? "group" : "dm",
      userId,
      agent,
    });
  }

  /**
 * 清理发给外部平台的回复（batch 模式兜底，流式由 StreamCleaner 处理）：
 * - 去除 mood/pulse/reflect 区块（backtick -XML 两种格式- * - 去除 <think>/<thinking> 标签
    *
   */
  _cleanReplyForPlatform(text) {
    return stripInternalTags(text);
  }


  /**
  *
 * @param {string} text - 要发送的文本（会自动 clean mood/pulse 标签- * @returns {{ platform: string, chatId: string } | null} 发成功返回平台信息，失败返回 null
   */
  async sendProactive(text, targetAgentId, opts = {}) {
    const cleaned = this._cleanReplyForPlatform(text);
    if (!cleaned) return null;
    const contextPolicy = opts.contextPolicy || "record_when_delivered";
    const { bridgePlatforms, invalidBridgePlatforms } = normalizeBridgePlatforms(opts.bridgePlatforms);
    if (invalidBridgePlatforms.length) {
      throw new Error(`unsupported bridge platform: ${invalidBridgePlatforms.join(", ")}`);
    }
    const platformEntries = [...this._platforms.values()];
    const deliveryEntries = bridgePlatforms.length
      ? bridgePlatforms.flatMap((platform) => platformEntries.filter((entry) => entry.platform === platform))
      : platformEntries;

    for (const entry of deliveryEntries) {
      if (entry.status !== "connected" || !entry.adapter) continue;
      const platform = entry.platform;
      if (!platform) continue;
      if (targetAgentId && entry.agentId !== targetAgentId) continue;
      if (!entry.agentId) {
        debugLog()?.log("bridge", `→ ${platform} skipped proactive (missing agent binding)`);
        continue;
      }

      const entryAgentId = entry.agentId;
      const agent = entryAgentId ? this.engine.getAgent(entryAgentId) : null;
      const ownerTarget = resolveBridgeOwnerDeliveryTarget({
        platform,
        agent,
        index: this._readBridgeIndex(entryAgentId, agent),
      });
      const ownerId = ownerTarget?.userId;
      if (!ownerId) continue;

      const chatId = entry.adapter.resolveOwnerChatId?.(ownerId) || ownerTarget.chatId;

      if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
        debugLog()?.log("bridge", `→ ${platform} skipped proactive (no reply context for ${chatId})`);
        continue;
      }

      const spec = ADAPTER_REGISTRY[platform];
      try {
        await this._sendAdapterReply(entry.adapter, chatId, cleaned);
        debugLog()?.log("bridge", `→ ${platform} proactive to owner (${cleaned.length} chars)`);

        const sessionKey = ownerTarget.sessionKey || spec?.ownerSessionKey?.(ownerId, entryAgentId) || `${platform}_dm_${ownerId}@${entryAgentId}`;
        const sender = agent?.agentName || this.engine.agentName;
        let recorded = false;
        if (contextPolicy === "record_when_delivered") {
          try {
            recorded = this.engine.bridgeSessionManager?.recordAssistantMessage?.(
              sessionKey,
              cleaned,
              {
                agentId: entryAgentId,
                createIfMissing: true,
                meta: {
                  userId: ownerId,
                  chatId,
                },
              },
            ) === true;
          } catch (err) {
            debugLog()?.warn("bridge", `proactive context record failed (${platform}): ${err.message}`);
          }
        }
        this._pushMessage({
          platform, direction: "out", sessionKey, agentId: entryAgentId,
          sender, text: cleaned,
          isGroup: false, ts: Date.now(),
        });

        return { platform, chatId, sessionKey, recorded };
      } catch (err) {
        console.error(`[bridge] proactive send failed (${platform}): ${err.message}`);
        debugLog()?.error("bridge", `proactive send failed (${platform}): ${err.message}`);
      }
    }

    return null;
  }

  _readBridgeIndex(agentId, agent) {
    try {
      if (typeof this.engine.getBridgeIndex === "function") {
        return this.engine.getBridgeIndex(agentId);
      }
    } catch {}
    try {
      return this.engine.bridgeSessionManager?.readIndex?.(agent) || {};
    } catch {}
    return {};
  }

  /**
 * 从桌面端发本地文件到 bridge 平台
   * @param {string} platform
   * @param {string} chatId
 * @param {string} filePath - 已校验过安全性的本地文件路径
   */
  async sendMediaFile(platform, chatId, filePath, agentId) {
    return this.sendMediaItem(platform, chatId, { type: "legacy_local_path", filePath }, agentId);
  }

 /** */
  async sendMediaItem(platform, chatId, mediaItem, agentId) {
    const entry = this._findPlatformEntry(platform, agentId);
    if (!entry?.adapter) throw new Error(`platform ${platform} not connected`);

    if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
      throw new Error(`${platform}: 需要对方最近发过消息后才能发送文件`);
    }

    await this._sendMediaItem(entry.adapter, chatId, mediaItem, { platform });
  }

  async sendTextMessage(platform, chatId, text, agentId, opts = {}) {
    const cleaned = this._cleanReplyForPlatform(text || "");
    if (!cleaned) throw new Error("bridge text is empty");
    const entry = this._findPlatformEntry(platform, agentId);
    if (!entry?.adapter || entry.status !== "connected") {
      throw new Error(`platform ${platform} not connected`);
    }

    if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
      throw new Error(`${platform}: 需要对方最近发过消息后才能发送消息`);
    }

    await this._sendAdapterReply(entry.adapter, chatId, cleaned, opts.replyContext);
    const sessionKey = opts.sessionKey || `${platform}_group_${chatId}${agentId ? `@${agentId}` : ""}`;
    const agentObj = this.engine.getAgent?.(agentId);
    const sender = opts.sender || agentObj?.agentName || this.engine.agentName;
    this._pushMessage({
      platform,
      direction: "out",
      sessionKey,
      agentId: agentId || entry.agentId || null,
      sender,
      text: cleaned,
      isGroup: opts.isGroup !== false,
      ts: Date.now(),
    });
    return { platform, chatId, sessionKey };
  }

  _emitStatus(platform, status, error, agentId, errorType = null, errorDetail = null) {
    this._hub.eventBus.emit(
      {
        type: "bridge_status",
        platform,
        status,
        error: error || null,
        errorType: errorType || null,
        errorDetail: errorDetail || null,
        agentId: agentId || null,
      },
      null,
    );
  }

 /** 记录消息并广播到前端（per-agent buffer-*/
  _pushMessage(entry) {
    // Determine agentId from the entry or from the sessionKey @suffix
    const agentId = entry.agentId || this._extractAgentIdFromSessionKey(entry.sessionKey) || '_global';
    if (entry.platform && agentId !== "_global") {
      this._recordPlatformSync(entry.platform, agentId);
    }
    const reliabilityItem = this._reliability.recordMessage({
      ...entry,
      agentId: agentId === "_global" ? null : agentId,
      chatId: entry.chatId || this._chatIdFromBridgeSessionKey(entry.sessionKey),
      channelId: entry.sessionKey,
    });
    const emittedEntry = {
      ...entry,
      agentId,
      id: entry.id || reliabilityItem.id,
      status: entry.status || reliabilityItem.status,
      statusVersion: reliabilityItem.statusVersion || 1,
      textPreview: reliabilityItem.textPreview || null,
    };
    if (!this._messageLogs.has(agentId)) this._messageLogs.set(agentId, []);
    const log = this._messageLogs.get(agentId);
    log.push(emittedEntry);
    if (log.length > this._messageLogMax) log.shift();
    this._hub.eventBus.emit(
      { type: "bridge_message", message: emittedEntry },
      null,
    );
  }

 /** */
  _extractAgentIdFromSessionKey(sessionKey) {
    if (!sessionKey) return null;
    const atIdx = sessionKey.lastIndexOf('@');
    return atIdx !== -1 ? sessionKey.slice(atIdx + 1) : null;
  }

 /** */
  getMessages(limit = 50, agentId = null) {
    if (agentId) {
      const log = this._messageLogs.get(agentId) || [];
      return log.slice(-limit);
    }
    // No filter: merge all logs (backward compat)
    const all = [];
    for (const log of this._messageLogs.values()) all.push(...log);
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return all.slice(-limit);
  }

  getDeliveryRecords(options = {}) {
    return this._reliability.listDeliveries(options);
  }

  getReliabilityRecords(options = {}) {
    return this._reliability.listMessages(options);
  }
}
