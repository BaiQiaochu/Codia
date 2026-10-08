import { getReasoningProfile, getThinkingFormat } from "../../shared/model-capabilities.ts";
import {
  ensureReasoningContentForToolCalls as ensureReasoningContentForToolCallsBase,
  stripReasoningContent,
} from "./reasoning-content-replay.ts";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const MFJS_PARENT_ANNOTATION_KEYS = new Set(["description", "default"]);
const ROOT_ANY_OF_ARGUMENT_GUIDANCE_PREFIX = "Arguments must satisfy one of these required field sets:";

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  return getThinkingFormat(model) === "kimi"
    || getReasoningProfile(model) === "kimi-openai";
}

function isThinkingOff(level) {
  return level === "off" || level === "none" || level === "disabled";
}

function reasoningEffortForLevel(level) {
  if (level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "high" || level === "xhigh" || level === "max") return "high";
  return null;
}

function normalizeThinking(thinking) {
  const next: { type: string; keep?: unknown } = { type: "enabled" };
  if (thinking && typeof thinking === "object" && !Array.isArray(thinking) && hasOwn(thinking, "keep")) {
    next.keep = thinking.keep;
  }
  return next;
}

function normalizeMaxCompletionTokenField(payload) {
  if (!hasOwn(payload, "max_tokens")) return;
  if (!hasOwn(payload, "max_completion_tokens")) {
    payload.max_completion_tokens = payload.max_tokens;
  }
  delete payload.max_tokens;
}

function disableThinking(payload) {
  delete payload.reasoning_effort;
  payload.thinking = { type: "disabled" };
  if (Array.isArray(payload.messages)) {
    const stripped = stripReasoningContent(payload.messages);
    if (stripped !== payload.messages) payload.messages = stripped;
  }
}

function shouldDisableThinking(payload, model, options) {
  if (options?.mode === "utility") return true;
  if (isThinkingOff(options?.reasoningLevel)) return true;
  if (model?.reasoning === false) return true;
  return payload.thinking?.type === "disabled";
}

function shouldEnableThinking(payload, model, options) {
  return Boolean(
    model?.reasoning === true
    || payload.reasoning_effort
    || payload.thinking
    || reasoningEffortForLevel(options?.reasoningLevel)
  );
}

function ensureReasoningContentForToolCalls(messages) {
  return ensureReasoningContentForToolCallsBase(messages, { providerLabel: "Kimi" });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeSchemaForAnyOf(shared, branch) {
  const merged = { ...shared, ...branch };

  if (isPlainObject(shared.properties) || isPlainObject(branch.properties)) {
    merged.properties = {
      ...(isPlainObject(shared.properties) ? shared.properties : {}),
      ...(isPlainObject(branch.properties) ? branch.properties : {}),
    };
  }

  if (Array.isArray(shared.required) || Array.isArray(branch.required)) {
    merged.required = [
      ...new Set([
        ...(Array.isArray(shared.required) ? shared.required : []),
        ...(Array.isArray(branch.required) ? branch.required : []),
      ]),
    ];
  }

  return merged;
}

function formatRequiredFieldSets(anyOf) {
  if (!Array.isArray(anyOf)) return null;

  const sets = anyOf.map((item) => {
    if (!isPlainObject(item)) return null;
    const keys = Object.keys(item);
    if (keys.length !== 1 || !Array.isArray(item.required)) return null;
    const required = item.required.filter((field) => typeof field === "string");
    if (required.length !== item.required.length || required.length === 0) return null;
    return required.join(", ");
  });

  if (sets.some((set) => !set)) return null;
  return sets.join("; ");
}

function appendSchemaDescription(description, addition) {
  if (!addition) return description;
  if (typeof description !== "string" || description.trim().length === 0) return addition;
  if (description.includes(addition)) return description;
  return `${description.trim()} ${addition}`;
}

function normalizeFunctionParametersRootAnyOf(schema) {
  if (!Array.isArray(schema.anyOf) || schema.type !== "object") return schema;

  const { anyOf, ...rootObject } = schema;
  const requiredSets = formatRequiredFieldSets(anyOf);
  if (!requiredSets) return rootObject;

  return {
    ...rootObject,
    description: appendSchemaDescription(
      rootObject.description,
      `${ROOT_ANY_OF_ARGUMENT_GUIDANCE_PREFIX} ${requiredSets}.`,
    ),
  };
}

function distributeTypeIntoAnyOf(schema) {
  if (!Array.isArray(schema.anyOf) || !hasOwn(schema, "type")) return schema;

  const shared: Record<string, any> = {};
  const parent: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "anyOf") continue;
    if (MFJS_PARENT_ANNOTATION_KEYS.has(key)) {
      parent[key] = value;
    } else {
      shared[key] = value;
    }
  }

  return {
    ...parent,
    anyOf: schema.anyOf.map((item) => (
      isPlainObject(item) ? mergeSchemaForAnyOf(shared, item) : item
    )),
  };
}

function normalizeSchemaForMoonshotMfjs(schema, options: Record<string, any> = {}) {
  if (Array.isArray(schema)) {
    let changed = false;
    const next = schema.map((item) => {
      const normalized = normalizeSchemaForMoonshotMfjs(item);
      if (normalized !== item) changed = true;
      return normalized;
    });
    return changed ? next : schema;
  }

  if (!isPlainObject(schema)) return schema;

  let changed = false;
  const next: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    const normalized = normalizeSchemaForMoonshotMfjs(value);
    next[key] = normalized;
    if (normalized !== value) changed = true;
  }

  const candidate = changed ? next : schema;
  if (options.functionParametersRoot) {
    const normalizedRoot = normalizeFunctionParametersRootAnyOf(candidate);
    return normalizedRoot === candidate ? candidate : normalizedRoot;
  }

  const distributed = distributeTypeIntoAnyOf(candidate);
  return distributed === candidate ? candidate : distributed;
}

function normalizeToolsForMoonshotMfjs(tools) {
  if (!Array.isArray(tools)) return tools;

  let changed = false;
  const nextTools = tools.map((tool) => {
    const fn = tool?.function;
    if (!fn || !hasOwn(fn, "parameters")) return tool;

    const parameters = fn.parameters;
    const normalizedParameters = normalizeSchemaForMoonshotMfjs(parameters, {
      functionParametersRoot: true,
    });
    if (normalizedParameters === parameters) return tool;

    changed = true;
    return {
      ...tool,
      function: {
        ...fn,
        parameters: normalizedParameters,
      },
    };
  });

  return changed ? nextTools : tools;
}

export function apply(payload, model, options: Record<string, unknown> = {}) {
  if (!payload || typeof payload !== "object") return payload;

  let next = payload;
  const editable = () => {
    if (next === payload) next = { ...payload };
    return next;
  };

  const normalizedTools = normalizeToolsForMoonshotMfjs(next.tools);
  if (normalizedTools !== next.tools) {
    editable().tools = normalizedTools;
  }

  if (!Array.isArray(next.messages)) return next;

  if (hasOwn(payload, "max_tokens")) {
    normalizeMaxCompletionTokenField(editable());
  }

  if (shouldDisableThinking(next, model, options)) {
    disableThinking(editable());
    return next;
  }

  if (!shouldEnableThinking(next, model, options)) return next;

  const p = editable();
  p.thinking = normalizeThinking(p.thinking);

  const effort = reasoningEffortForLevel(options?.reasoningLevel);
  if (effort) {
    p.reasoning_effort = effort;
  }

  const messages = ensureReasoningContentForToolCalls(p.messages);
  if (messages !== p.messages) p.messages = messages;

  return next;
}
