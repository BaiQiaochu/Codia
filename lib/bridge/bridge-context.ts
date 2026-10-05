// @ts-nocheck
import { parseSessionKey } from "./session-key.ts";
import { interactionCapabilitiesForPlatform } from "./interaction-capabilities.ts";

export const BRIDGE_NOTIFY_PLATFORMS = ["wechat", "feishu", "dingtalk", "telegram", "qq", "whatsapp"];
export const BRIDGE_CONTEXT_PLATFORMS = [...BRIDGE_NOTIFY_PLATFORMS, "wukong"];

const PLATFORM_LABELS = {
  zh: {
    wechat: "\u5fae\u4fe1",
    feishu: "\u98de\u4e66",
    dingtalk: "\u9489\u9489",
    wukong: "\u609f\u7a7a",
    telegram: "Telegram",
    qq: "QQ",
    whatsapp: "WhatsApp",
  },
  en: {
    wechat: "WeChat",
    feishu: "Feishu",
    dingtalk: "DingTalk",
    wukong: "Wukong",
    telegram: "Telegram",
    qq: "QQ",
    whatsapp: "WhatsApp",
  },
};

function localeKey(locale) {
  return String(locale || "").startsWith("zh") ? "zh" : "en";
}

export function bridgePlatformLabel(platform, locale = "zh") {
  const key = localeKey(locale);
  return PLATFORM_LABELS[key][platform] || platform || null;
}

export function normalizeBridgePlatforms(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  const bridgePlatforms = [];
  const invalidBridgePlatforms = [];
  for (const item of raw) {
    const platform = typeof item === "string" ? item.trim() : "";
    if (!platform) continue;
    if (!BRIDGE_NOTIFY_PLATFORMS.includes(platform)) {
      invalidBridgePlatforms.push(platform);
      continue;
    }
    if (!bridgePlatforms.includes(platform)) bridgePlatforms.push(platform);
  }
  return { bridgePlatforms, invalidBridgePlatforms };
}

export function buildBridgeContext(input = {}, locale = "zh") {
  const parsed = parseSessionKey(input.sessionKey || "");
  const platform = input.platform || parsed.platform;
  if (!BRIDGE_CONTEXT_PLATFORMS.includes(platform)) {
    return { isBridgeSession: false };
  }

  const chatType = input.chatType || parsed.chatType || "dm";
  const role = input.role || input.audience || (input.guest === true ? "guest" : "owner");
  const userId = input.userId || null;
  const chatId = input.chatId || parsed.chatId || null;
  const sessionKey = input.sessionKey || null;
  const agentId = input.agentId || parsed.agentId || null;
  const canNotifyPlatform = BRIDGE_NOTIFY_PLATFORMS.includes(platform);
  const notificationHint = canNotifyPlatform && role === "owner" && chatType === "dm"
    ? {
        channels: ["bridge_owner"],
        bridgePlatforms: [platform],
        contextPolicy: "record_when_delivered",
      }
    : null;

  return {
    isBridgeSession: true,
    platform,
    platformLabel: bridgePlatformLabel(platform, locale),
    chatType,
    role,
    sessionKey,
    agentId,
    userId,
    chatId,
    notificationHint,
    interactionCapabilities: interactionCapabilitiesForPlatform(platform),
  };
}

export function buildBridgePromptLine(context, locale = "zh") {
  if (!context?.isBridgeSession || !context.platform) return "";
  const label = bridgePlatformLabel(context.platform, locale);
  if (!label) return "";
  if (localeKey(locale) === "zh") {
    const base = `当前用户正通过${label}与你对话，仅在需要理解当前平台或“这里”等指代时参考。`;
    if (context.interactionCapabilities?.confirmationMode !== "text_command") return base;
    return `${base}${label} 对话是纯文本渠道，没有可点击的卡片、按钮或确认弹窗；需要用户确认的操作由用户回复文字指令完成，例如回复 /apply 创建最新的自动任务建议。需要确认时引导用户回复指令，不要让用户点击界面元素。`;
  }
  const base = `The user is currently talking with you through ${label}; use this only when interpreting the current platform or references like "here."`;
  if (context.interactionCapabilities?.confirmationMode !== "text_command") return base;
  return `${base} This ${label} conversation is text-only, with no clickable cards, buttons, or confirmation dialogs. Actions that need confirmation are completed by text commands, for example replying /apply to create the latest automation suggestion.`;
}

export function appendBridgePromptLine(prompt, context, locale = "zh") {
  const line = buildBridgePromptLine(context, locale);
  if (!line) return prompt || "";
  const base = prompt || "";
  if (base.includes(line)) return base;
  return `${base}\n\n${line}`;
}

export function bridgeContextIndexMeta(context, meta = {}) {
  if (!context?.isBridgeSession) return meta || null;
  return {
    ...(meta || {}),
    platform: context.platform,
    chatType: context.chatType,
    role: context.role,
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.chatId ? { chatId: context.chatId } : {}),
  };
}
