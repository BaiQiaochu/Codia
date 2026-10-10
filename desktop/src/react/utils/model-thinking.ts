export interface ThinkingModelLike {
  id?: string;
  name?: string;
  displayName?: string;
  provider?: string;
  reasoning?: boolean;
  thinkingLevels?: readonly string[];
  xhigh?: boolean;
  quirks?: readonly string[];
  compat?: ({
    api?: string;
    thinkingFormat?: string;
  } & Record<string, unknown>) | null;
  api?: string;
  baseUrl?: string;
  base_url?: string;
}

const OPENAI_XHIGH_MODEL_MARKERS = [
  'gpt-6',
  'gpt-5',
  'gpt-5.2',
  'gpt-5.3',
  'gpt-5.4',
  'gpt-5.5',
];

const ANTHROPIC_MAX_EFFORT_MODEL_MARKERS = [
  'fable-5',
  'opus-5-5',
  'opus-5.5',
  'sonnet-5-5',
  'sonnet-5.5',
  'opus-4-6',
  'opus-4.6',
  'opus-4-7',
  'opus-4.7',
  'sonnet-4-6',
  'sonnet-4.6',
];

export function shouldShowThinkingControl(
  currentModel: ThinkingModelLike | null | undefined,
  models: readonly ThinkingModelLike[] = [],
): boolean {
  if (!currentModel) return true;
  if (currentModel.reasoning !== false) return true;
  return hasControllableThinking(currentModel) || hasControllableThinking(findFullModel(currentModel, models));
}

function hasControllableThinking(model: ThinkingModelLike | null | undefined): boolean {
  if (!model) return false;
  if (Array.isArray(model.thinkingLevels) && model.thinkingLevels.some(level => level && level !== 'off')) return true;
  if (Array.isArray(model.quirks) && model.quirks.includes('enable_thinking')) return true;
  return model.compat?.thinkingFormat === 'qwen' || model.compat?.thinkingFormat === 'qwen-chat-template';
}

export function modelSupportsXhigh(
  currentModel: ThinkingModelLike | null | undefined,
  models: readonly ThinkingModelLike[] = [],
): boolean {
  return hasXhighCapability(currentModel) || hasXhighCapability(findFullModel(currentModel, models));
}

function hasXhighCapability(model: ThinkingModelLike | null | undefined): boolean {
  if (!model) return false;
  const markerText = lower([model.id, model.name, model.displayName].filter(Boolean).join(' '));
  return model.xhigh === true
    || idIncludesAny(markerText, OPENAI_XHIGH_MODEL_MARKERS)
    || isGpt5FamilyId(markerText)
    || modelSupportsAnthropicMaxEffort(model);
}

function modelSupportsAnthropicMaxEffort(model: ThinkingModelLike): boolean {
  const id = lower(model.id);
  const provider = lower(model.provider);
  const api = lower(model.api || model.compat?.api);
  const baseUrl = lower(model.baseUrl || model.base_url);
  const usesAnthropicEffort = provider === 'anthropic'
    || api === 'anthropic-messages'
    || baseUrl.includes('api.anthropic.com');
  return usesAnthropicEffort && idIncludesAny(id, ANTHROPIC_MAX_EFFORT_MODEL_MARKERS);
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function idIncludesAny(id: string, markers: readonly string[]): boolean {
  return markers.some(marker => id.includes(marker));
}

function isGpt5FamilyId(id: string): boolean {
  const compact = id.replace(/[\s_-]+/g, '');
  return /(^|[^a-z0-9])gpt5($|[^a-z0-9]|[0-9])/.test(compact);
}

function findFullModel(
  currentModel: ThinkingModelLike | null | undefined,
  models: readonly ThinkingModelLike[],
): ThinkingModelLike | undefined {
  if (!currentModel) return undefined;
  return models.find((model) => {
    if (!model?.id || model.id !== currentModel.id) return false;
    if (currentModel.provider && model.provider && model.provider !== currentModel.provider) return false;
    return true;
  });
}
