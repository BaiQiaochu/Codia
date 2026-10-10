import { useSettingsStore } from './store';
import { codiaFetch } from './api';
import knownModelFallbacks from '../../../../lib/known-model-fallbacks.json';
import knownModels from '../../../../lib/known-models.json';
import registry from '../../shared/theme-registry';
import { API_PROVIDER_PRESETS } from '../utils/provider-presets';
import {
  getErrorMessage,
  isModelDescriptor,
  type GlobalModelsPayload,
  type SettingsConfigPayload,
  type TranslationVars,
} from './shared-types';

const platform = window.platform;

const GLOBAL_CONFIG_KEYS = new Set([
  'locale',
  'timezone',
  'sandbox',
  'sandbox_network',
  'network_proxy',
  'file_backup',
  'update_channel',
  'auto_check_updates',
  'hardware_acceleration',
  'keep_awake',
  'thinking_level',
  'editor',
]);

const GLOBAL_CONFIG_CHILD_KEYS: Record<string, Set<string>> = {
  capabilities: new Set(['learn_skills']),
  desk: new Set(['heartbeat_master']),
  channels: new Set(['enabled']),
  bridge: new Set(['readOnly', 'receiptEnabled']),
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isGlobalConfigOnly(partial: Record<string, unknown>): boolean {
  const entries = Object.entries(partial);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => {
    if (GLOBAL_CONFIG_KEYS.has(key)) return true;
    const childKeys = GLOBAL_CONFIG_CHILD_KEYS[key];
    if (!childKeys || !isPlainRecord(value)) return false;
    const children = Object.keys(value);
    return children.length > 0 && children.every((child) => childKeys.has(child));
  });
}

export function t(key: string, params?: TranslationVars): string;
export function t<T>(key: string, params?: TranslationVars): T;
export function t<T>(key: string, params?: TranslationVars): T | string {
  return (window.t?.(key, params) ?? key) as T | string;
}

export function escapeHtml(str: string): string {

  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function formatContext(n: number): string {
  if (!n) return '';
  if (n >= 1000000) {
    const m = n / 1000000;
    return (Number.isInteger(m) ? m : +m.toFixed(1)) + 'M';
  }
  const k = n / 1024;
  if (Number.isInteger(k)) return k + 'K';
  return Math.round(n / 1000) + 'K';
}

type ModelMeta = {
  displayName?: string;
  name?: string;
  type?: string;
  context?: number | null;
  maxOutput?: number | null;
  image?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  [key: string]: unknown;
};

function lookupReferenceModelMeta(modelId: string, providerId?: string): ModelMeta | null {
  if (!modelId) return null;
  const dict = knownModels as Record<string, Record<string, ModelMeta> | string | null>;
  const fallbacks = knownModelFallbacks as Record<string, ModelMeta | string | null>;
  const bare = modelId.includes('/') ? modelId.split('/').pop()! : null;

  if (providerId) {
    const providerModels = dict[providerId];
    if (typeof providerModels === 'object' && providerModels !== null) {
      if (providerModels[modelId]) return { ...providerModels[modelId], _source: 'reference' };
      if (bare && providerModels[bare]) return { ...providerModels[bare], _source: 'reference' };
    }
  }

  const fallback = fallbacks[modelId];
  if (fallback && typeof fallback === 'object') return { ...fallback, _source: 'reference' };
  if (bare) {
    const bareFallback = fallbacks[bare];
    if (bareFallback && typeof bareFallback === 'object') return { ...bareFallback, _source: 'reference' };
  }

  for (const [key, val] of Object.entries(dict)) {
    if (key === '_comment' || typeof val !== 'object' || val === null) continue;
    if (val[modelId]) return { ...val[modelId], _source: 'reference' };
    if (bare && val[bare]) return { ...val[bare], _source: 'reference' };
  }

  return null;
}

export function lookupModelMeta(modelId: string, providerId?: string): ModelMeta | null {
  if (!modelId) return null;
  const reference = lookupReferenceModelMeta(modelId, providerId);
  const providersSummaryState = useSettingsStore.getState().providersSummary;
  const settingsConfigState = useSettingsStore.getState().settingsConfig as SettingsConfigPayload | null;
  let userEntry: ModelMeta | null = null;
  if (providersSummaryState) {
    const summaries = providerId && providersSummaryState[providerId]
      ? [providersSummaryState[providerId]]
      : Object.values(providersSummaryState);
    for (const summary of summaries) {
      const found = (summary.models || []).find((m) => isModelDescriptor(m) && m.id === modelId);
      if (isModelDescriptor(found)) { userEntry = found; break; }
    }
  }

  const legacyOverride = settingsConfigState?.models?.overrides?.[modelId];

  if (!reference && !userEntry && !legacyOverride) return null;
  return {
    ...(reference || {}),
    ...(userEntry || {}),
    ...(legacyOverride?.displayName ? { displayName: legacyOverride.displayName } : {}),
  };
}

export async function autoSaveConfig(
  partial: Record<string, unknown>,
  opts: { silent?: boolean; refreshModels?: boolean } = {},
): Promise<boolean> {
  const store = useSettingsStore.getState();
  try {
    const globalOnly = isGlobalConfigOnly(partial);
    const configPath = globalOnly
      ? '/api/config'
      : `/api/agents/${store.getSettingsAgentId()}/config`;
    const res = await codiaFetch(configPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!opts.silent) store.showToast(t('settings.autoSaved'), 'success');
    const cfgRes = await codiaFetch(configPath);
    const newConfig = await cfgRes.json() as SettingsConfigPayload;
    const prev = (useSettingsStore.getState().settingsConfig || {}) as SettingsConfigPayload;
    for (const k of ['_identity', '_ishiki', '_userProfile']) {
      if (k in prev && !(k in newConfig)) newConfig[k] = prev[k];
    }
    useSettingsStore.setState({ settingsConfig: newConfig });
    if (opts.refreshModels) platform?.settingsChanged?.('models-changed');
    return true;
  } catch (err: unknown) {
    store.showToast(t('settings.saveFailed') + ': ' + getErrorMessage(err), 'error');
    return false;
  }
}

export async function autoSaveGlobalModels(
  partial: Record<string, unknown>,
  opts: { silent?: boolean } = {},
) {
  const store = useSettingsStore.getState();
  try {
    const res = await codiaFetch('/api/preferences/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!opts.silent) store.showToast(t('settings.autoSaved'), 'success');
    const refreshRes = await codiaFetch('/api/preferences/models');
    const newGlobal = await refreshRes.json() as GlobalModelsPayload;
    useSettingsStore.setState({ globalModelsConfig: newGlobal });
  } catch (err: unknown) {
    store.showToast(t('settings.saveFailed') + ': ' + getErrorMessage(err), 'error');
  }
}

let _savePinsTimer: ReturnType<typeof setTimeout> | null = null;
export function savePins() {
  if (_savePinsTimer) clearTimeout(_savePinsTimer);
  _savePinsTimer = setTimeout(async () => {
    const store = useSettingsStore.getState();
    try {
      const agentId = store.getSettingsAgentId();
      const res = await codiaFetch(`/api/agents/${agentId}/pinned`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pins: store.currentPins }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      store.showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      store.showToast(t('settings.saveFailed') + ': ' + getErrorMessage(err), 'error');
    }
  }, 300);
}

export const PROVIDER_PRESETS = API_PROVIDER_PRESETS;

export const API_FORMAT_OPTIONS = [
  { value: 'openai-completions', label: 'OpenAI Compatible' },
  { value: 'google-generative-ai', label: 'Google Gemini' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-codex-responses', label: 'ChatGPT Codex (Plus/Pro)' },
];

export const CONTEXT_PRESETS = [
  { label: '64K', value: 65536 },
  { label: '128K', value: 131072 },
  { label: '200K', value: 200000 },
  { label: '256K', value: 262144 },
  { label: '1M', value: 1048576 },
];

export const OUTPUT_PRESETS = [
  { label: '8K', value: 8192 },
  { label: '16K', value: 16384 },
  { label: '32K', value: 32768 },
  { label: '64K', value: 65536 },
];

const _themeIds = registry.getThemeIds();
export const VALID_THEMES = [
  _themeIds[0],
  _themeIds[1],
  registry.AUTO_OPTION.id,
  ..._themeIds.slice(2),
];
