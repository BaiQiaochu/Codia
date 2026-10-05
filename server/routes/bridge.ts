// @ts-nocheck
/**
 * bridge.js — 外部平台接入 REST API
 *
 * 管理 Telegram / 飞书 / QQ 等外部消息平台的连接。
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { debugLog } from "../../lib/debug-log.ts";
import { parseSessionKey, collectKnownUsers, KNOWN_PLATFORMS } from "../../lib/bridge/session-key.ts";
import { isBridgeOwner, resolveBridgeOwnerUserId } from "../../lib/bridge/owner-policy.ts";
import { collectBridgeMediaAllowedRoots, isInsideBridgeMediaRoot } from "../../lib/bridge/media-roots.ts";
import { getBridgeCapabilityMatrix } from "../../lib/bridge/capability-matrix.ts";
import { defaultAgentlyMailCliService } from "../../lib/bridge/agently-mail.ts";
import TelegramBot from "../../lib/bridge/telegram-client.ts";
import { DINGTALK_BOT_CALLBACK_TOPIC, DINGTALK_STREAM_OPEN_URL } from "../../lib/bridge/dingtalk-adapter.ts";
import { t } from "../../lib/i18n.ts";
import { resolveAgent, resolveAgentStrict } from "../utils/resolve-agent.ts";
import { collectSecretPatchPaths, isMaskedSecretValue, maskSecretValue, resolveSecretPatch } from "../../shared/secret-custody.ts";
import {
  SESSION_PERMISSION_MODES,
  normalizeBridgePermissionMode,
} from "../../core/session-permission-mode.ts";
import { denySecretMutationWithoutScope, denyWithoutScope } from "../http/capability-guard.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";

const RECENT_SYNC_WINDOW_MS = 5 * 60 * 1000;
const MAX_BRIDGE_MEDIA_SIZE = 50 * 1024 * 1024;
const FEISHU_TENANT_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";

function resolveBridgeManager(value: any) {
  return typeof value?.get === "function" ? value.get() : value;
}

async function loadWechatLogin() {
  return await import("../../lib/bridge/wechat-login.ts");
}

function feishuLongConnectionInfo() {
  return {
    eventDelivery: "long_connection",
    callbackUrlRequired: false,
    longConnection: {
      status: "not_tested",
      reason: "bridge/test validates credentials only; runtime status is reported after the connector is enabled.",
    },
  };
}

function feishuTestInfo({ credentialOk, response, data }: any = {}) {
  const logId = data?.error?.log_id || data?.log_id || null;
  return {
    credentialOk,
    ...feishuLongConnectionInfo(),
    ...(response ? { httpStatus: response.status } : {}),
    ...(data?.code !== undefined ? { feishuCode: data.code } : {}),
    ...(data?.msg ? { feishuMessage: data.msg } : {}),
    ...(logId ? { logId } : {}),
  };
}

function dingTalkLongConnectionInfo() {
  return {
    eventDelivery: "long_connection",
    callbackUrlRequired: false,
    longConnection: {
      status: "not_tested",
      reason: "bridge/test validates DingTalk Stream registration only; runtime status is reported after the connector is enabled.",
    },
  };
}

function buildSyncState(lastSyncAt: any) {
  if (!lastSyncAt) return "never";
  return Date.now() - lastSyncAt <= RECENT_SYNC_WINDOW_MS ? "recent" : "idle";
}

function buildAdapterStatus(liveStatus: any = {}) {
  return {
    platform: liveStatus.platform || null,
    agentId: liveStatus.agentId || null,
    version: liveStatus.adapterVersion || liveStatus.version || null,
    statusAt: liveStatus.lastStatusAt ?? null,
  };
}

function normalizeBridgeError(errorType: any, error: any) {
  if (errorType === "browser_missing") return t("settings.bridge.whatsappErrorBrowserMissing");
  if (errorType === "network_timeout") return t("settings.bridge.whatsappErrorNetworkTimeout");
  if (errorType === "session_conflict") return t("settings.bridge.whatsappErrorSessionConflict");
  if (errorType === "session_expired" || error === "session_expired") return t("settings.bridge.wechatErrorSessionExpired");
  return error || null;
}

function pushDiagnosis(diagnose: any[], text: any) {
  if (text && !diagnose.includes(text)) diagnose.push(text);
}

function bridgeCopy(key: any, fallback: any) {
  const value = t(key);
  return value === key ? fallback : value;
}

function buildPlatformDiagnostics(platform: any, cfg: any = {}, live: any = {}) {
  const diagnose = [];
  const errorText = normalizeBridgeError(live.errorType, live.error);

  if (platform === "telegram") {
    if (!cfg?.token) {
      pushDiagnosis(diagnose, bridgeCopy("settings.bridge.telegramDiagMissingCredentials", "Telegram is missing Bot Token and cannot connect."));
      return diagnose;
    }
    pushDiagnosis(diagnose, bridgeCopy("settings.bridge.telegramDiagReady", "Telegram credentials are present and ready for reconnect."));
    if (live.status === "connected") pushDiagnosis(diagnose, bridgeCopy("settings.bridge.telegramDiagConnected", "The Telegram bridge is connected."));
    if (errorText) pushDiagnosis(diagnose, errorText);
  }

  if (platform === "feishu") {
    const hasCredentials = !!(cfg?.appId && cfg?.appSecret);
    if (!hasCredentials) {
      pushDiagnosis(diagnose, bridgeCopy("settings.bridge.feishuDiagMissingCredentials", "Feishu is missing App ID or App Secret and cannot connect."));
      return diagnose;
    }
    pushDiagnosis(diagnose, bridgeCopy("settings.bridge.feishuDiagReady", "Feishu credentials are present and ready for reconnect."));
    if (live.status === "connected") pushDiagnosis(diagnose, bridgeCopy("settings.bridge.feishuDiagConnected", "The Feishu bridge is connected."));
    if (errorText) pushDiagnosis(diagnose, errorText);
  }

  if (platform === "dingtalk") {
    const hasCredentials = !!(cfg?.clientId && cfg?.clientSecret && cfg?.robotCode);
    if (!hasCredentials) {
      pushDiagnosis(diagnose, bridgeCopy("settings.bridge.dingtalkDiagMissingCredentials", "钉钉缺少客户端 ID、客户端密钥或机器人编码，无法连接。"));
      return diagnose;
    }
    pushDiagnosis(diagnose, bridgeCopy("settings.bridge.dingtalkDiagReady", "DingTalk credentials are present and ready for reconnect."));
    if (live.status === "connected") pushDiagnosis(diagnose, bridgeCopy("settings.bridge.dingtalkDiagConnected", "The DingTalk bridge is connected."));
    if (errorText) pushDiagnosis(diagnose, errorText);
  }

  if (platform === "wechat") {
    if (!cfg?.botToken) {
      pushDiagnosis(diagnose, t("settings.bridge.wechatDiagNeedScan"));
      return diagnose;
    }
    pushDiagnosis(diagnose, t("settings.bridge.wechatDiagReady"));
    if (live.status === "connected") pushDiagnosis(diagnose, t("settings.bridge.wechatDiagConnected"));
    if (live.error === "session_expired" || live.errorType === "session_expired") {
      pushDiagnosis(diagnose, t("settings.bridge.wechatDiagSessionExpired"));
    } else if (errorText) {
      pushDiagnosis(diagnose, errorText);
    }
  }

  if (platform === "whatsapp") {
    if (!cfg?.enabled) {
      pushDiagnosis(diagnose, t("settings.bridge.whatsappDiagNotEnabled"));
      return diagnose;
    }
    if (live.status === "qr") pushDiagnosis(diagnose, t("settings.bridge.whatsappScanning"));
    if (live.status === "connected") pushDiagnosis(diagnose, t("settings.bridge.whatsappDiagConnected"));
    if (errorText) pushDiagnosis(diagnose, errorText);
  }

  if (platform === "qq") {
    const hasCredentials = !!(cfg?.appID && (cfg?.appSecret || cfg?.token));
    if (!hasCredentials) {
      pushDiagnosis(diagnose, t("settings.bridge.qqDiagMissingCredentials"));
      return diagnose;
    }
    pushDiagnosis(diagnose, t("settings.bridge.qqDiagReady"));
    if (live.status === "connected") pushDiagnosis(diagnose, t("settings.bridge.qqDiagConnected"));
    if (errorText) pushDiagnosis(diagnose, errorText);
  }

  if (platform === "agentlyMail") {
    if (!cfg?.email) {
      pushDiagnosis(diagnose, t("settings.bridge.agentlyMailDiagNeedAuth"));
      return diagnose;
    }
    pushDiagnosis(diagnose, t("settings.bridge.agentlyMailDiagReady"));
    if (live.status === "connected") pushDiagnosis(diagnose, t("settings.bridge.agentlyMailDiagConnected"));
    if (errorText) pushDiagnosis(diagnose, errorText);
  }

  if (live.status === "connected" && !live.lastSyncAt) {
    pushDiagnosis(diagnose, t("settings.bridge.diagNoSyncYet"));
  }

  return diagnose;
}

async function waitForBridgePlatform(bridgeManager, agentId, platform, timeoutMs = 4000) {
  const startedAt = Date.now();
  let current = bridgeManager.getStatus(agentId)?.[platform] || null;

  while (Date.now() - startedAt < timeoutMs) {
    current = bridgeManager.getStatus(agentId)?.[platform] || null;
    if (
      current
      && (
        current.status === "connected"
        || current.status === "qr"
        || current.status === "error"
        || current.error
        || current.qrcodeUrl
        || current.authenticated
      )
    ) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return bridgeManager.getStatus(agentId)?.[platform] || current || {};
}


export function createBridgeRoute(engine: any, bridgeManager: any, options: any = {}) {
  const route = new Hono<any>();
  bridgeManager = resolveBridgeManager(bridgeManager);
  const agentlyMail = options.agentlyMail || defaultAgentlyMailCliService;

  /** 获取所有平台连接状态（从 agent.config.bridge 读取） */
  route.get("/bridge/status", async (c) => {
    const agent = resolveAgent(engine, c);
    const live = bridgeManager.getStatus(agent.id);
    const bridge = agent.config?.bridge || {};
    const capabilityMatrix = getBridgeCapabilityMatrix();

    const platformStatus = (plat, cfg, extraFields) => {
      const liveStatus = live[plat] || {};
      return {
        ...extraFields,
        capabilities: capabilityMatrix.platforms?.[plat] || null,
        enabled: !!cfg?.enabled,
        status: liveStatus.status || "disconnected",
        error: liveStatus.error || null,
        errorType: liveStatus.errorType || null,
        errorDetail: liveStatus.errorDetail || null,
        lastConnectedAt: liveStatus.lastConnectedAt ?? null,
        lastErrorAt: liveStatus.lastErrorAt ?? null,
        lastSyncAt: liveStatus.lastSyncAt ?? null,
        lastStatusAt: liveStatus.lastStatusAt ?? null,
        retryCount: liveStatus.retryCount ?? 0,
        syncState: buildSyncState(liveStatus.lastSyncAt),
        adapter: buildAdapterStatus({ ...liveStatus, platform: plat, agentId: agent.id }),
        diagnose: buildPlatformDiagnostics(plat, cfg, liveStatus),
        agentId: agent.id,
      };
    };

    const tgToken = bridge.telegram?.token || "";
    const fsAppId = bridge.feishu?.appId || "";
    const fsAppSecret = bridge.feishu?.appSecret || "";
    const dtClientId = bridge.dingtalk?.clientId || "";
    const dtClientSecret = bridge.dingtalk?.clientSecret || "";
    const dtRobotCode = bridge.dingtalk?.robotCode || "";
    const agentlyMailCfg = bridge.agentlyMail || {};

    const index = engine.getBridgeIndex(agent.id);

    // Build per-platform owner dict from the shared owner policy.
    const ownerDict = {};
    for (const plat of KNOWN_PLATFORMS) {
      const o = resolveBridgeOwnerUserId({ platform: plat, agent, index });
      if (o) ownerDict[plat] = o;
    }

    return c.json({
      telegram: platformStatus("telegram", bridge.telegram, {
        configured: !!tgToken, token: maskSecretValue(tgToken),
      }),
      feishu: platformStatus("feishu", bridge.feishu, {
        configured: !!(fsAppId && fsAppSecret), appId: fsAppId, appSecret: maskSecretValue(fsAppSecret),
      }),
      dingtalk: platformStatus("dingtalk", bridge.dingtalk, {
        configured: !!(dtClientId && dtClientSecret && dtRobotCode),
        clientId: dtClientId,
        clientSecret: maskSecretValue(dtClientSecret),
        robotCode: dtRobotCode,
      }),
      whatsapp: platformStatus("whatsapp", bridge.whatsapp, {
        configured: !!bridge.whatsapp?.enabled,
        qrcodeUrl: live.whatsapp?.qrcodeUrl || "",
        authenticated: !!live.whatsapp?.authenticated,
      }),
      qq: platformStatus("qq", bridge.qq, {
        configured: !!(bridge.qq?.appID && (bridge.qq?.appSecret || bridge.qq?.token)),
        appID: bridge.qq?.appID || "",
        appSecret: maskSecretValue(bridge.qq?.appSecret || bridge.qq?.token || ""),
      }),
      agentlyMail: platformStatus("agentlyMail", agentlyMailCfg, {
        configured: !!agentlyMailCfg.email,
        authenticated: !!agentlyMailCfg.email || !!live.agentlyMail?.authenticated,
        email: agentlyMailCfg.email || live.agentlyMail?.email || "",
        lastVerifiedAt: agentlyMailCfg.lastVerifiedAt ?? null,
        authorizedAt: agentlyMailCfg.authorizedAt ?? null,
      }),
      wechat: platformStatus("wechat", bridge.wechat, {
        configured: !!bridge.wechat?.botToken,
        token: maskSecretValue(bridge.wechat?.botToken || ""),
      }),
      permissionMode: engine.getBridgePermissionMode?.()
        || normalizeBridgePermissionMode({ readOnly: engine.getBridgeReadOnly?.() }),
      readOnly: engine.getBridgeReadOnly?.() ?? false,
      receiptEnabled: engine.getBridgeReceiptEnabled?.() !== false,
      richStreamingEnabled: engine.getBridgeRichStreamingEnabled?.() !== false,
      reliability: typeof bridgeManager.getReliabilitySummary === "function"
        ? bridgeManager.getReliabilitySummary()
        : null,
      capabilities: capabilityMatrix,
      knownUsers: collectKnownUsers(index),
      owner: ownerDict,
    });
  });

  route.get("/bridge/agently-mail/status", async (c) => {
    const agent = resolveAgent(engine, c);
    const cfg = agent.config?.bridge?.agentlyMail || {};
    const live = bridgeManager.getStatus(agent.id)?.agentlyMail || {};
    const cli = await agentlyMail.checkCli();
    return c.json({
      ok: true,
      configured: !!cfg.email,
      enabled: !!cfg.enabled,
      authenticated: !!cfg.email || !!live.authenticated,
      email: cfg.email || live.email || "",
      lastVerifiedAt: cfg.lastVerifiedAt ?? null,
      authorizedAt: cfg.authorizedAt ?? null,
      status: live.status || (cfg.email ? "connected" : "disconnected"),
      cli,
    });
  });

  route.post("/bridge/agently-mail/auth/start", async (c) => {
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const result = await agentlyMail.startAuthLogin();
    recordSecurityAuditEvent(c, engine, {
      action: "settings.bridge.agently_mail.auth.start",
      target: "bridge.agentlyMail",
      secretFields: [],
      metadata: { hasAuthUrl: !!result.authUrl },
    } as any);
    return c.json({ ok: true, ...result });
  });

  route.post("/bridge/agently-mail/verify", async (c) => {
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const agent = resolveAgentStrict(engine, c);
    const result = await agentlyMail.verify();
    if (!result?.ok || !result?.email) {
      return c.json({ ok: false, error: result?.error || "agently_mail_verify_failed", raw: result?.raw || "" }, 400);
    }

    const current = agent.config?.bridge?.agentlyMail || {};
    const nextCfg = {
      ...current,
      enabled: true,
      email: result.email,
      authorizedAt: current.authorizedAt || Date.now(),
      lastVerifiedAt: Date.now(),
    };
    agent.updateConfig({ bridge: { agentlyMail: nextCfg } });
    await bridgeManager.startPlatformFromConfig("agentlyMail", nextCfg, agent.id);
    recordSecurityAuditEvent(c, engine, {
      action: "settings.bridge.agently_mail.verify",
      target: "bridge.agentlyMail",
      secretFields: [],
      metadata: { agentId: agent.id, emailDomain: String(result.email).split("@")[1] || null },
    } as any);
    return c.json({ ok: true, email: result.email });
  });

  route.post("/bridge/agently-mail/unbind", async (c) => {
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const agent = resolveAgentStrict(engine, c);
    const current = agent.config?.bridge?.agentlyMail || {};
    const nextCfg = {
      ...current,
      enabled: false,
      email: null,
      authorizedAt: null,
      lastVerifiedAt: null,
    };
    agent.updateConfig({ bridge: { agentlyMail: nextCfg } });
    await bridgeManager.stopPlatform("agentlyMail", agent.id);
    recordSecurityAuditEvent(c, engine, {
      action: "settings.bridge.agently_mail.unbind",
      target: "bridge.agentlyMail",
      secretFields: [],
      metadata: { agentId: agent.id },
    } as any);
    return c.json({ ok: true });
  });

  /** 设置 owner（哪个账号是你）— 写入 agent.config.bridge */
  route.post("/bridge/owner", async (c) => {
    const body = await safeJson(c);
    const { platform, userId } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ ok: false, error: "invalid platform" });
    }
    const agent = resolveAgentStrict(engine, c);
    agent.updateConfig({ bridge: { [platform]: { owner: userId || null } } });
    debugLog()?.log("api", `POST /api/bridge/owner agent=${agent.id} platform=${platform} owner=${userId ? "[set]" : "[cleared]"}`);
    return c.json({ ok: true });
  });

  /** 保存凭证 + 启停平台（写入 agent.config.bridge） */
  route.post("/bridge/config", async (c) => {
    const body = await safeJson(c);
    const { platform, credentials, enabled } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ error: "invalid platform" }, 400);
    }
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const secretFields = credentials
      ? collectSecretPatchPaths({ credentials }, bridgeSecretKeys(platform))
      : [];
    const secretDenied = denySecretMutationWithoutScope(c, secretFields);
    if (secretDenied) return secretDenied;

    const agent = resolveAgentStrict(engine, c);
    const agentId = agent.id;

    const bridgeCfg = agent.config?.bridge?.[platform] || {};
    const patch = { ...bridgeCfg };

    if (credentials) Object.assign(patch, resolveBridgeCredentials(platform, credentials, bridgeCfg));
    if (typeof enabled === "boolean") patch.enabled = enabled;

    agent.updateConfig({ bridge: { [platform]: patch } });

    // Start/stop
    if (patch.enabled) {
      await bridgeManager.startPlatformFromConfig(platform, patch, agentId);
    } else {
      await bridgeManager.stopPlatform(platform, agentId);
    }

    debugLog()?.log("api", `POST /api/bridge/config agent=${agentId} platform=${platform} enabled=${!!patch.enabled}`);
    recordSecurityAuditEvent(c, engine, {
      action: "settings.bridge.config.update",
      target: `bridge.${platform}`,
      secretFields,
      metadata: { agentId, platform, enabled: typeof enabled === "boolean" ? enabled : null },
    } as any);
    return c.json({ ok: true });
  });

  route.post("/bridge/reconnect", async (c) => {
    const body = await safeJson(c);
    const { platform } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ ok: false, error: "invalid platform" });
    }

    const agent = resolveAgentStrict(engine, c);
    const cfg = { ...(agent.config?.bridge?.[platform] || {}) };

    if (platform === "wechat" && !cfg.botToken) {
      return c.json({ ok: false, error: t("settings.bridge.wechatNeedScan"), errorType: "need_scan" });
    }

    if (platform === "qq" && !(cfg.appID && (cfg.appSecret || cfg.token))) {
      return c.json({ ok: false, error: t("settings.bridge.qqDiagMissingCredentials"), errorType: "missing_credentials" });
    }

    if (platform === "agentlyMail" && !cfg.email) {
      return c.json({ ok: false, error: t("settings.bridge.agentlyMailDiagNeedAuth"), errorType: "need_auth" });
    }

    if (platform === "dingtalk" && !(cfg.clientId && cfg.clientSecret && cfg.robotCode)) {
      return c.json({ ok: false, error: t("settings.bridge.dingtalkDiagMissingCredentials"), errorType: "missing_credentials" });
    }

    if (!cfg.enabled) {
      return c.json({ ok: false, error: t("settings.bridge.diagReconnectNeedsEnabled"), errorType: "not_enabled" });
    }

    await bridgeManager.stopPlatform(platform, agent.id);
    await bridgeManager.startPlatformFromConfig(platform, cfg, agent.id);

    const status = await waitForBridgePlatform(bridgeManager, agent.id, platform);
    if (status?.status === "error" || status?.error) {
      return c.json({
        ok: false,
        platform,
        error: normalizeBridgeError(status?.errorType, status?.error) || t("settings.bridge.diagReconnectFailed"),
        errorType: status?.errorType || null,
        status,
      });
    }
    debugLog()?.log("api", `POST /api/bridge/reconnect agent=${agent.id} platform=${platform}`);
    return c.json({ ok: true, platform, status });
  });

  /** 更新 bridge 全局设置（readOnly / receiptEnabled） */
  route.post("/bridge/settings", async (c) => {
    const body = await safeJson(c);
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const { permissionMode, readOnly, receiptEnabled, richStreamingEnabled } = body;
    if (typeof permissionMode === "string") {
      const normalized = normalizeBridgePermissionMode({ permissionMode });
      if (normalized !== permissionMode) {
        return c.json({ ok: false, error: "invalid bridge permission mode" }, 400);
      }
      engine.setBridgePermissionMode?.(normalized);
    } else if (typeof readOnly === "boolean") {
      engine.setBridgeReadOnly(readOnly);
      engine.setBridgePermissionMode?.(
        readOnly ? SESSION_PERMISSION_MODES.READ_ONLY : SESSION_PERMISSION_MODES.AUTO,
      );
    }
    if (typeof receiptEnabled === "boolean") {
      engine.setBridgeReceiptEnabled(receiptEnabled);
    }
    if (typeof richStreamingEnabled === "boolean") {
      engine.setBridgeRichStreamingEnabled?.(richStreamingEnabled);
    }
    debugLog()?.log("api", `POST /api/bridge/settings permissionMode=${permissionMode} readOnly=${readOnly} receiptEnabled=${receiptEnabled} richStreamingEnabled=${richStreamingEnabled}`);
    const savedPermissionMode = engine.getBridgePermissionMode?.()
      || normalizeBridgePermissionMode({ readOnly: engine.getBridgeReadOnly?.() });
    return c.json({
      ok: true,
      permissionMode: savedPermissionMode,
      readOnly: engine.getBridgeReadOnly?.() ?? false,
      receiptEnabled: engine.getBridgeReceiptEnabled?.() !== false,
      richStreamingEnabled: engine.getBridgeRichStreamingEnabled?.() !== false,
    });
  });

  /** 停止指定平台 */
  route.post("/bridge/stop", async (c) => {
    const body = await safeJson(c);
    const { platform } = body;
    if (!platform) {
      return c.json({ error: "platform required" }, 400);
    }

    const agent = resolveAgentStrict(engine, c);
    await bridgeManager.stopPlatform(platform, agent.id);
    agent.updateConfig({ bridge: { [platform]: { enabled: false } } });

    debugLog()?.log("api", `POST /api/bridge/stop agent=${agent.id} platform=${platform}`);
    return c.json({ ok: true });
  });

  /** 获取最近消息日志（实时内存缓冲） */
  route.get("/bridge/messages", async (c) => {
    const limit = parseInt(c.req.query("limit"), 10) || 50;
    const agent = resolveAgent(engine, c);
    return c.json({ messages: bridgeManager.getMessages(limit, agent.id) });
  });

  /** 获取 bridge session 列表 */
  route.get("/bridge/sessions", async (c) => {
    const platform = c.req.query("platform"); // optional filter
    const agent = resolveAgent(engine, c);
    const index = engine.getBridgeIndex(agent.id);
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const sessions = [];

    for (const [sessionKey, raw] of Object.entries(index)) {
      // 兼容旧格式（字符串）和新格式（对象）
      const entry: any = typeof raw === "string" ? { file: raw } : raw;
      const file = entry.file;
      if (!file) continue;

      // 解析 sessionKey → 平台 + 类型
      const { platform: plat, chatType, chatId } = parseSessionKey(sessionKey);

      // 按平台过滤
      if (platform && plat !== platform) continue;

      // 获取最后修改时间
      let lastActive = null;
      const fp = path.resolve(bridgeDir, file);
      const bridgeRoot = path.resolve(bridgeDir);
      if (fp !== bridgeRoot && !fp.startsWith(bridgeRoot + path.sep)) continue;
      try {
        const stat = fs.statSync(fp);
        lastActive = stat.mtimeMs;
      } catch {
        // Ignore missing bridge session files.
      }

      // isOwner 运行时计算：per-agent owner dict
      const userId = entry.userId || (plat === "wechat" && chatType === "dm" ? chatId : null);
      const isOwner = isBridgeOwner({
        platform: plat,
        chatType,
        userId,
        principalAliases: entry.qqPrincipal?.aliases || [],
        agent,
      });

      sessions.push({
        sessionKey, platform: plat, chatType, chatId, file, sessionPath: fp, lastActive,
        displayName: entry.name || null,
        avatarUrl: entry.avatarUrl || null,
        isOwner,
      });
    }

    // 按最后活跃时间排序
    sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    return c.json({ sessions });
  });

  /** 读取指定 bridge session 的消息 */
  route.get("/bridge/sessions/:sessionKey/messages", async (c) => {
    const sessionKey = c.req.param("sessionKey");
    const agent = resolveAgent(engine, c);
    const index = engine.getBridgeIndex(agent.id);
    const raw = index[sessionKey];
    const file = typeof raw === "string" ? raw : raw?.file;
    if (!file) return c.json({ error: "session not found", messages: [] });

    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const fp = path.resolve(bridgeDir, file);

    // 防止 path traversal
    if (!fp.startsWith(path.resolve(bridgeDir) + path.sep)) {
      return c.json({ error: "invalid session path", messages: [] });
    }

    try {
      const rawContent = fs.readFileSync(fp, "utf-8");
      const lines = rawContent.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

        let textContent = "";
        let mediaCount = 0;
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === "text" && b.text) textContent += b.text;
            if (b.type === "image") mediaCount++;
          }
        } else if (typeof msg.content === "string") {
          textContent = msg.content;
        }

        const hasMedia = mediaCount > 0;
        if (!textContent && !hasMedia) continue;
        messages.push({
          role: msg.role,
          content: textContent || (hasMedia ? `[图片 x${mediaCount}]` : ""),
          hasMedia,
          mediaCount,
          ts: line.timestamp || null,
        });
      }

      return c.json({ messages });
    } catch (err) {
      return c.json({ error: err.message, messages: [] });
    }
  });

  /** 重置 bridge session（清除上下文，下次消息新建 session） */
  route.post("/bridge/sessions/:sessionKey/reset", async (c) => {
    const sessionKey = c.req.param("sessionKey");
    const agent = resolveAgentStrict(engine, c);
    const agentId = agent.id;
    const index = engine.getBridgeIndex(agentId);
    const raw = index[sessionKey];
    if (!raw) return c.json({ ok: false, error: "session not found" });

    // 保留元数据（name, avatarUrl），只删 file 引用
    const entry = typeof raw === "string" ? {} : { ...raw };
    delete entry.file;
    index[sessionKey] = entry;
    engine.saveBridgeIndex(index, agentId);

    return c.json({ ok: true });
  });

  /** 发送媒体到 bridge 平台（桌面端推送文件） */
  route.get("/bridge/media/:token", async (c) => {
    const token = c.req.param("token");
    const entry = bridgeManager.mediaPublisher?.resolve?.(token);
    if (!entry) return c.text("media not found", 404);

    let stat;
    try {
      stat = fs.statSync(entry.realPath);
      if (!stat.isFile()) return c.text("media not found", 404);
    } catch {
      return c.text("media not found", 404);
    }
    if (stat.size > MAX_BRIDGE_MEDIA_SIZE) {
      return c.text("media too large", 413);
    }

    const filename = entry.filename || path.basename(entry.realPath);
    const disposition = isInlineBridgeMediaMime(entry.mime) ? "inline" : "attachment";
    const headers = new Headers({
      "content-type": entry.mime || "application/octet-stream",
      "content-length": String(stat.size),
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeRfc5987ValueChars(filename)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    return new Response(fs.readFileSync(entry.realPath), { headers });
  });

  route.post("/bridge/send-media", async (c) => {
    const body = await safeJson(c);
    const { platform, chatId, filePath } = body;
    if (!platform || !chatId || !filePath) {
      return c.json({ error: "platform, chatId, filePath required" }, 400);
    }

    const agent = resolveAgentStrict(engine, c);

    // Keep manual media sends aligned with BridgeManager runtime roots.
    const allowedRoots = collectBridgeMediaAllowedRoots(engine, { agentId: agent.id, agent });

    // 先检查文件是否存在
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return c.json({ error: "file not found" }, 404);
    }

    // 用 realpathSync 解析 symlink，防止 symlink 绕过白名单
    let realPath;
    try { realPath = fs.realpathSync(resolved); }
    catch { return c.json({ error: "file not found" }, 404); }

    const isSafe = isInsideBridgeMediaRoot(realPath, allowedRoots);
    if (!isSafe) {
      return c.json({ error: "path outside allowed roots" }, 403);
    }

    // Reject oversized media before registering it as a session file.
    try {
      const stat = fs.statSync(realPath);
      if (stat.size > MAX_BRIDGE_MEDIA_SIZE) {
        return c.json({ error: `file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 50MB)` }, 413);
      }
    } catch { return c.json({ error: "file not found" }, 404); }

    try {
      if (typeof engine.registerSessionFile !== "function") {
        return c.json({ ok: false, error: "session file registry unavailable" }, 500);
      }
      if (typeof bridgeManager.sendMediaItem !== "function") {
        return c.json({ ok: false, error: "bridge media delivery unavailable" }, 500);
      }

      const sessionPath = typeof body.sessionPath === "string" && body.sessionPath.trim()
        ? body.sessionPath.trim()
        : buildBridgeManualSendSessionPath(agent.id, platform, chatId);
      const sessionFile = engine.registerSessionFile({
        sessionPath,
        filePath: realPath,
        label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : path.basename(realPath),
        origin: "bridge_manual_send",
      });
      await bridgeManager.sendMediaItem(
        platform,
        chatId,
        { type: "session_file", fileId: sessionFile.id, sessionPath },
        agent.id,
      );
      return c.json({ ok: true, fileId: sessionFile.id });
    } catch (err) {
      return c.json({ ok: false, error: err.message }, isUnsupportedMediaDeliveryError(err) ? 422 : 500);
    }
  });

  /** 测试凭证（不启动轮询） */
  route.post("/bridge/test", async (c) => {
    const body = await safeJson(c);
    const { platform, credentials } = body;
    if (!platform || !credentials) {
      return c.json({ error: "platform and credentials required" }, 400);
    }

    if (!KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ error: "unknown platform" }, 400);
    }

    try {
      const hasAgentId = !!c.req.query("agentId");
      const usesMaskedCredentials = hasMaskedBridgeCredentials(platform, credentials);
      if (usesMaskedCredentials && !hasAgentId) {
        return c.json({ error: "agentId is required when testing masked bridge credentials" }, 400);
      }
      const savedAgent = usesMaskedCredentials ? resolveAgentStrict(engine, c) : null;
      const testCredentials = usesMaskedCredentials
        ? resolveBridgeCredentials(platform, credentials, savedAgent.config?.bridge?.[platform] || {})
        : credentials;
      if (platform === "telegram") {
        const bot = new TelegramBot(testCredentials.token);
        const me = await bot.getMe();
        return c.json({ ok: true, info: { username: me.username, name: me.first_name } });
      } else if (platform === "feishu") {
        const resp = await fetch(FEISHU_TENANT_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_id: testCredentials.appId,
            app_secret: testCredentials.appSecret,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await resp.json();
        if (data.code === 0) {
          return c.json({
            ok: true,
            info: {
              msg: t("error.tokenSuccess"),
              ...feishuTestInfo({ credentialOk: true, response: resp, data }),
            },
          });
        }
        return c.json({
          ok: false,
          error: data.msg || t("error.verifyFailed"),
          info: feishuTestInfo({ credentialOk: false, response: resp, data }),
        });
      } else if (platform === "qq") {
        // v2 鉴权：appID + appSecret → access_token → /users/@me
        const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId: testCredentials.appID, clientSecret: testCredentials.appSecret }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          return c.json({ ok: false, error: tokenData.message || t("error.tokenFetchFailed") });
        }
        const meRes = await fetch("https://api.sgroup.qq.com/users/@me", {
          headers: { Authorization: `QQBot ${tokenData.access_token}` },
        });
        const me = await meRes.json();
        if (me.id) {
          return c.json({ ok: true, info: { username: me.username, name: me.username } });
        }
        return c.json({ ok: false, error: me.message || t("error.botInfoFailed") });
      } else if (platform === "dingtalk") {
        const resp = await fetch(DINGTALK_STREAM_OPEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: testCredentials.clientId,
            clientSecret: testCredentials.clientSecret,
            subscriptions: [
              { topic: DINGTALK_BOT_CALLBACK_TOPIC, type: "CALLBACK" },
            ],
            ua: "gsap-bridge-dingtalk/1.0.0",
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await resp.json();
        if (resp.ok && data?.endpoint && data?.ticket) {
          return c.json({
            ok: true,
            info: {
              msg: t("error.tokenSuccess"),
              httpStatus: resp.status,
              credentialOk: true,
              ...dingTalkLongConnectionInfo(),
            },
          });
        }
        return c.json({
          ok: false,
          error: data?.message || data?.errmsg || data?.error || t("error.verifyFailed"),
          info: {
            httpStatus: resp.status,
            credentialOk: false,
            ...(data?.code !== undefined ? { dingtalkCode: data.code } : {}),
            ...(data?.requestId ? { requestId: data.requestId } : {}),
            ...dingTalkLongConnectionInfo(),
          },
        });
      }
      if (platform === "wechat") {
        // 用 getconfig 验证 token（不污染 cursor）
        const crypto = await import("node:crypto");
        const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
        const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/getconfig", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "Authorization": `Bearer ${testCredentials.botToken}`,
            "X-WECHAT-UIN": uin,
          },
          body: JSON.stringify({ base_info: { channel_version: "1.0.0" } }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json();
        if (data.ret && data.ret !== 0) {
          return c.json({ ok: false, error: data.errmsg || `errcode ${data.ret}` });
        }
        return c.json({ ok: true, info: { msg: "微信 iLink 连接成功" } });
      }
      return c.json({ ok: false, error: t("error.platformTestUnsupported") });
    } catch (err) {
      return c.json({ ok: false, error: err.message });
    }
  });

  /** 获取微信扫码登录二维码 */
  route.post("/bridge/whatsapp/qrcode", async (c) => {
    const agent = resolveAgentStrict(engine, c);
    const forceRestart = c.req.query("force") === "1";
    const currentStatus = bridgeManager.getStatus(agent.id)?.whatsapp || {};
    const isActive = ["connecting", "qr", "connected"].includes(currentStatus.status || "");

    if (!forceRestart && isActive && (currentStatus.qrcodeUrl || currentStatus.authenticated || !currentStatus.error)) {
      return c.json({ ok: !currentStatus.error, ...currentStatus, error: currentStatus.error || null });
    }

    if (forceRestart) {
      await bridgeManager.stopPlatform("whatsapp", agent.id);
    }

    const cfg = { ...(agent.config?.bridge?.whatsapp || {}), enabled: true, _gsapHome: engine.gsapHome };
    agent.updateConfig({ bridge: { whatsapp: cfg } });
    await bridgeManager.startPlatformFromConfig("whatsapp", cfg, agent.id);

    const startedAt = Date.now();
    while (Date.now() - startedAt < 10_000) {
      const status = bridgeManager.getStatus(agent.id)?.whatsapp || {};
      if (status.qrcodeUrl || status.authenticated || status.error) {
        return c.json({ ok: !status.error, ...status, error: status.error || null });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const status = bridgeManager.getStatus(agent.id)?.whatsapp || {};
    return c.json({ ok: !status.error, ...status, error: status.error || null });
  });

  /** 获取微信扫码登录二维码 */
  route.post("/bridge/wechat/qrcode", async (c) => {
    const { getWechatQrcode } = await loadWechatLogin();
    return c.json(await getWechatQrcode());
  });

  /** 轮询微信扫码状态 */
  route.post("/bridge/wechat/qrcode-status", async (c) => {
    const body = await safeJson(c);
    const { qrcodeId } = body;
    const { pollWechatQrcodeStatus } = await loadWechatLogin();
    return c.json(await pollWechatQrcodeStatus(qrcodeId));
  });

  return route;
}

function bridgeSecretKeys(platform: any) {
  if (platform === "agentlyMail") return [];
  if (platform === "telegram") return ["token"];
  if (platform === "feishu") return ["appSecret"];
  if (platform === "dingtalk") return ["clientSecret"];
  if (platform === "qq") return ["appSecret", "token"];
  if (platform === "wechat") return ["botToken"];
  return ["token", "botToken", "appSecret"];
}

function resolveBridgeCredentials(platform: any, patch: any, existing: any) {
  return resolveSecretPatch({
    patch,
    existing,
    secretKeys: bridgeSecretKeys(platform),
  });
}

function hasMaskedBridgeCredentials(platform: any, credentials: any) {
  if (!credentials || typeof credentials !== "object") return false;
  return bridgeSecretKeys(platform).some((key) => isMaskedSecretValue(credentials[key]));
}

function buildBridgeManualSendSessionPath(agentId: any, platform: any, chatId: any) {
  return `bridge:${agentId}:${platform}:${chatId}`;
}

function isUnsupportedMediaDeliveryError(err) {
  const message = String(err?.message || err || "");
  return /unsupported|cannot deliver|does not support media input mode|public media URL|public_url|requires a public media URL|只能走|不支持|无法|不能/i.test(message);
}

function encodeRfc5987ValueChars(value) {
  return encodeURIComponent(value)
    .replace(/['()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

function isInlineBridgeMediaMime(mime) {
  const value = String(mime || "").toLowerCase();
  return value.startsWith("image/") || value.startsWith("video/");
}
