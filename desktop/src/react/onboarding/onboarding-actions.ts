/**
  *
 */

import { AGENT_ID } from './constants';
import { DEFAULT_HEARTBEAT_INTERVAL_MINUTES } from '../../../../shared/default-workspace-constants.ts';

export type gsapFetch = (path: string, opts?: RequestInit) => Promise<Response>;

async function saveRequest(fetch: gsapFetch, path: string, options: RequestInit): Promise<void> {
  const response = await fetch(path, options);
  if (response.ok) return;
  let message = `Save failed with HTTP ${response.status}`;
  try {
    const data = await response.json();
    if (typeof data?.error === 'string' && data.error.trim()) message = data.error;
  } catch {
    // A server error may return plain text instead of the usual JSON payload.
  }
  throw new Error(message);
}

// ── Test connection ──

interface TestConnectionParams {
  gsapFetch: gsapFetch;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
}

export interface TestResult {
  ok: boolean;
  text: string;
}

export async function testConnection({ gsapFetch, providerUrl, providerApi, apiKey }: TestConnectionParams): Promise<TestResult> {
  const res = await gsapFetch('/api/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: providerUrl,
      api: providerApi,
      api_key: apiKey,
    }),
  });
  const data = await res.json();
  if (data.ok) {
    return { ok: true, text: t('onboarding.provider.testSuccess') };
  }
  const errorText = typeof data.error === 'string' && data.error.trim()
    ? data.error.trim()
    : t('onboarding.provider.testFailed');
  return { ok: false, text: errorText };
}

// ── Save provider ──

interface SaveProviderParams {
  gsapFetch: gsapFetch;
  providerName: string;
  providerUrl: string;
  apiKey: string;
  providerApi: string;
}

export async function saveProvider({ gsapFetch, providerName, providerUrl, apiKey, providerApi }: SaveProviderParams): Promise<void> {
  await saveRequest(gsapFetch, `/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api: { provider: providerName },
      providers: {
        [providerName]: {
          base_url: providerUrl,
          api_key: apiKey,
          api: providerApi,
        },
      },
    }),
  });
}

// ── Load models ──

interface LoadModelsParams {
  gsapFetch: gsapFetch;
  providerName: string;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  context?: number | null;
  maxOutput?: number | null;
  image?: boolean;
  audio?: boolean;
  reasoning?: boolean;
}

export interface LoadModelsResult {
  models: DiscoveredModel[];
  error?: string;
}

export async function loadModels({ gsapFetch, providerName, providerUrl, providerApi, apiKey }: LoadModelsParams): Promise<LoadModelsResult> {
  const res = await gsapFetch('/api/providers/fetch-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: providerName,
      base_url: providerUrl,
      api: providerApi,
      api_key: apiKey,
    }),
  });
  const data = await res.json();
  if (data.error) {
    return { models: [], error: data.error };
  }
  return { models: data.models || [] };
}

// ── Save model + utility models ──

export interface AddedModelObject {
  id: string;
  name?: string;
  context?: number;
  maxOutput?: number;
  image?: boolean;
  audio?: boolean;
  reasoning?: boolean;
}

export type AddedModelEntry = string | AddedModelObject;

interface SaveModelParams {
  gsapFetch: gsapFetch;
  selectedModel: string;
  providerName: string;
  addedModels: AddedModelEntry[];
  selectedUtility: string;
  selectedUtilityLarge: string;
}

function compactModelEntry(entry: AddedModelEntry): AddedModelEntry {
  if (typeof entry === 'string') return entry;
  const next: AddedModelObject = { id: entry.id };
  const name = entry.name?.trim();
  if (name) next.name = name;
  if (typeof entry.context === 'number' && Number.isFinite(entry.context)) next.context = entry.context;
  if (typeof entry.maxOutput === 'number' && Number.isFinite(entry.maxOutput)) next.maxOutput = entry.maxOutput;
  if (typeof entry.image === 'boolean') next.image = entry.image;
  if (typeof entry.audio === 'boolean') next.audio = entry.audio;
  if (typeof entry.reasoning === 'boolean') next.reasoning = entry.reasoning;
  return Object.keys(next).length === 1 ? next.id : next;
}

export async function saveModel({ gsapFetch, selectedModel, providerName, addedModels, selectedUtility, selectedUtilityLarge }: SaveModelParams): Promise<void> {
  const modelEntries = addedModels.map(compactModelEntry);
  await saveRequest(gsapFetch, `/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      models: { chat: { id: selectedModel, provider: providerName } },
      providers: { [providerName]: { models: modelEntries } },
    }),
  });

  // Save utility models to global preferences
  if (selectedUtility || selectedUtilityLarge) {
    const utilityModels: Record<string, { id: string; provider: string }> = {};
    if (selectedUtility) utilityModels.utility = { id: selectedUtility, provider: providerName };
    if (selectedUtilityLarge) utilityModels.utility_large = { id: selectedUtilityLarge, provider: providerName };
    await saveRequest(gsapFetch, '/api/preferences/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: utilityModels }),
    });
  }
}

// ── Save locale ──

export async function saveLocale(gsapFetch: gsapFetch, locale: string): Promise<void> {
  await saveRequest(gsapFetch, `/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale }),
  });
}

// ── Save user name ──

interface SaveOnboardingIdentityParams {
  gsapFetch: gsapFetch;
  userName: string;
  agentName: string;
  memoryEnabled: boolean;
}

export async function saveOnboardingIdentity({
  gsapFetch,
  userName,
  agentName,
  memoryEnabled,
}: SaveOnboardingIdentityParams): Promise<void> {
  const trimmedUserName = userName.trim();
  const trimmedAgentName = agentName.trim();
  const body: {
    user: { name: string };
    agent?: { name: string };
    memory: { enabled: boolean };
  } = { user: { name: trimmedUserName }, memory: { enabled: memoryEnabled } };
  if (trimmedAgentName) body.agent = { name: trimmedAgentName };

  await saveRequest(gsapFetch, `/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: body.user,
      ...(body.agent ? { agent: body.agent } : {}),
      memory: body.memory,
    }),
  });
}

export async function saveUserName(gsapFetch: gsapFetch, name: string): Promise<void> {
  await saveRequest(gsapFetch, `/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: { name } }),
  });
}

// Workspace

export async function loadDefaultWorkspace(gsapFetch: gsapFetch): Promise<string> {
  const res = await gsapFetch('/api/config/default-workspace');
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.path || '';
}

async function ensureDefaultWorkspace(gsapFetch: gsapFetch): Promise<string> {
  const res = await gsapFetch('/api/config/default-workspace', { method: 'POST' });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.path || '';
}

interface SaveWorkspaceParams {
  gsapFetch: gsapFetch;
  workspacePath: string;
  defaultPath: string;
}

export async function saveWorkspace({ gsapFetch, workspacePath, defaultPath }: SaveWorkspaceParams): Promise<void> {
  const selected = workspacePath.trim();
  if (!selected) throw new Error('workspacePath is required');

  if (selected === defaultPath) {
    await ensureDefaultWorkspace(gsapFetch);
  }

  await saveRequest(gsapFetch, `/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      desk: {
        home_folder: selected,
        heartbeat_enabled: false,
        heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
      },
    }),
  });
}
