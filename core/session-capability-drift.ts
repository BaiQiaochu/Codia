import { hashCacheContractValue } from "../lib/llm/cache-prefix-contract.ts";
import { uniqueToolNames } from "../shared/tool-categories.ts";

export const SESSION_CAPABILITY_FINGERPRINT_VERSION = 1;

const MEMORY_SEAM_PATTERN = /\n+(?:## (?:记忆使用规则|Memory Rules)\n[\s\S]*?\n+)?(?=Current date and time: )/g;
const APPEARANCE_SEAM_PATTERN = /\n+(?:## (?:你的样子|Your Appearance)\n[\s\S]*?\n+)?(?=## (?:工作台|工作空间|Workspace|Workspace Scope|Workspace Instructions)\n)/g;
const CLOCK_LINE_PATTERN = /^Current date and time: .*$/gm;

export function normalizeSystemPromptForFingerprint(systemPrompt: unknown): string {
  const text = typeof systemPrompt === "string" ? systemPrompt : String(systemPrompt ?? "");
  return text
    .replace(MEMORY_SEAM_PATTERN, "\n\n")
    .replace(APPEARANCE_SEAM_PATTERN, "\n\n")
    .replace(CLOCK_LINE_PATTERN, "Current date and time: <normalized>");
}

export function computeSessionCapabilityFingerprint({
  toolNames = [],
  systemPrompt = "",
}: {
  toolNames?: string[];
  systemPrompt?: string;
} = {}): string {
  return hashCacheContractValue({
    version: SESSION_CAPABILITY_FINGERPRINT_VERSION,
    toolNames: [...uniqueToolNames(toolNames)].sort(),
    systemPrompt: normalizeSystemPromptForFingerprint(systemPrompt),
  });
}

export function buildSessionCapabilityDrift({
  frozenToolNames = [],
  liveToolNames = [],
  invalidToolNames = [],
  frozenSystemPrompt = "",
  liveSystemPrompt = "",
}: {
  frozenToolNames?: string[];
  liveToolNames?: string[];
  invalidToolNames?: string[];
  frozenSystemPrompt?: string;
  liveSystemPrompt?: string;
} = {}) {
  const frozen = new Set(uniqueToolNames(frozenToolNames));
  const live = new Set(uniqueToolNames(liveToolNames));
  const addedToolNames = [...live].filter((name) => !frozen.has(name)).sort();
  const removedToolNames = [...frozen].filter((name) => !live.has(name)).sort();
  const invalid = [...uniqueToolNames(invalidToolNames)].sort();
  const promptChanged = normalizeSystemPromptForFingerprint(frozenSystemPrompt)
    !== normalizeSystemPromptForFingerprint(liveSystemPrompt);
  const frozenFingerprint = computeSessionCapabilityFingerprint({
    toolNames: frozenToolNames,
    systemPrompt: frozenSystemPrompt,
  });
  const fingerprint = computeSessionCapabilityFingerprint({
    toolNames: liveToolNames,
    systemPrompt: liveSystemPrompt,
  });
  return {
    version: SESSION_CAPABILITY_FINGERPRINT_VERSION,
    fingerprint,
    frozenFingerprint,
    addedToolNames,
    removedToolNames,
    invalidToolNames: invalid,
    promptChanged,
    hasDrift: addedToolNames.length > 0
      || removedToolNames.length > 0
      || invalid.length > 0
      || promptChanged,
  };
}
