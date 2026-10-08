/**
  *
 */
import { useSettingsStore, type Agent as SettingsAgent, type SettingsSnapshot } from './store';
import { gsapFetch, gsapUrl } from './api';
import { t } from './helpers';
import {
  createRemoteResource,
  failRemoteLoad,
  finishRemoteLoad,
  makeSettingsResourceKey,
  startRemoteLoad,
} from './resource-state';
import {
  getErrorMessage,
  type AgentSwitchPayload,
  type GlobalModelsPayload,
  type HealthPayload,
  type PinsPayload,
  type PluginSettingsPayload,
  type SettingsConfigPayload,
  type TextContentPayload,
} from './shared-types';

const platform = window.platform;

let settingsConfigLoadVersion = 0;
let settingsConfigAbortController: AbortController | null = null;
let settingsSnapshotLoadVersion = 0;
let settingsSnapshotAbortController: AbortController | null = null;

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

interface AgentsPayload {
  agents?: SettingsAgent[];
  error?: string;
}

function pickDefaultAgentId(agents: SettingsAgent[]): string | null {
  return (agents.find((agent) => agent.isPrimary) || agents[0])?.id || null;
}

async function resolveSettingsAgentId(): Promise<string | null> {
  const store = useSettingsStore.getState();
  const existing = store.getSettingsAgentId();
  if (existing) return existing;

  const known = pickDefaultAgentId(store.agents || []);
  if (known) {
    const currentAgent = store.agents.find((agent) => agent.id === known);
    store.set({
      currentAgentId: known,
      agentYuan: currentAgent?.yuan || store.agentYuan,
      agentName: currentAgent?.name || store.agentName,
    });
    return known;
  }

  await loadAgents();
  return useSettingsStore.getState().getSettingsAgentId();
}

async function readOptionalText(res: Response, fallback = ''): Promise<string> {
  try {
    const data = await res.json() as TextContentPayload;
    return data.content || fallback;
  } catch {
    return fallback;
  }
}

export async function loadAgents() {
  const store = useSettingsStore.getState();
  try {
    const res = await gsapFetch('/api/agents');
    const data = await res.json() as AgentsPayload;
    if (data.error) throw new Error(data.error);
    const agents = data.agents || [];
    let currentAgentId = store.currentAgentId;
    if (!currentAgentId) currentAgentId = pickDefaultAgentId(agents);
    const currentAgent = agents.find((a) => a.id === currentAgentId);
    store.set({
      agents,
      currentAgentId,
      agentYuan: currentAgent?.yuan || store.agentYuan,
      agentName: currentAgent?.name || store.agentName,
    });
  } catch (err) {
    console.error('[agents] load failed:', err);
  }
}

export async function loadAvatars() {
  const ts = Date.now();
  const store = useSettingsStore.getState();
  try {
    const res = await gsapFetch('/api/health');
    const data = await res.json() as HealthPayload;
    const avatars = data.avatars || {};
    for (const role of ['agent', 'user'] as const) {
      if (avatars[role]) {
        const url = gsapUrl(`/api/avatar/${role}?t=${ts}`, { includeTokenQuery: true });
        if (role === 'agent') store.set({ agentAvatarUrl: url });
        else store.set({ userAvatarUrl: url });
      } else {
        if (role === 'agent') store.set({ agentAvatarUrl: null });
        else store.set({ userAvatarUrl: null });
      }
    }
  } catch {
    // Ignore avatar refresh failures and keep existing UI state.
  }
}

export async function loadSettingsConfig() {
  const myVersion = ++settingsConfigLoadVersion;
  if (settingsConfigAbortController) {
    settingsConfigAbortController.abort();
  }
  const controller = new AbortController();
  settingsConfigAbortController = controller;
  try {
    const agentId = await resolveSettingsAgentId();
    if (!agentId) throw new Error('no agent available');
    const storeAtStart = useSettingsStore.getState();
    const resourceKey = makeSettingsResourceKey('config', agentId, storeAtStart.activeServerConnectionId);
    const keepSameOwnerData = storeAtStart.settingsConfigKey === resourceKey;
    storeAtStart.set({
      settingsConfigKey: resourceKey,
      settingsConfigStatus: 'loading',
      settingsConfigError: null,
      ...(keepSameOwnerData ? {} : {
        settingsConfig: null,
        globalModelsConfig: null,
        homeFolder: null,
        currentPins: [],
      }),
    });
    const agentBase = `/api/agents/${agentId}`;
    const [configRes, identityRes, ishikiRes, publicIshikiRes, userProfileRes, pinnedRes, globalModelsRes, experienceRes] =
      await Promise.all([
        gsapFetch(`${agentBase}/config`, { signal: controller.signal }),
        gsapFetch(`${agentBase}/identity`, { signal: controller.signal }),
        gsapFetch(`${agentBase}/ishiki`, { signal: controller.signal }),
        gsapFetch(`${agentBase}/public-ishiki`, { signal: controller.signal }),
        gsapFetch('/api/user-profile', { signal: controller.signal }),
        gsapFetch(`${agentBase}/pinned`, { signal: controller.signal }),
        gsapFetch('/api/preferences/models', { signal: controller.signal }),
        gsapFetch(`${agentBase}/experience`, { signal: controller.signal }).catch((err) => {
          if (isAbortError(err)) throw err;
          return null;
        }),
      ]);

    const config = await configRes.json() as SettingsConfigPayload;
    const globalModels = await globalModelsRes.json() as GlobalModelsPayload;
    config._identity = await readOptionalText(identityRes);
    config._ishiki = await readOptionalText(ishikiRes);
    config._publicIshiki = await readOptionalText(publicIshikiRes);
    config._userProfile = await readOptionalText(userProfileRes);
    const pinnedData = await pinnedRes.json() as PinsPayload;
    config._experience = experienceRes ? await readOptionalText(experienceRes) : '';

    const store = useSettingsStore.getState();
    if (store.settingsConfigKey !== resourceKey) return;
    const currentAgent = store.agents.find((agent) => agent.id === agentId);
    if (myVersion !== settingsConfigLoadVersion) return;
    if (settingsConfigAbortController !== controller) return;

    store.set({
      settingsConfigKey: resourceKey,
      settingsConfigStatus: 'ready',
      settingsConfigError: null,
      currentAgentId: store.currentAgentId || agentId,
      agentName: config.agent?.name || currentAgent?.name || store.agentName,
      userName: config.user?.name || store.userName,
      agentYuan: config.agent?.yuan || currentAgent?.yuan || store.agentYuan,
      settingsConfig: config,
      globalModelsConfig: globalModels,
      homeFolder: config.desk?.home_folder || null,
      currentPins: pinnedData.pins || [],
    });
  } catch (err) {
    if (isAbortError(err)) return;
    console.error('[settings] load failed:', err);
    const latest = useSettingsStore.getState();
    if (myVersion === settingsConfigLoadVersion) {
      latest.set({
        settingsConfigStatus: 'error',
        settingsConfigError: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    if (settingsConfigAbortController === controller) {
      settingsConfigAbortController = null;
    }
  }
}

function configFromSnapshot(snapshot: SettingsSnapshot): SettingsConfigPayload {
  return {
    ...(snapshot.config || {}),
    _identity: snapshot.identity || '',
    _ishiki: snapshot.ishiki || '',
    _publicIshiki: snapshot.publicIshiki || '',
    _userProfile: snapshot.userProfile || '',
    _experience: snapshot.experience || '',
  };
}

function applySettingsSnapshot(snapshot: SettingsSnapshot, resourceKey: string, requestId: number) {
  const latest = useSettingsStore.getState();
  if (latest.settingsSnapshot.key !== resourceKey || latest.settingsSnapshot.requestId !== requestId) return;
  const config = configFromSnapshot(snapshot);
  const configKey = makeSettingsResourceKey('config', snapshot.agentId, latest.activeServerConnectionId);
  const currentAgent = latest.agents.find((agent) => agent.id === snapshot.agentId);
  latest.set({
    settingsSnapshot: finishRemoteLoad(latest.settingsSnapshot, resourceKey, requestId, snapshot),
    settingsConfigKey: configKey,
    settingsConfigStatus: 'ready',
    settingsConfigError: null,
    settingsConfig: config,
    globalModelsConfig: snapshot.globalModels || {},
    homeFolder: config.desk?.home_folder || null,
    currentPins: Array.isArray(snapshot.pinned?.pins) ? snapshot.pinned.pins : [],
    currentAgentId: latest.currentAgentId || snapshot.agentId,
    agentName: config.agent?.name || currentAgent?.name || latest.agentName,
    userName: config.user?.name || latest.userName,
    agentYuan: config.agent?.yuan || currentAgent?.yuan || latest.agentYuan,
    pluginSettingsStatus: 'ready',
    pluginSettingsError: null,
    pluginAllowFullAccess: snapshot.plugins?.allowFullAccess === true,
    pluginDevToolsEnabled: snapshot.plugins?.devToolsEnabled === true,
    pluginUserDir: snapshot.plugins?.userDir || '',
    pluginSettingsTabs: Array.isArray(snapshot.plugins?.settingsTabs) ? snapshot.plugins.settingsTabs : [],
  });
}

export function updateSettingsSnapshot(mutator: (snapshot: SettingsSnapshot) => SettingsSnapshot) {
  const store = useSettingsStore.getState();
  const resource = store.settingsSnapshot || createRemoteResource<SettingsSnapshot>();
  if (!resource.data) return;
  const next = mutator(resource.data);
  store.set({
    settingsSnapshot: {
      ...resource,
      data: next,
      updatedAt: Date.now(),
    },
  });
}

export async function loadSettingsSnapshot(options: { retainSameKeyData?: boolean } = {}) {
  const store = useSettingsStore.getState();
  const myVersion = ++settingsSnapshotLoadVersion;
  if (settingsSnapshotAbortController) {
    settingsSnapshotAbortController.abort();
  }
  const controller = new AbortController();
  settingsSnapshotAbortController = controller;

  const agentId = await resolveSettingsAgentId();
  const resourceKey = makeSettingsResourceKey('snapshot', agentId, store.activeServerConnectionId);
  const currentResource = store.settingsSnapshot || createRemoteResource<SettingsSnapshot>();
  const requestId = currentResource.requestId + 1;
  const configKey = makeSettingsResourceKey('config', agentId, store.activeServerConnectionId);
  const retainSameKeyData = options.retainSameKeyData === true;
  const keepSameConfigOwnerData = retainSameKeyData && store.settingsConfigKey === configKey;

  store.set({
    settingsSnapshot: startRemoteLoad(currentResource, resourceKey, requestId, { retainSameKeyData }),
    settingsConfigKey: configKey,
    settingsConfigStatus: 'loading',
    settingsConfigError: null,
    pluginSettingsStatus: 'loading',
    pluginSettingsError: null,
    ...(keepSameConfigOwnerData ? {} : {
      settingsConfig: null,
      globalModelsConfig: null,
      homeFolder: null,
      currentPins: [],
      pluginAllowFullAccess: undefined,
      pluginDevToolsEnabled: undefined,
      pluginUserDir: '',
      pluginSettingsTabs: [],
    }),
  });

  if (!agentId || !resourceKey) {
    const latest = useSettingsStore.getState();
    latest.set({
      settingsSnapshot: failRemoteLoad(latest.settingsSnapshot, resourceKey, requestId, 'No settings agent selected'),
      settingsConfigStatus: 'error',
      settingsConfigError: 'No settings agent selected',
      settingsConfig: null,
      globalModelsConfig: null,
      homeFolder: null,
      currentPins: [],
      pluginSettingsStatus: 'error',
      pluginSettingsError: 'No settings agent selected',
    });
    return;
  }

  try {
    const res = await gsapFetch(`/api/settings/snapshot?agentId=${encodeURIComponent(agentId)}`, {
      signal: controller.signal,
    });
    const snapshot = await res.json() as SettingsSnapshot & { error?: string };
    if (snapshot.error) throw new Error(snapshot.error);
    if (myVersion !== settingsSnapshotLoadVersion) return;
    if (settingsSnapshotAbortController !== controller) return;
    applySettingsSnapshot(snapshot as SettingsSnapshot, resourceKey, requestId);
  } catch (err) {
    if (isAbortError(err)) return;
    console.error('[settings] snapshot load failed:', err);
    const latest = useSettingsStore.getState();
    if (latest.settingsSnapshot.key === resourceKey && latest.settingsSnapshot.requestId === requestId) {
      latest.set({
        settingsSnapshot: failRemoteLoad(latest.settingsSnapshot, resourceKey, requestId, err),
        settingsConfigStatus: 'error',
        settingsConfigError: err instanceof Error ? err.message : String(err),
        pluginSettingsStatus: 'error',
        pluginSettingsError: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    if (settingsSnapshotAbortController === controller) {
      settingsSnapshotAbortController = null;
    }
  }
}

export async function loadPluginSettings() {
  const store = useSettingsStore.getState();
  store.set({
    pluginSettingsStatus: 'loading',
    pluginSettingsError: null,
    pluginAllowFullAccess: store.pluginSettingsStatus === 'idle' ? undefined : store.pluginAllowFullAccess,
    pluginDevToolsEnabled: store.pluginSettingsStatus === 'idle' ? undefined : store.pluginDevToolsEnabled,
  });
  try {
    const [settingsRes, tabsRes] = await Promise.all([
      gsapFetch('/api/plugins/settings'),
      gsapFetch('/api/plugins/settings-tabs'),
    ]);
    const data = await settingsRes.json() as PluginSettingsPayload;
    const tabs = await tabsRes.json();
    store.set({
      pluginSettingsStatus: 'ready',
      pluginSettingsError: null,
      pluginAllowFullAccess: data.allow_full_access ?? false,
      pluginDevToolsEnabled: data.plugin_dev_tools_enabled ?? false,
      pluginUserDir: data.plugins_dir || '',
      pluginSettingsTabs: Array.isArray(tabs) ? tabs : [],
    });
  } catch (err) {
    console.error('[plugins] load settings failed:', err);
    store.set({
      pluginSettingsStatus: 'error',
      pluginSettingsError: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function browseAgent(agentId: string) {
  useSettingsStore.setState({ settingsAgentId: agentId });
  await loadSettingsConfig();
  await loadAgents();
}

export async function switchToAgent(agentId: string) {
  const store = useSettingsStore.getState();
  try {
    const res = await gsapFetch('/api/agents/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId }),
    });
    const data = await res.json() as AgentSwitchPayload;
    if (data.error) throw new Error(data.error);
    if (!data.agent) throw new Error('missing agent payload');

    store.set({
      settingsAgentId: null,
      currentAgentId: data.agent.id,
      agentName: data.agent.name,
    });
    platform?.settingsChanged?.('agent-switched', {
      agentName: data.agent.name,
      agentId: data.agent.id,
    });
    await loadSettingsConfig();
    await loadAgents();
    store.showToast(t('settings.agent.switched', { name: data.agent.name }), 'success');
  } catch (err: unknown) {
    store.showToast(t('settings.agent.switchFailed') + ': ' + getErrorMessage(err), 'error');
  }
}

export async function setPrimaryAgent(agentId: string) {
  const store = useSettingsStore.getState();
  try {
    const res = await gsapFetch('/api/agents/primary', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId }),
    });
    const data = await res.json() as { error?: string };
    if (data.error) throw new Error(data.error);

    platform?.settingsChanged?.('agent-primary-updated', { agentId });
    await loadAgents();
    store.showToast(t('settings.agent.setPrimary'), 'success');
  } catch (err: unknown) {
    store.showToast(t('settings.agent.setPrimaryFailed') + ': ' + getErrorMessage(err), 'error');
  }
}
