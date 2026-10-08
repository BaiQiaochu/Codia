import * as deepseek from "./provider-compat/deepseek.ts";
import * as minimax from "./provider-compat/minimax.ts";
import * as mimo from "./provider-compat/mimo.ts";
import * as qwen from "./provider-compat/qwen.ts";
import * as zhipu from "./provider-compat/zhipu.ts";
import * as kimi from "./provider-compat/kimi.ts";
import * as volcengine from "./provider-compat/volcengine.ts";
import * as openaiInputAudio from "./provider-compat/openai-input-audio.ts";
import * as openaiVideoUrl from "./provider-compat/openai-video-url.ts";
import * as openrouter from "./provider-compat/openrouter.ts";
import * as anthropic from "./provider-compat/anthropic.ts";
import * as agnes from "./provider-compat/agnes.ts";
import * as codexResponses from "./provider-compat/codex-responses.ts";
import { normalizeImplicitOutputBudget } from "./provider-compat/output-budget.ts";
import { stripOrphanToolResults } from "./provider-compat/tool-pairing.ts";
import {
  getReasoningProfile as getDeclaredReasoningProfile,
  getThinkingFormat as getDeclaredThinkingFormat,
} from "../shared/model-capabilities.ts";
import { getSafeMaxOutputTokens, positiveInteger } from "./model-token-limits.ts";
import { normalizeRequestThinkingLevel } from "./session-thinking-level.ts";

type ProviderCompatModule = {
  matches(model: any): boolean;
  apply(payload: any, model: any, options?: any): any;
  normalizeContextMessages?(messages: any[], model: any, options?: any): any;
};

const PROVIDER_MODULES: ProviderCompatModule[] = [
  deepseek,
  minimax,
  mimo,
  qwen,
  zhipu,
  kimi,
  volcengine,
  openaiInputAudio,
  openaiVideoUrl,
  openrouter,
  anthropic,
  agnes,
  codexResponses,
];
const TOKEN_LIMIT_FIELDS = ["max_completion_tokens", "max_tokens", "max_output_tokens"];
const ATTACHED_IMAGE_MARKER_RE = /\[attached_image:\s*[^\]]+\]\s*/g;
const ATTACHED_VIDEO_MARKER_RE = /\[attached_video:\s*[^\]]+\]\s*/g;
const ATTACHED_AUDIO_MARKER_RE = /\[attached_audio:\s*[^\]]+\]\s*/g;
const PROVIDER_ROLE_ALIASES = new Map([
  ["assistant", "assistant"],
  ["developer", "developer"],
  ["function", "function"],
  ["system", "system"],
  ["tool", "tool"],
  ["user", "user"],
]);

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function normalizeKnownProviderMessageRole(role) {
  if (typeof role !== "string") return role;
  const normalized = PROVIDER_ROLE_ALIASES.get(role.trim().toLowerCase());
  return normalized || role;
}

export function normalizeProviderMessageRoles(messages) {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || typeof message.role !== "string") {
      return message;
    }
    const role = normalizeKnownProviderMessageRole(message.role);
    if (role === message.role) return message;
    changed = true;
    return { ...message, role };
  });

  return changed ? next : messages;
}

function normalizePayloadMessageRoles(payload) {
  let result = payload;
  for (const key of ["messages", "input"]) {
    if (!Array.isArray(result[key])) continue;
    const messages = normalizeProviderMessageRoles(result[key]);
    if (messages === result[key]) continue;
    if (result === payload) result = { ...payload };
    result[key] = messages;
  }
  return result;
}

function stripOrphanToolMessages(payload) {
  if (!Array.isArray(payload.messages)) return payload;
  const repaired = stripOrphanToolResults(payload.messages);
  if (repaired === payload.messages) return payload;
  return { ...payload, messages: repaired };
}

function stripNativeMediaMarkers(payload) {
  if (!Array.isArray(payload.messages)) return payload;

  let changed = false;
  const messages = payload.messages.map((message) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) return message;

    const media = message.content.reduce((acc, block) => {
      if (isImageLikeBlock(block)) acc.image = true;
      if (isVideoLikeBlock(block)) acc.video = true;
      if (isAudioLikeBlock(block)) acc.audio = true;
      return acc;
    }, { image: false, video: false, audio: false });

    if (!media.image && !media.video && !media.audio) return message;

    let messageChanged = false;
    const content = message.content.map((block) => {
      if (!block || typeof block !== "object" || typeof block.text !== "string") return block;
      let text = block.text;
      if (media.image) text = text.replace(ATTACHED_IMAGE_MARKER_RE, "");
      if (media.video) text = text.replace(ATTACHED_VIDEO_MARKER_RE, "");
      if (media.audio) text = text.replace(ATTACHED_AUDIO_MARKER_RE, "");
      if (text === block.text) return block;
      messageChanged = true;
      return { ...block, text: text.replace(/^\s+/, "") };
    }).filter((block) => !(block && typeof block === "object" && block.type === "text" && block.text === ""));

    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });

  return changed ? { ...payload, messages } : payload;
}

function isImageLikeBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "image" || block.type === "image_url" || block.type === "input_image") {
    return !blockHasMediaUrlPrefix(block, "audio/") && !blockHasMediaUrlPrefix(block, "video/");
  }
  if (block.image_url || block.imageUrl || block.image) return true;
  return blockHasMediaUrlPrefix(block, "image/");
}

function isVideoLikeBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "video" || block.type === "video_url" || block.type === "input_video") return true;
  if (block.video_url || block.videoUrl || block.video) return true;
  return blockHasMediaUrlPrefix(block, "video/");
}

function isAudioLikeBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "audio" || block.type === "audio_url" || block.type === "input_audio") return true;
  if (block.audio_url || block.audioUrl || block.audio) return true;
  return blockHasMediaUrlPrefix(block, "audio/");
}

function blockHasMediaUrlPrefix(block, prefix) {
  const values = [
    block.url,
    block.data,
    block.mimeType,
    block.media_type,
    block.image_url?.url,
    block.imageUrl?.url,
    block.audio_url?.url,
    block.audioUrl?.url,
    block.video_url?.url,
    block.videoUrl?.url,
    block.source?.media_type,
    block.source?.mimeType,
  ];
  return values.some((value) => typeof value === "string" && value.toLowerCase().includes(prefix));
}

export function isDeepSeekModel(model) {
  return deepseek.matches(model);
}

export function isAnthropicModel(model) {
  if (!model || typeof model !== "object") return false;
  return lower(model.provider) === "anthropic" || getThinkingFormat(model) === "anthropic";
}

export function getThinkingFormat(model) {
  const declared = getDeclaredThinkingFormat(model);
  if (declared) return declared;
  if (isDeepSeekModel(model)) return "deepseek";
  if (zhipu.matches(model)) return "zhipu";
  if (volcengine.matches(model)) return "volcengine";
  return null;
}

export function getReasoningProfile(model) {
  return getDeclaredReasoningProfile(model);
}

function stripEmptyTools(payload) {
  if (Array.isArray(payload.tools) && payload.tools.length === 0) {
    const { tools: _tools, ...rest } = payload;
    return rest;
  }
  return payload;
}

function stripIncompatibleThinking(payload, model) {
  if (!payload.thinking) return payload;
  if (!model) return payload;
  const thinkingFormat = getThinkingFormat(model);
  if (
    thinkingFormat === "anthropic"
    || thinkingFormat === "deepseek"
    || thinkingFormat === "zhipu"
    || thinkingFormat === "kimi"
    || thinkingFormat === "volcengine"
  ) return payload;
  const { thinking: _thinking, ...rest } = payload;
  return rest;
}

function isDisabledReasoningEffort(value) {
  if (value === false || value == null) return true;
  const normalized = lower(value);
  return normalized === "" || normalized === "none" || normalized === "off" || normalized === "disabled";
}

function stripDisabledReasoningEffort(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")) return payload;
  if (!isDisabledReasoningEffort(payload.reasoning_effort)) return payload;
  const { reasoning_effort: _reasoningEffort, ...rest } = payload;
  return rest;
}

function normalizeAutoReasoningEffort(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")) return payload;
  if (lower(payload.reasoning_effort) !== "auto") return payload;
  return { ...payload, reasoning_effort: "medium" };
}

function normalizeProviderOptions(options: any = {}) {
  if (!Object.prototype.hasOwnProperty.call(options, "reasoningLevel")) return options;
  return {
    ...options,
    reasoningLevel: normalizeRequestThinkingLevel(options.reasoningLevel, "off"),
  };
}

function isToolResultMessage(message: any) {
  return message?.role === "toolResult";
}

function resourceMetadataValue(value: any) {
  return typeof value === "string" && value.trim().length > 0 ? value : "(none)";
}

function formatEmbeddedResourceText(resource: any, body: string) {
  return [
    "[embedded resource]",
    `uri: ${resourceMetadataValue(resource?.uri)}`,
    `name: ${resourceMetadataValue(resource?.name)}`,
    `mimeType: ${resourceMetadataValue(resource?.mimeType)}`,
    "",
    body,
  ].join("\n");
}

function projectResourceBlockToText(block: any) {
  if (!block || typeof block !== "object" || block.type !== "resource") {
    return { block, changed: false };
  }
  const resource = block.resource && typeof block.resource === "object"
    ? block.resource
    : null;
  if (typeof resource?.text === "string") {
    return {
      block: {
        type: "text",
        text: formatEmbeddedResourceText(resource, `content:\n${resource.text}`),
      },
      changed: true,
    };
  }
  const reason = typeof resource?.blob === "string"
    ? "content: [binary resource omitted; no model-visible text was provided]"
    : "content: [resource has no text content]";
  return {
    block: {
      type: "text",
      text: formatEmbeddedResourceText(resource, reason),
    },
    changed: true,
  };
}

function projectToolResultResourcesForModel(messages: any[]) {
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (!isToolResultMessage(message) || !Array.isArray(message?.content)) {
      return message;
    }
    let contentChanged = false;
    const nextContent = message.content.map((block: any) => {
      const projected = projectResourceBlockToText(block);
      if (projected.changed) contentChanged = true;
      return projected.block;
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content: nextContent };
  });
  return changed ? nextMessages : messages;
}

function clampOutputTokens(payload, model) {
  const limit = getSafeMaxOutputTokens(model);
  if (!limit) return payload;

  let next = payload;
  for (const field of TOKEN_LIMIT_FIELDS) {
    const current = positiveInteger(next[field]);
    if (!current || current <= limit) continue;
    if (next === payload) next = { ...payload };
    next[field] = limit;
  }

  return next;
}

/**
 * Shared provider payload compatibility entry point for streaming chat and
 * non-streaming utility requests.
 *
 * @param {object} payload
 * @param {object|null|undefined} model
  *
 */
export function normalizeProviderPayload(payload, model, options: any = {}) {
  if (!payload || typeof payload !== "object") return payload;

  const normalizedOptions = normalizeProviderOptions(options);
  let result = stripEmptyTools(payload);
  result = stripIncompatibleThinking(result, model);
  result = stripDisabledReasoningEffort(result);
  result = normalizeAutoReasoningEffort(result);
  result = clampOutputTokens(result, model);
  result = normalizePayloadMessageRoles(result);
  result = stripOrphanToolMessages(result);
  result = stripNativeMediaMarkers(result);

  for (const mod of PROVIDER_MODULES) {
    if (mod.matches(model)) {
      result = mod.apply(result, model, normalizedOptions);
      break;
    }
  }

  result = normalizeImplicitOutputBudget(result, model, normalizedOptions);

  return result;
}

export function normalizeProviderContextMessages(messages, model, options: any = {}) {
  if (!Array.isArray(messages)) return messages;
  const normalizedOptions = normalizeProviderOptions(options);
  const normalizedMessages = normalizeProviderMessageRoles(messages);
  const result = projectToolResultResourcesForModel(normalizedMessages);

  for (const mod of PROVIDER_MODULES) {
    if (mod.matches(model)) {
      if (typeof mod.normalizeContextMessages === "function") {
        return mod.normalizeContextMessages(result, model, normalizedOptions);
      }
      break;
    }
  }

  return result;
}
