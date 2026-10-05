/**
 * WhatsApp Web bridge adapter.
 *
 * Uses whatsapp-web.js + a local Chrome/Edge executable. Auth state is stored
 * under G-SAP data/bridge/whatsapp, so users only need to scan once.
 */
import fs from "fs";
import path from "path";
import os from "os";
import qrcode from "qrcode";
import { debugLog } from "../debug-log.ts";

export const WHATSAPP_ADAPTER_VERSION = "whatsapp-web.js";

function findBrowserExecutable() {
  const envPath = process.env.GSAP_WHATSAPP_CHROME
    || process.env.GSAP_WHATSAPP_CHROME
    || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    return candidates.find((p) => p && fs.existsSync(p)) || null;
  }

  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }

  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function normalizeContactId(id) {
  return String(id || "").replace(/@c\.us$|@g\.us$/, "");
}

function attachmentType(mime = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function classifyWhatsAppError(error) {
  const detail = String(error || "").trim();
  const lower = detail.toLowerCase();

  if (
    lower.includes("chrome/edge")
    || lower.includes("browser path")
    || lower.includes("executable")
    || lower.includes("failed to launch the browser process")
    || lower.includes("spawn")
  ) {
    return { type: "browser_missing", detail };
  }

  if (
    lower.includes("err_connection_timed_out")
    || lower.includes("err_aborted")
    || lower.includes("navigation timeout")
    || lower.includes("timed out")
    || lower.includes("proxyblock")
    || lower.includes("name_not_resolved")
    || lower.includes("internet_disconnected")
  ) {
    return { type: "network_timeout", detail };
  }

  if (
    lower.includes("conflict")
    || lower.includes("another browser")
    || lower.includes("takeover")
    || lower.includes("already logged")
    || lower === "logout"
  ) {
    return { type: "session_conflict", detail };
  }

  return { type: "unknown", detail };
}

export function createWhatsAppAdapter({ hanaHome, agentId, onMessage, onStatus }) {
  let client = null;
  let MessageMediaCtor = null;
  let ready = false;
  let qrText = "";
  let qrDataUrl = "";
  let initError = null;
  let lastErrorType = null;
  let lastErrorDetail = null;
  let readyPromise = Promise.resolve();

  const dataPath = path.join(hanaHome || path.join(os.homedir(), ".gsap"), "bridge", "whatsapp");
  const clientId = `g-sap-${agentId || "default"}`.replace(/[^\w-]/g, "_");

  async function init() {
    try {
      onStatus?.("connecting");
      lastErrorType = null;
      lastErrorDetail = null;
      const executablePath = findBrowserExecutable();
      if (!executablePath) {
        throw new Error("未找到 Chrome/Edge。请安装 Chrome 或设置 GSAP_WHATSAPP_CHROME 指向浏览器路径。");
      }

      const imported = await import("whatsapp-web.js");
      const mod = imported.default || imported;
      const { Client, LocalAuth, MessageMedia } = mod;
      if (typeof Client !== "function" || typeof LocalAuth !== "function") {
        throw new Error("whatsapp-web.js 导入失败：Client 或 LocalAuth 不可用");
      }
      MessageMediaCtor = MessageMedia;

      client = new Client({
        authStrategy: new LocalAuth({ clientId, dataPath }),
        authTimeoutMs: 45_000,
        qrMaxRetries: 3,
        takeoverOnConflict: true,
        puppeteer: {
          headless: true,
          executablePath,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
          ],
        },
      });

      client.on("qr", async (qr) => {
        qrText = qr;
        qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 256 });
        lastErrorType = null;
        lastErrorDetail = null;
        onStatus?.("qr", null);
        debugLog()?.log("bridge", "[whatsapp] QR ready");
      });

      client.on("authenticated", () => {
        lastErrorType = null;
        lastErrorDetail = null;
        onStatus?.("connecting");
        debugLog()?.log("bridge", "[whatsapp] authenticated");
      });

      client.on("ready", () => {
        ready = true;
        qrText = "";
        qrDataUrl = "";
        lastErrorType = null;
        lastErrorDetail = null;
        onStatus?.("connected");
        debugLog()?.log("bridge", "[whatsapp] ready");
      });

      client.on("auth_failure", (message) => {
        ready = false;
        initError = message || "auth_failure";
        const classified = classifyWhatsAppError(initError);
        lastErrorType = classified.type;
        lastErrorDetail = classified.detail;
        onStatus?.("error", initError, classified.type, classified.detail);
      });

      client.on("disconnected", (reason) => {
        ready = false;
        const classified = classifyWhatsAppError(reason || "");
        lastErrorType = classified.type;
        lastErrorDetail = classified.detail;
        if (classified.type === "session_conflict") {
          onStatus?.("error", reason || null, classified.type, classified.detail);
          return;
        }
        onStatus?.("disconnected", reason || null, classified.type, classified.detail);
      });

      client.on("message", async (msg) => {
        try {
          if (msg.fromMe) return;
          const chat = await msg.getChat().catch(() => null);
          const contact = await msg.getContact().catch(() => null);
          const isGroup = !!chat?.isGroup;
          const userId = normalizeContactId(msg.author || msg.from);
          const chatId = msg.from;
          const sessionKey = isGroup
            ? `wa_group_${chatId}@${agentId}`
            : `wa_dm_${userId}@${agentId}`;

          const attachments = [];
          if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media?.data) {
              const buffer = Buffer.from(media.data, "base64");
              attachments.push({
                type: attachmentType(media.mimetype),
                mimeType: media.mimetype,
                filename: media.filename || msg._data?.filename || "whatsapp-media",
                size: buffer.length,
                _prefetched: buffer,
              });
            }
          }

          onMessage({
            platform: "whatsapp",
            agentId,
            chatId,
            userId,
            sessionKey,
            text: msg.body || "",
            senderName: contact?.pushname || contact?.name || contact?.number || userId,
            avatarUrl: await contact?.getProfilePicUrl?.().catch(() => null),
            isGroup,
            attachments: attachments.length ? attachments : undefined,
          });
        } catch (err) {
          debugLog()?.error("bridge", `[whatsapp] inbound failed: ${err.message}`);
        }
      });

      await client.initialize();
    } catch (err) {
      ready = false;
      initError = err.message || String(err);
      const classified = classifyWhatsAppError(initError);
      lastErrorType = classified.type;
      lastErrorDetail = classified.detail;
      onStatus?.("error", initError, classified.type, classified.detail);
      debugLog()?.error("bridge", `[whatsapp] init failed: ${initError}`);
    }
  }

  readyPromise = init();

  async function ensureReady() {
    await readyPromise;
    if (!ready || !client) throw new Error(initError || "WhatsApp is not connected");
  }

  return {
    capabilities: { proactive: true },

    getStatus() {
      return {
        adapterVersion: WHATSAPP_ADAPTER_VERSION,
        qrcode: qrText || "",
        qrcodeUrl: qrDataUrl || "",
        authenticated: ready,
        ready,
        errorType: lastErrorType,
        errorDetail: lastErrorDetail,
      };
    },

    resolveOwnerChatId(userId) {
      if (!userId) return userId;
      if (String(userId).includes("@")) return userId;
      return `${userId}@c.us`;
    },

    async sendReply(chatId, text) {
      await ensureReady();
      await client.sendMessage(chatId, text);
    },

    async sendBlockReply(chatId, text) {
      await this.sendReply(chatId, text);
    },

    async sendTypingIndicator(chatId) {
      await readyPromise;
      if (!client) return;
      const chat = await client.getChatById(chatId).catch(() => null);
      await chat?.sendStateTyping?.().catch(() => {});
      setTimeout(() => chat?.clearState?.().catch(() => {}), 2500);
    },

    async sendMedia(chatId, url) {
      await ensureReady();
      const media = await MessageMediaCtor.fromUrl(url, { unsafeMime: true });
      await client.sendMessage(chatId, media);
    },

    async sendMediaBuffer(chatId, buffer, { mime, filename }) {
      await ensureReady();
      const media = new MessageMediaCtor(mime || "application/octet-stream", buffer.toString("base64"), filename || "file");
      await client.sendMessage(chatId, media);
    },

    async downloadImage(_platformRef, _messageId) {
      return null;
    },

    async downloadFile(_messageId, _platformRef) {
      return null;
    },

    async stop() {
      ready = false;
      try { await client?.destroy?.(); } catch {}
    },
  };
}
