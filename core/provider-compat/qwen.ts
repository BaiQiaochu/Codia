import { modelSupportsVideoInput } from "../../shared/model-capabilities.ts";
import { normalizeOpenAIVideoUrlPayload } from "./openai-video-url.ts";

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  if (isDashScopeProvider(model) && modelSupportsVideoInput(model)) return true;
  if (isDashScopeProvider(model) && isQwen36_27B(model)) return true;
  return Array.isArray(model.quirks) && model.quirks.includes("enable_thinking");
}

export function apply(payload, model, options: any = {}) {
  const result = normalizeDashScopeVideoPayload(payload, model);
  if (options?.mode === "utility" || isThinkingOff(options?.reasoningLevel)) {
    return { ...result, enable_thinking: false };
  }
  if (options?.mode === "chat" && hasSelectedSkillInstruction(result)) {
    return { ...result, enable_thinking: false };
  }
  if (options?.mode === "chat" && isModelReasoningDisabled(model)) {
    return { ...result, enable_thinking: false };
  }
  if (options?.mode === "chat" && shouldUseFastDefaultThinking(model, options?.reasoningLevel)) {
    return { ...result, enable_thinking: false };
  }
  return result;
}

function normalizeDashScopeVideoPayload(payload, model) {
  if (!isDashScopeVideoModel(model)) return payload;
  return normalizeOpenAIVideoUrlPayload(payload);
}

function isDashScopeVideoModel(model) {
  return isDashScopeProvider(model) && modelSupportsVideoInput(model);
}

function isDashScopeProvider(model) {
  const provider = typeof model?.provider === "string" ? model.provider.toLowerCase() : "";
  const baseUrl = typeof model?.baseUrl === "string" ? model.baseUrl.toLowerCase() : "";
  return provider === "dashscope" || baseUrl.includes("dashscope");
}

function isThinkingOff(level) {
  const value = typeof level === "string" ? level.toLowerCase() : "";
  return value === "off" || value === "none" || value === "disabled";
}

function isModelReasoningDisabled(model) {
  return model?.reasoning === false;
}

function hasSelectedSkillInstruction(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return messages.some((message) => contentHasSelectedSkillMarker(message?.content));
}

function contentHasSelectedSkillMarker(content) {
  if (typeof content === "string") return content.includes("<selected-skills>");
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block === "string") return block.includes("<selected-skills>");
    if (!block || typeof block !== "object") return false;
    return typeof block.text === "string" && block.text.includes("<selected-skills>");
  });
}

function shouldUseFastDefaultThinking(model, level) {
  if (!isQwen36_27B(model)) return false;
  const value = typeof level === "string" ? level.toLowerCase() : "";
  return value !== "high" && value !== "xhigh";
}

function isQwen36_27B(model) {
  const id = typeof model?.id === "string" ? model.id.toLowerCase() : "";
  const name = typeof model?.name === "string" ? model.name.toLowerCase() : "";
  return matchesQwen36_27B(id) || matchesQwen36_27B(name);
}

function matchesQwen36_27B(value) {
  return /(^|[/:\-_])qwen3\.6[/:\-_]?27b($|[/:\-_])/.test(value)
    || /(^|[/:\-_])qwen3\.6[/:\-_]?27b[-_]?a\d*b?($|[/:\-_])/.test(value);
}
