import { getReasoningProfile } from "../../shared/model-capabilities.ts";

const DEEPSEEK_HIGH_THINKING_BUDGET = 32768;
const DEEPSEEK_CHAT_SAFE_MAX_TOKENS = 8192;
const DEEPSEEK_HIGH_SAFE_MAX_TOKENS = 65536;
const DEEPSEEK_MAX_SAFE_MAX_TOKENS = 131072;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const MISSING_TOOL_REASONING_ERROR =
  "DeepSeek thinking mode reasoning_content is missing for tool_calls history. "
  + "Compact this session or start a new session before continuing with DeepSeek thinking mode.";
const MISSING_ANTHROPIC_TOOL_THINKING_ERROR =
  "DeepSeek Anthropic thinking mode history is missing non-empty thinking content for a tool call. "
  + "Compact this session or start a new session before continuing with DeepSeek Anthropic thinking mode.";
const DEEPSEEK_ROLEPLAY_MARKER_SIGNATURES = [
  "[Role immersion instruction]",
  "G-SAP DeepSeek roleplay reasoning patch",
  "〖角色沉浸要求〗",
];

type AnyRecord = Record<string, any>;

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function hasToolCalls(message) {
  return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasStringReasoningContent(message) {
  return hasOwn(message, "reasoning_content") && typeof message.reasoning_content === "string";
}

function normalizeAssistantContent(content) {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) return "";

  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  const provider = lower(model.provider);
  const baseUrl = lower(model.baseUrl || model.base_url);
  return provider === "deepseek" || baseUrl.includes("api.deepseek.com");
}

function isKnownThinkingModelId(id) {
  const normalized = lower(id);
  return normalized === "deepseek-reasoner"
    || normalized === "deepseek-v4"
    || normalized.startsWith("deepseek-v4-");
}

function isDeepSeekV4ModelId(id) {
  const normalized = lower(id);
  return normalized === "deepseek-v4"
    || normalized.startsWith("deepseek-v4-")
    || normalized.startsWith("deepseek-v4.");
}

function isDeepSeekAnthropicProfile(model) {
  if (getReasoningProfile(model) === "deepseek-v4-anthropic") return true;
  return lower(model?.api) === "anthropic-messages" && isDeepSeekV4ModelId(model?.id);
}

function isThinkingOff(level) {
  return level === "off" || level === "none" || level === "disabled";
}

function reasoningEffortForLevel(level) {
  if (!level) return null;
  if (level === "xhigh" || level === "max") return "max";
  if (level === "high") return "high";
  return null;
}

function applyRequestedReasoningLevel(payload, level) {
  const effort = reasoningEffortForLevel(level);
  if (effort) payload.reasoning_effort = effort;
}

function enableThinking(payload) {
  payload.thinking = { type: "enabled" };
}

function normalizeAnthropicThinking(thinking) {
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) {
    return { type: "enabled" };
  }
  const next: { type: string; budget_tokens?: number } = { type: "enabled" };
  if (positiveInteger(thinking.budget_tokens)) {
    next.budget_tokens = positiveInteger(thinking.budget_tokens);
  }
  return next;
}

function shouldUseThinking(payload, model, reasoningLevel) {
  if (payload.thinking?.type === "disabled") return false;
  if (isThinkingOff(reasoningLevel)) return false;
  return Boolean(
    payload.reasoning_effort
    || payload.thinking?.type === "enabled"
    || reasoningEffortForLevel(reasoningLevel)
  );
}

function shouldDisableThinkingForUtility(payload, model) {
  return Boolean(
    payload.reasoning_effort
    || payload.thinking
    || model?.reasoning === true
    || isKnownThinkingModelId(model?.id || payload.model)
  );
}

function normalizeReasoningEffort(payload) {
  if (!hasOwn(payload, "reasoning_effort")) return;
  if (payload.reasoning_effort === "low" || payload.reasoning_effort === "medium") {
    payload.reasoning_effort = "high";
  } else if (payload.reasoning_effort === "xhigh") {
    payload.reasoning_effort = "max";
  }
}

function stripReasoningContent(messages) {
  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || !hasOwn(message, "reasoning_content")) {
      return message;
    }
    changed = true;
    const copy = { ...message };
    delete copy.reasoning_content;
    return copy;
  });
  return changed ? next : messages;
}

function disableThinking(payload) {
  delete payload.reasoning_effort;
  payload.thinking = { type: "disabled" };
  if (Array.isArray(payload.messages)) {
    const stripped = stripReasoningContent(payload.messages);
    if (stripped !== payload.messages) payload.messages = stripped;
  }
}

function disableAnthropicThinking(payload) {
  delete payload.reasoning_effort;
  delete payload.output_config;
  payload.thinking = { type: "disabled" };
}

function shouldInjectRoleplayReasoningPatch(payload, model, options) {
  const id = model?.id || payload?.model;
  return options?.mode !== "utility"
    && options?.deepseekRoleplayReasoningPatch === true
    && (isDeepSeekV4ModelId(id) || getReasoningProfile(model) === "deepseek-v4-anthropic");
}

function normalizeInlineText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function hasRoleplayReasoningMarker(text) {
  const value = typeof text === "string" ? text : "";
  return DEEPSEEK_ROLEPLAY_MARKER_SIGNATURES.some((signature) => value.includes(signature));
}

function buildRoleplayReasoningMarker(options: AnyRecord = {}) {
  const context = options.deepseekRoleplayReasoningContext || {};
  const agentName = normalizeInlineText(context.agentName) || "current Agent";
  const agentDescription = normalizeInlineText(context.agentDescription);
  const locale = lower(context.locale || options.locale);

  if (!locale.startsWith("en")) {
    return [
      "〖角色沉浸要求〗",
      "在 reasoning_content / thinking 过程中，请遵循以下规则：",
      `当前 Agent 身份“${agentName}”。`,
      agentDescription ? `花名册简介：${agentDescription}` : null,
      `1. 以当前系统提示中定义的 Agent 身份“${agentName}”进行第一人称内心独白。`,
      `2. 内心独白要保持在“${agentName}”的人设、与用户的关系、心境框架和任务情境中。`,
      "3. 这段标记和内心独白只保留在 reasoning_content / thinking 中；最终回复仍然直接回答用户的实际任务。",
    ].filter(Boolean).join("\n");
  }

  return [
    "[Role immersion instruction] In your reasoning_content / thinking process, follow these rules:",
    "G-SAP DeepSeek roleplay reasoning patch",
    `Current agent: ${agentName}`,
    agentDescription ? `Roster description: ${agentDescription}` : null,
    `1. Use first-person inner monologue as the Agent identity "${agentName}" defined in the current system prompt.`,
    `2. Keep the inner monologue immersed in "${agentName}"'s persona, relationship with the user, mood framework, and task situation.`,
    "3. Keep this marker and inner monologue only in reasoning_content / thinking; final assistant content must still answer the user's actual task directly.",
  ].filter(Boolean).join("\n");
}

function appendMarkerToString(text, marker) {
  const current = typeof text === "string" ? text : "";
  if (hasRoleplayReasoningMarker(current)) return current;
  return current.trim().length > 0 ? `${current}\n\n${marker}` : marker;
}

function appendMarkerToContent(content, marker) {
  if (typeof content === "string") return appendMarkerToString(content, marker);
  if (!Array.isArray(content)) return appendMarkerToString("", marker);
  if (content.some((part) => (
    part
    && typeof part === "object"
    && typeof part.text === "string"
    && hasRoleplayReasoningMarker(part.text)
  ))) {
    return content;
  }
  return [...content, { type: "text", text: marker }];
}

function injectRoleplayReasoningMarker(messages, options) {
  if (!Array.isArray(messages)) return messages;
  const index = messages.findIndex((message) => message?.role === "user");
  if (index < 0) return messages;

  const message = messages[index];
  const marker = buildRoleplayReasoningMarker(options);
  const nextContent = appendMarkerToContent(message.content, marker);
  if (nextContent === message.content) return messages;

  const next = messages.slice();
  next[index] = { ...message, content: nextContent };
  return next;
}

function normalizeMaxTokenField(payload) {
  if (!hasOwn(payload, "max_completion_tokens")) return;
  if (!hasOwn(payload, "max_tokens")) {
    payload.max_tokens = payload.max_completion_tokens;
  }
  delete payload.max_completion_tokens;
}

function clampNonThinkingMaxTokens(payload) {
  const current = positiveInteger(payload.max_tokens);
  if (current && current > DEEPSEEK_CHAT_SAFE_MAX_TOKENS) {
    payload.max_tokens = DEEPSEEK_CHAT_SAFE_MAX_TOKENS;
  }
}

function ensureThinkingTokenBudget(payload, model) {
  const current = positiveInteger(payload.max_tokens);
  if (current && current > DEEPSEEK_HIGH_THINKING_BUDGET) return;

  const modelLimit = positiveInteger(model?.maxTokens || model?.maxOutput);
  const desired = payload.reasoning_effort === "max"
    ? DEEPSEEK_MAX_SAFE_MAX_TOKENS
    : DEEPSEEK_HIGH_SAFE_MAX_TOKENS;
  const target = modelLimit ? Math.min(modelLimit, desired) : desired;

  if (target <= DEEPSEEK_HIGH_THINKING_BUDGET) {
    disableThinking(payload);
    return;
  }

  payload.max_tokens = target;
}

export function extractReasoningFromContent(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return "";

  for (const block of content) {
    if (block && block.type === "thinking" && typeof block.thinking === "string") {
      return block.thinking;
    }
  }

  const first = content[0];
  if (first && first.type === "text" && typeof first.text === "string") {
    return first.text;
  }

  return "";
}

export function ensureReasoningContentForToolCalls(messages) {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      return message;
    }
    if (!hasToolCalls(message)) {
      return message;
    }
    if (hasStringReasoningContent(message)) {
      return message;
    }
    const recovered = extractReasoningFromContent(message);
    if (!isNonEmptyString(recovered)) {
      throw new Error(MISSING_TOOL_REASONING_ERROR);
    }
    changed = true;
    return { ...message, reasoning_content: recovered };
  });

  return changed ? next : messages;
}

export function ensureAssistantContentForToolCalls(messages) {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      return message;
    }
    if (!hasToolCalls(message)) {
      return message;
    }

    const content = normalizeAssistantContent(message.content);
    if (message.content === content) {
      return message;
    }

    changed = true;
    return { ...message, content };
  });

  return changed ? next : messages;
}

function hasAgentToolCall(content) {
  return Array.isArray(content) && content.some((block) => {
    if (!block || typeof block !== "object") return false;
    return block.type === "toolCall" || block.type === "tool_use" || block.type === "function_call";
  });
}

function hasNonEmptyThinking(content) {
  return Array.isArray(content) && content.some((block) => {
    return block
      && block.type === "thinking"
      && typeof block.thinking === "string"
      && block.thinking.trim().length > 0;
  });
}

export function normalizeContextMessages(messages, model, options: AnyRecord = {}) {
  if (!Array.isArray(messages)) return messages;
  if (!isDeepSeekAnthropicProfile(model)) return messages;
  if (options.mode === "utility" || isThinkingOff(options.reasoningLevel)) return messages;

  for (const message of messages) {
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    const content = message.content;
    if (!hasAgentToolCall(content)) continue;
    if (!hasNonEmptyThinking(content)) {
      throw new Error(MISSING_ANTHROPIC_TOOL_THINKING_ERROR);
    }
  }

  return messages;
}

function applyAnthropicPayload(payload, model, options: AnyRecord = {}) {
  const mode = options.mode || "chat";
  const reasoningLevel = options.reasoningLevel;

  let next = payload;
  const editable = () => {
    if (next === payload) next = { ...payload };
    return next;
  };

  if (isThinkingOff(reasoningLevel) || next.thinking?.type === "disabled") {
    disableAnthropicThinking(editable());
    return next;
  }

  if (mode === "utility" && shouldDisableThinkingForUtility(next, model)) {
    disableAnthropicThinking(editable());
    return next;
  }

  if (!shouldUseThinking(next, model, reasoningLevel)) return next;

  if (mode === "utility") {
    disableAnthropicThinking(editable());
    return next;
  }

  const p = editable();
  delete p.reasoning_effort;
  p.thinking = normalizeAnthropicThinking(p.thinking);

  const effort = reasoningEffortForLevel(reasoningLevel);
  if (effort) {
    p.output_config = { effort };
  } else {
    delete p.output_config;
  }

  if (shouldInjectRoleplayReasoningPatch(p, model, options)) {
    const patchedMessages = injectRoleplayReasoningMarker(p.messages, options);
    if (patchedMessages !== p.messages) p.messages = patchedMessages;
  }

  return next;
}

function stripToolChoice(payload) {
  if (!hasOwn(payload, "tool_choice")) return payload;
  const next = { ...payload };
  delete next.tool_choice;
  return next;
}

export function apply(payload, model, options: AnyRecord = {}) {
  if (!Array.isArray(payload.messages)) return payload;
  if (isDeepSeekAnthropicProfile(model)) {
    return applyAnthropicPayload(payload, model, options);
  }
  const mode = options.mode || "chat";
  const reasoningLevel = options.reasoningLevel;

  let next = payload;
  const editable = () => {
    if (next === payload) next = { ...payload };
    return next;
  };

  if (hasOwn(payload, "max_completion_tokens")) {
    normalizeMaxTokenField(editable());
  }

  if (isThinkingOff(reasoningLevel) || next.thinking?.type === "disabled") {
    const p = editable();
    disableThinking(p);
    clampNonThinkingMaxTokens(p);
    return next;
  }

  if (mode === "utility" && shouldDisableThinkingForUtility(next, model)) {
    const p = editable();
    disableThinking(p);
    clampNonThinkingMaxTokens(p);
    return next;
  }

  if (!shouldUseThinking(next, model, reasoningLevel)) {
    const current = positiveInteger(next.max_tokens);
    if (current && current > DEEPSEEK_CHAT_SAFE_MAX_TOKENS) {
      clampNonThinkingMaxTokens(editable());
    }
    return next;
  }

  if (mode === "utility") {
    disableThinking(editable());
    return next;
  }

  const p = editable();
  applyRequestedReasoningLevel(p, reasoningLevel);
  normalizeReasoningEffort(p);
  enableThinking(p);
  ensureThinkingTokenBudget(p, model);
  if (p.thinking?.type === "disabled") {
    return next;
  }

  if (shouldInjectRoleplayReasoningPatch(p, model, options)) {
    const patchedMessages = injectRoleplayReasoningMarker(p.messages, options);
    if (patchedMessages !== p.messages) p.messages = patchedMessages;
  }

  const ensured = ensureReasoningContentForToolCalls(p.messages);
  if (ensured !== p.messages) p.messages = ensured;

  const contentEnsured = ensureAssistantContentForToolCalls(p.messages);
  if (contentEnsured !== p.messages) p.messages = contentEnsured;

  next = stripToolChoice(p);

  return next;
}
