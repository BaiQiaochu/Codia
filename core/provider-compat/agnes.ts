const THINKING_PAYLOAD_FIELDS = [
  "reasoning_effort",
  "thinking",
  "reasoning",
  "enable_thinking",
  "chat_template_kwargs",
];

const THINKING_MESSAGE_FIELDS = [
  "reasoning_content",
  "reasoning",
  "thinking",
];

const THINKING_BLOCK_TYPES = new Set(["thinking", "reasoning"]);

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function baseHost(model) {
  const raw = model?.baseUrl || model?.base_url;
  if (typeof raw !== "string" || raw.trim().length === 0) return "";
  try {
    return new URL(raw.trim()).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${raw.trim()}`).hostname.toLowerCase();
    } catch {
      return raw.trim().toLowerCase().split(/[/?#]/)[0].replace(/:\d+$/, "");
    }
  }
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  if (lower(model.provider) === "agnes") return true;
  const host = baseHost(model);
  return host === "agnes-ai.com" || host.endsWith(".agnes-ai.com");
}

function stripThinkingBlocks(content) {
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const next = [];
  for (const block of content) {
    if (
      block
      && typeof block === "object"
      && (
        THINKING_BLOCK_TYPES.has(lower(block.type))
        || hasOwn(block, "reasoning_content")
        || hasOwn(block, "thinking")
      )
    ) {
      changed = true;
      continue;
    }
    next.push(block);
  }
  return changed ? { content: next, changed } : { content, changed: false };
}

function stripMessageThinking(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { message, changed: false };
  }

  let changed = false;
  const next = { ...message };
  for (const field of THINKING_MESSAGE_FIELDS) {
    if (hasOwn(next, field)) {
      delete next[field];
      changed = true;
    }
  }

  const strippedContent = stripThinkingBlocks(message.content);
  if (strippedContent.changed) {
    next.content = strippedContent.content;
    changed = true;
  }

  return changed ? { message: next, changed } : { message, changed: false };
}

function stripMessageArray(messages) {
  if (!Array.isArray(messages)) return { messages, changed: false };
  let changed = false;
  const next = messages.map((message) => {
    const stripped = stripMessageThinking(message);
    if (stripped.changed) changed = true;
    return stripped.message;
  });
  return changed ? { messages: next, changed } : { messages, changed: false };
}

export function apply(payload) {
  if (!payload || typeof payload !== "object") return payload;

  let changed = false;
  const next = { ...payload };

  for (const field of THINKING_PAYLOAD_FIELDS) {
    if (hasOwn(next, field)) {
      delete next[field];
      changed = true;
    }
  }

  const strippedMessages = stripMessageArray(payload.messages);
  if (strippedMessages.changed) {
    next.messages = strippedMessages.messages;
    changed = true;
  }

  return changed ? next : payload;
}
