import { getReasoningProfile, getThinkingFormat } from "../shared/model-capabilities.ts";

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isThinkingOff(level) {
  return level === "off" || level === "none" || level === "disabled";
}

function modelText(model) {
  return [
    model?.id,
    model?.name,
    model?.model,
    model?.modelId,
  ].map(lower).filter(Boolean).join(" ");
}

function isDeepSeekFamilyModel(model) {
  if (!model || typeof model !== "object") return false;
  const provider = lower(model.provider);
  const baseUrl = lower(model.baseUrl || model.base_url);
  const text = modelText(model);
  return provider === "deepseek"
    || provider.includes("deepseek")
    || baseUrl.includes("api.deepseek.com")
    || text.includes("deepseek-ai/")
    || text.includes("deepseek/")
    || text.includes("deepseek-");
}

function isDeepSeekReasoningModel(model) {
  if (!isDeepSeekFamilyModel(model)) return false;
  if (model.reasoning === true) return true;
  if (getThinkingFormat(model) || getReasoningProfile(model)) return true;

  const text = modelText(model);
  return text.includes("deepseek-reasoner")
    || text.includes("deepseek-r1")
    || text.includes("deepseek-v4");
}

function deepseekOutputContractPrompt() {
  return [
    "If you are using a DeepSeek reasoning model, follow this output contract:",
    "reasoning_content or thinking is private scratch work only.",
    "Every user-visible answer, recommendation, code block, list, summary, and conclusion must appear in the final assistant message after thinking.",
    "Do not end a response with only reasoning_content, thinking, or an open <think> block.",
    "If you emit <think>, close it before the final answer.",
  ].join("\n");
}

export function getProviderPromptPatches(model, options: Record<string, any> = {}) {
  if (isThinkingOff(options.reasoningLevel)) return [];
  if (!isDeepSeekReasoningModel(model)) return [];
  return [deepseekOutputContractPrompt()];
}

export const _test = {
  isDeepSeekFamilyModel,
  isDeepSeekReasoningModel,
};
