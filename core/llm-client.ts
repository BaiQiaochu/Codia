// @ts-nocheck
import { FINAL_PROVIDER_RESPONSE } from "../lib/llm/usage-ledger.ts";
import { usageCostRates } from "../lib/llm/usage-pricing.ts";
import { AppError } from '../shared/errors.ts';
import { errorBus } from '../shared/error-bus.ts';
import { normalizeProviderMessageRoles, normalizeProviderPayload } from './provider-compat.ts';
import {
  serializeOpenAICompatibleContentBlock,
  serializeResponsesContentBlock,
} from './provider-media-serializer.ts';
import { sanitizeMessagesForModel } from './message-sanitizer.ts';
import { logLlmUsage, normalizeLlmUsage } from '../lib/llm/usage-observer.ts';
import {
  buildAnthropicMessagesUrl,
  normalizeProviderBaseUrl,
  shouldUseBearerAuth,
} from '../shared/provider-endpoints.ts';
import { normalizeProviderHeaders } from '../shared/provider-auth.ts';
import { buildProviderCompatOptions } from './llm-request-policy.ts';

function normalizeTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

const THINK_PAIRED_RE = /<(think(?:ing)?|reflect)(?:>|<\|message\|>)\s*([\s\S]*?)<\/\1>\s*/gi;
const THINK_OPEN_ONLY_RE = /<(think(?:ing)?|reflect)(?:>|<\|message\|>)\s*/i;
const THINK_CLOSE_RE = /<\/(?:think(?:ing)?|reflect)>\s*/gi;

function stripTaggedThinking(text) {
  const thinkingParts = [];
  let removedThinking = false;
  let stripped = String(text ?? "")
    .replace(THINK_PAIRED_RE, (_match, _tag, inner) => {
      const thinking = String(inner || "").trim();
      if (thinking) {
        thinkingParts.push(thinking);
        removedThinking = true;
      } else {
        removedThinking = true;
      }
      return "";
    });

  const openMatch = THINK_OPEN_ONLY_RE.exec(stripped);
  if (openMatch) {
    removedThinking = true;
    const before = stripped.slice(0, openMatch.index);
    const after = stripped.slice(openMatch.index + openMatch[0].length);
    const thinking = after.trim();
    if (thinking) thinkingParts.push(thinking);
    stripped = before;
  }

  stripped = stripped.replace(THINK_CLOSE_RE, () => {
    removedThinking = true;
    return "";
  });

  return {
    text: stripped.trim(),
    thinking: thinkingParts.join("\n").trim(),
    removedThinking,
  };
}

function isThinkingBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "thinking" || block.type === "redacted_thinking" || block.type === "reasoning") return true;
  if (typeof block.thinking === "string" || typeof block.reasoning_content === "string") return true;
  return false;
}

function extractAnthropicText(content) {
  if (!Array.isArray(content)) return { text: "", thinking: "", removedThinking: false };
  const thinking = content
    .filter(isThinkingBlock)
    .map(extractThinkingBlockText)
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    text: content
      .filter(c => c?.type === "text" && typeof c.text === "string")
      .map(c => c.text)
      .join("\n")
      .trim(),
    thinking,
    removedThinking: content.some(isThinkingBlock),
  };
}

function extractThinkingBlockText(block) {
  if (!block || typeof block !== "object") return "";
  const parts = [];
  for (const key of ["thinking", "reasoning_content", "text"]) {
    if (typeof block[key] === "string" && block[key].trim()) {
      parts.push(block[key].trim());
    }
  }
  if (typeof block.summary === "string" && block.summary.trim()) {
    parts.push(block.summary.trim());
  } else if (Array.isArray(block.summary)) {
    parts.push(...block.summary
      .map((item) => typeof item?.text === "string" ? item.text.trim() : "")
      .filter(Boolean));
  }
  return parts.join("\n").trim();
}

function extractOutputReasoning(output) {
  if (!Array.isArray(output)) return { removedThinking: false, thinking: "" };
  const parts = [];
  let removedThinking = false;
  for (const item of output) {
    if (isThinkingBlock(item)) {
      removedThinking = true;
      const text = extractThinkingBlockText(item);
      if (text) parts.push(text);
    }
    if (Array.isArray(item?.content)) {
      for (const block of item.content) {
        if (!isThinkingBlock(block)) continue;
        removedThinking = true;
        const text = extractThinkingBlockText(block);
        if (text) parts.push(text);
      }
    }
  }
  return { removedThinking, thinking: parts.join("\n").trim() };
}

function convertContentForApi(content, api) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return typeof content === "undefined" ? "" : JSON.stringify(content);

  if (api === "anthropic-messages") {
    return content.map((block) => {
      if (block?.type === "text") return { type: "text", text: block.text || "" };
      if (block?.type === "image") {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.mimeType || "image/png",
            data: block.data || "",
          },
        };
      }
      return { type: "text", text: JSON.stringify(block) };
    });
  }

  if (api === "openai-responses" || api === "openai-codex-responses") {
    return content.map((block) => {
      return serializeResponsesContentBlock(block);
    });
  }

  return content.map(serializeOpenAICompatibleContentBlock);
}

function textFromApiContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block?.type === "text" || block?.type === "input_text") return block.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function readCodexResponsesStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const textDeltas = [];
  let doneText = "";
  let completedResponse = null;
  let buffer = "";

  const consumeBlock = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    events.push(event);

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      textDeltas.push(event.delta);
    } else if (event.type === "response.output_text.done" && typeof event.text === "string") {
      doneText = event.text;
    } else if (event.type === "response.completed") {
      completedResponse = event.response || event;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(buffer[sep] === "\r" ? sep + 4 : sep + 2);
      consumeBlock(block);
    }
    if (done) break;
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeBlock(buffer);

  const outputText = textDeltas.join("").trim() || doneText.trim();
  // A completed snapshot owns final usage; never borrow earlier partial counters
  // when the terminal response itself omitted usage.
  const usage = completedResponse !== null
    ? completedResponse.usage ?? null
    : events.find((event) => event?.usage)?.usage || null;
  const data = outputText
    ? { ...(completedResponse || {}), output_text: outputText, ...(usage ? { usage } : {}) }
    : completedResponse || { output: events, ...(usage ? { usage } : {}) };
  // This envelope is created by the host reader, not accepted from SSE JSON.
  // EOF and [DONE] without response.completed do not establish final usage.
  return { data, completed: completedResponse !== null };
}

function buildGeminiNativeParts(content) {
  const text = textFromApiContent(content);
  return text ? [{ text }] : [{ text: "" }];
}

function convertMessagesForGeminiNative(messages) {
  const contents = messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: buildGeminiNativeParts(m.content),
    }));
  return contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "" }] }];
}

function extractGeminiNativeText(data) {
  return (data?.candidates || [])
    .flatMap(candidate => candidate?.content?.parts || [])
    .filter(part => typeof part?.text === "string")
    .map(part => part.text)
    .join("\n")
    .trim();
}

function normalizeGeminiNativeUsage(data) {
  const usage = data?.usageMetadata;
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
  };
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Unified non-streaming text generation entry point.
 *
 * `model` can be either a full model object or a legacy model id string. Passing
 * the full object keeps quirks/compat metadata available for provider fixes.
 */
export async function callText({
  api,
  apiKey,
  baseUrl,
  model,
  headers: requestHeaders,
  provider = "custom",
  quirks = [],
  systemPrompt = "",
  messages = [],
  temperature,
  maxTokens,
  outputBudgetSource = "system",
  callPurpose,
  timeoutMs = 60_000,
  signal,
  returnUsage = false,
  usageContext,
  usageLedger,
}) {
  const modelObj = typeof model === "object" && model !== null ? model : null;
  const effectiveCostRates = usageCostRates(modelObj);
  const modelId = modelObj ? modelObj.id : String(model || "");
  const providerId = modelObj?.provider || provider || "custom";
  const explicitMaxTokens = positiveInteger(maxTokens);
  const modelForSanitizer = modelObj
    ? (Array.isArray(modelObj.quirks) ? modelObj : { ...modelObj, quirks })
    : { id: modelId, provider: providerId, quirks };
  const sanitized = sanitizeMessagesForModel(normalizeProviderMessageRoles(messages), modelForSanitizer);
  const safeMessages = sanitized.messages;

  let mergedSystem = systemPrompt || "";
  const normalizedMessages = [];
  for (const m of safeMessages) {
    if (m.role === "system") {
      const text = normalizeTextFromContent(m.content);
      if (text) mergedSystem += (mergedSystem ? "\n" : "") + text;
    } else {
      normalizedMessages.push({
        role: m.role,
        content: convertContentForApi(m.content, api),
      });
    }
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const normalizedBaseUrl = normalizeProviderBaseUrl({ provider: providerId, api, baseUrl });
  const base = (normalizedBaseUrl || "").replace(/\/+$/, "");
  let endpoint;
  let headers;
  let body;

  if (api === "anthropic-messages") {
    endpoint = buildAnthropicMessagesUrl(base);
    headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (apiKey) {
      if (shouldUseBearerAuth({ provider: providerId, api, baseUrl: base })) {
        headers.Authorization = `Bearer ${apiKey}`;
      } else {
        headers["x-api-key"] = apiKey;
      }
    }

    const anthropicMessages = normalizedMessages.filter(m => m.role === "user" || m.role === "assistant");
    if (anthropicMessages.length === 0) anthropicMessages.push({ role: "user", content: "" });
    body = {
      model: modelId,
      ...(temperature !== undefined && { temperature }),
      ...(explicitMaxTokens !== null && { max_tokens: explicitMaxTokens }),
      ...(mergedSystem && { system: mergedSystem }),
      messages: anthropicMessages,
    };
  } else if (api === "openai-responses" || api === "openai-codex-responses") {
    endpoint = `${base}/responses`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    body = {
      model: modelId,
      ...(api === "openai-codex-responses" ? { store: false, stream: true } : {}),
      ...(temperature !== undefined && { temperature }),
      ...(explicitMaxTokens !== null && { max_output_tokens: explicitMaxTokens }),
      ...(mergedSystem && { instructions: mergedSystem }),
      input: normalizedMessages,
    };
  } else if (api === "google-generative-ai") {
    endpoint = `${base}/models/${encodeURIComponent(modelId)}:generateContent`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["x-goog-api-key"] = apiKey;
    const generationConfig = {
      ...(explicitMaxTokens !== null && { maxOutputTokens: explicitMaxTokens }),
      ...(temperature !== undefined && { temperature }),
    };
    body = {
      contents: convertMessagesForGeminiNative(normalizedMessages),
      ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
      ...(mergedSystem && { systemInstruction: { parts: [{ text: mergedSystem }] } }),
    };
  } else {
    endpoint = `${base}/chat/completions`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const allMessages = [];
    if (mergedSystem) allMessages.push({ role: "system", content: mergedSystem });
    allMessages.push(...normalizedMessages);
    body = {
      model: modelId,
      ...(temperature !== undefined && { temperature }),
      ...(explicitMaxTokens !== null && { max_tokens: explicitMaxTokens }),
      messages: allMessages,
    };
  }

  const modelHeaders = normalizeProviderHeaders(modelObj?.headers);
  const optionHeaders = normalizeProviderHeaders(requestHeaders);
  if (Object.keys(modelHeaders).length > 0 || Object.keys(optionHeaders).length > 0) {
    headers = { ...headers, ...modelHeaders, ...optionHeaders };
  }

  const modelForCompat = modelObj
    ? (
      Array.isArray(modelObj.quirks)
        ? {
          ...modelObj,
          provider: modelObj.provider || providerId,
          api: modelObj.api || api,
          baseUrl: modelObj.baseUrl || normalizedBaseUrl,
        }
        : {
          ...modelObj,
          provider: modelObj.provider || providerId,
          api: modelObj.api || api,
          baseUrl: modelObj.baseUrl || normalizedBaseUrl,
          quirks,
        }
    )
    : { id: modelId, provider: providerId, api, baseUrl: normalizedBaseUrl, quirks };
  body = normalizeProviderPayload(body, modelForCompat, buildProviderCompatOptions({
    mode: "utility",
    callPurpose,
    explicitMaxTokens,
    outputBudgetSource,
  }));

  const usageRequest = usageLedger?.start?.({
    model: { ...modelObj, provider: providerId, modelId, api },
    maxOutputTokens: explicitMaxTokens,
    usageContext,
    costRates: effectiveCostRates,
  }) || null;
  let observedUsagePayload = null;
  let observedUsageIsFinal = false;
  let usageRequestClosed = false;

  try {
  const SLOW_THRESHOLD_MS = 15_000;
  const slowTimer = setTimeout(() => {
    errorBus.report(new AppError('LLM_SLOW_RESPONSE', {
      context: { model: modelId, provider: providerId, elapsed: SLOW_THRESHOLD_MS },
    }));
  }, SLOW_THRESHOLD_MS);

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: combinedSignal,
  }).catch(err => {
    clearTimeout(slowTimer);
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new AppError('LLM_TIMEOUT', { context: { model: modelId }, cause: err });
    }
    throw err;
  });

  let rawText = "";
  let data;
  let usedStreamReader = false;
  let streamCompleted = false;
  try {
    if (res.ok && api === "openai-codex-responses" && res.body && typeof res.body.getReader === "function") {
      usedStreamReader = true;
      const streamed = await readCodexResponsesStream(res.body);
      data = streamed.data;
      streamCompleted = streamed.completed;
      rawText = JSON.stringify(data);
    } else {
      rawText = await res.text();
    }
  } catch (err) {
    clearTimeout(slowTimer);
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new AppError('LLM_TIMEOUT', { context: { model: modelId }, cause: err });
    }
    throw err;
  }
  clearTimeout(slowTimer);
  if (!data) {
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      throw new Error(`LLM returned invalid JSON (status=${res.status})`);
    }
  }

  if (!res.ok) {
    const message = data?.error?.message || data?.message || rawText || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new AppError('LLM_AUTH_FAILED', { context: { model: modelId, status: res.status } });
    }
    if (res.status === 429) {
      throw new AppError('LLM_RATE_LIMITED', { context: { model: modelId } });
    }
    throw new AppError('UNKNOWN', { message, context: { model: modelId, status: res.status } });
  }
  observedUsageIsFinal = (!usedStreamReader || streamCompleted)
    && data !== null && typeof data === "object" && !data.error
    && !["failed", "incomplete", "cancelled", "in_progress", "queued"].includes(data.status);
  observedUsagePayload = api === "google-generative-ai" ? normalizeGeminiNativeUsage(data) : data?.usage ?? null;

  let text = "";
  let removedStructuredThinking = false;
  let structuredThinking = "";
  if (api === "anthropic-messages") {
    const extracted = extractAnthropicText(data?.content);
    text = extracted.text;
    removedStructuredThinking = extracted.removedThinking;
    structuredThinking = extracted.thinking;
  } else if (api === "openai-responses" || api === "openai-codex-responses") {
    if (typeof data?.output_text === "string") {
      text = data.output_text.trim();
    } else {
      text = (data?.output || [])
        .filter(item => item?.type === "message" && item?.role === "assistant")
        .flatMap(item => (item.content || []).filter(c => typeof c?.text === "string").map(c => c.text.trim()))
        .join("\n").trim();
    }
    const reasoning = extractOutputReasoning(data?.output);
    removedStructuredThinking = reasoning.removedThinking;
    structuredThinking = reasoning.thinking;
  } else if (api === "google-generative-ai") {
    text = extractGeminiNativeText(data);
  } else {
    const message = data?.choices?.[0]?.message;
    text = (typeof message?.content === "string")
      ? message.content.trim()
      : "";
    removedStructuredThinking = typeof message?.reasoning_content === "string"
      || typeof message?.thinking === "string";
    structuredThinking = [
      typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "",
      typeof message?.thinking === "string" ? message.thinking.trim() : "",
    ].filter(Boolean).join("\n");
  }

  const rawTextBeforeThinkingStrip = text;
  const thinkingStripped = stripTaggedThinking(text);
  text = thinkingStripped.text;
  const thinkingFallback = [
    thinkingStripped.thinking,
    structuredThinking,
  ].filter(Boolean).join("\n").trim();
  const emptyAfterThinking = !text && (
    removedStructuredThinking
    || !!thinkingFallback
    || (thinkingStripped.removedThinking && rawTextBeforeThinkingStrip.trim())
  );

  if (!text) {
    if (combinedSignal.aborted) {
      throw new AppError('LLM_TIMEOUT', { context: { model: modelId } });
    }
    throw new AppError('LLM_EMPTY_RESPONSE', {
      message: emptyAfterThinking
        ? "LLM returned only thinking content without visible text"
        : undefined,
      context: {
        model: modelId,
        ...(emptyAfterThinking ? { reason: "empty_after_thinking" } : {}),
      },
    });
  }

  // Preserve existing partial-text behavior, but never settle incomplete SSE usage.
  const rawUsage = observedUsageIsFinal ? observedUsagePayload : null;
  const usage = normalizeLlmUsage(rawUsage, { costRates: effectiveCostRates });
  logLlmUsage({
    source: "utility",
    api,
    provider: providerId,
    modelId,
    usage: rawUsage,
    costRates: effectiveCostRates,
  });
  usageLedger?.finish?.(usageRequest?.requestId, {
    usage: rawUsage,
    model: { provider: providerId, modelId, api },
    costRates: effectiveCostRates,
  });
  usageRequestClosed = true;

  return returnUsage ? { text, usage } : text;
  } catch (err) {
    if (usageRequest?.requestId && !usageRequestClosed) {
      const status = err?.name === "AbortError" || err?.type === "aborted" ? "aborted" : "error";
      usageLedger?.recordError?.(usageRequest.requestId, err, status, {
        [FINAL_PROVIDER_RESPONSE]: observedUsageIsFinal && err?.code === "LLM_EMPTY_RESPONSE",
        usage: observedUsagePayload,
        model: { provider: providerId, modelId, api },
        costRates: effectiveCostRates,
      });
    }
    throw err;
  }
}
