// @ts-nocheck
import path from "path";
import { loadConfig } from "../memory/config-loader.ts";

export const DEFAULT_AGENT_PHONE_GUARD_LIMIT_PER_MEMBER = 12;

export const DEFAULT_AGENT_PHONE_SETTINGS = Object.freeze({
  toolMode: "read_only",
  replyMinChars: null,
  replyMaxChars: null,
  proactiveEnabled: true,
  reminderIntervalMinutes: 31,
  guardLimit: defaultAgentPhoneGuardLimit(3),
  modelOverrideEnabled: false,
  modelOverrideModel: null,
});

export const AGENT_PHONE_REFLECTION_GUIDES = Object.freeze({
  gsap: { zhName: "MOOD", enName: "MOOD", tag: "mood" },
  hanako: { zhName: "MOOD", enName: "MOOD", tag: "mood" },
  butter: { zhName: "PULSE", enName: "PULSE", tag: "pulse" },
  ming: { zhName: "Reflect", enName: "Reflect", tag: "reflect" },
  hermes: { zhName: "Reflect", enName: "Reflect", tag: "reflect" },
  kong: { zhName: "Focus", enName: "Focus", tag: "reflect" },
});

export function positiveIntegerOrNull(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

export function positiveIntegerOrDefault(value, defaultValue) {
  return positiveIntegerOrNull(value) || defaultValue;
}

export function defaultAgentPhoneGuardLimit(memberCount = 3) {
  const count = Number(memberCount);
  const normalized = Number.isFinite(count) && count > 0 ? Math.floor(count) : 3;
  return Math.max(1, normalized) * DEFAULT_AGENT_PHONE_GUARD_LIMIT_PER_MEMBER;
}

export function resolveAgentPhoneGuardLimit(value, memberCount = 3) {
  return positiveIntegerOrDefault(value, defaultAgentPhoneGuardLimit(memberCount));
}

export function readBoolean(value) {
  return value === true || value === "true";
}

export function normalizeAgentPhoneModelOverride({ enabled, id, provider } = {}) {
  if (!readBoolean(enabled)) return { enabled: false, model: null };
  const modelId = typeof id === "string" ? id.trim() : "";
  const modelProvider = typeof provider === "string" ? provider.trim() : "";
  if (!modelId || !modelProvider) return { enabled: false, model: null };
  return { enabled: true, model: { id: modelId, provider: modelProvider } };
}

export function resolveAgentPhoneReflectionGuide({ agentId, agent = null, agentsDir = null } = {}) {
  try {
    let cfg = agent?.config || null;
    if (!cfg && agentsDir && agentId) {
      cfg = loadConfig(path.join(agentsDir, agentId, "config.yaml"));
    }
    const yuan = cfg?.agent?.yuan || null;
    return yuan ? (AGENT_PHONE_REFLECTION_GUIDES[yuan] || null) : null;
  } catch {
    return null;
  }
}

function formatRangeText({ min, max }) {
  if (min && max) return `between ${min} and ${max} characters`;
  if (min) return `at least ${min} characters`;
  return `at most ${max} characters`;
}

export function formatAgentPhonePromptGuidance({
  agentId,
  agent = null,
  agentsDir = null,
  settings = DEFAULT_AGENT_PHONE_SETTINGS,
  enConversationName = "conversation",
} = {}) {
  const guide = resolveAgentPhoneReflectionGuide({ agentId, agent, agentsDir });
  const lines = [];
  if (guide) {
    lines.push(
      `- Your system prompt has loaded the ${guide.enName} reflection template. Follow it for this turn and use <${guide.tag}>...</${guide.tag}> for private reflection. That reflection appears only in phone activity and is not posted to the ${enConversationName}.`,
    );
  } else {
    lines.push(
      `- Follow the private reflection block and tag requirements from this agent's system prompt. Reflection appears only in phone activity and is not posted to the ${enConversationName}.`,
    );
  }
  lines.push(
    `- The reply body posted to the ${enConversationName} should sound like natural instant-message speech: conversational, lighter, and not essay-like. Use structured writing only when the content needs lists, steps, code, or precision.`,
  );
  if (settings.replyMinChars || settings.replyMaxChars) {
    lines.push(
      `- This ${enConversationName} prefers the posted reply body to be ${formatRangeText({
        min: settings.replyMinChars,
        max: settings.replyMaxChars,
      })}. This is writing guidance and does not change the API output budget.`,
    );
  }
  return lines.join("\n");
}
