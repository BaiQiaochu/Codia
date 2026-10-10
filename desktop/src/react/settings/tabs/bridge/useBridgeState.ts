/**
  *
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../../store';
import { codiaFetch } from '../../api';
import { loadSettingsConfig } from '../../actions';
import { t } from '../../helpers';
import type { BridgePermissionMode, KnownUser } from './BridgeWidgets';

// ── Types ──

interface PlatformStatusBase {
  status?: string;
  error?: string;
  errorType?: string | null;
  errorDetail?: string | null;
  enabled?: boolean;
  agentId?: string | null;
  lastConnectedAt?: number | null;
  lastErrorAt?: number | null;
  lastSyncAt?: number | null;
  lastStatusAt?: number | null;
  retryCount?: number;
  diagnose?: string[];
  syncState?: string;
  adapter?: { platform?: string | null; agentId?: string | null; version?: string | null; statusAt?: number | null };
  capabilities?: BridgePlatformCapabilities | null;
}

interface BridgePlatformCapabilities {
  text?: { receive?: boolean; reply?: boolean; proactive?: boolean; dm?: boolean; group?: boolean };
  media?: {
    inputModes?: string[];
    supportedKinds?: string[];
    requiresReplyContext?: boolean;
  } | null;
  streaming?: { mode?: string; scopes?: string[] } | null;
}

export interface TelegramStatus extends PlatformStatusBase { token?: string }
export interface FeishuStatus extends PlatformStatusBase { appId?: string; appSecret?: string }
export interface DingTalkStatus extends PlatformStatusBase { clientId?: string; clientSecret?: string; robotCode?: string }
export interface WhatsappStatus extends PlatformStatusBase { qrcodeUrl?: string; authenticated?: boolean }
export interface QQStatus extends PlatformStatusBase { appID?: string; appSecret?: string }
export interface WechatStatus extends PlatformStatusBase { token?: string }
export interface AgentlyMailStatus extends PlatformStatusBase {
  configured?: boolean;
  authenticated?: boolean;
  email?: string;
  lastVerifiedAt?: number | null;
  authorizedAt?: number | null;
}

export interface BridgeStatus {
  agentId?: string | null;
  telegram: TelegramStatus;
  feishu: FeishuStatus;
  dingtalk: DingTalkStatus;
  whatsapp: WhatsappStatus;
  qq: QQStatus;
  agentlyMail: AgentlyMailStatus;
  wechat: WechatStatus;
  permissionMode: BridgePermissionMode;
  readOnly: boolean;
  receiptEnabled: boolean;
  richStreamingEnabled: boolean;
  capabilities?: { surfaces?: string[]; platforms?: Record<string, BridgePlatformCapabilities> };
  knownUsers: { telegram?: KnownUser[]; feishu?: KnownUser[]; dingtalk?: KnownUser[]; whatsapp?: KnownUser[]; qq?: KnownUser[]; agentlyMail?: KnownUser[]; wechat?: KnownUser[] };
  owner: { telegram?: string; feishu?: string; dingtalk?: string; whatsapp?: string; qq?: string; agentlyMail?: string; wechat?: string };
}

export type BridgePlatform = 'telegram' | 'feishu' | 'dingtalk' | 'whatsapp' | 'qq' | 'agentlyMail' | 'wechat';

function normalizeBridgeStatus(data: unknown): BridgeStatus | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Partial<BridgeStatus>;
  return {
    agentId: value.agentId || null,
    telegram: value.telegram || {},
    feishu: value.feishu || {},
    dingtalk: value.dingtalk || {},
    whatsapp: value.whatsapp || {},
    qq: value.qq || {},
    agentlyMail: value.agentlyMail || {},
    wechat: value.wechat || {},
    permissionMode: (value.permissionMode || (value.readOnly === true ? 'read_only' : 'auto')) as BridgePermissionMode,
    readOnly: value.readOnly === true,
    receiptEnabled: value.receiptEnabled !== false,
    richStreamingEnabled: value.richStreamingEnabled !== false,
    capabilities: value.capabilities,
    knownUsers: value.knownUsers || {},
    owner: value.owner || {},
  };
}

function bridgeCredentials(status: BridgeStatus | null) {
  return {
    tgToken: status?.telegram?.token || '',
    fsAppId: status?.feishu?.appId || '',
    fsAppSecret: status?.feishu?.appSecret || '',
    dtClientId: status?.dingtalk?.clientId || '',
    dtClientSecret: status?.dingtalk?.clientSecret || '',
    dtRobotCode: status?.dingtalk?.robotCode || '',
    qqAppId: status?.qq?.appID || '',
    qqAppSecret: status?.qq?.appSecret || '',
  };
}

export function useBridgeState() {
  const store = useSettingsStore();
  const { showToast } = store;
  const settingsSnapshot = store.settingsSnapshot.data;
  const snapshotBridgeStatus = settingsSnapshot?.agentId === store.currentAgentId
    ? normalizeBridgeStatus(settingsSnapshot.bridgeStatus)
    : null;
  const snapshotCredentials = bridgeCredentials(snapshotBridgeStatus);
  const initialPublicIshiki = settingsSnapshot?.agentId === store.currentAgentId
    ? settingsSnapshot.publicIshiki || ''
    : '';
  const [status, setStatus] = useState<BridgeStatus | null>(() => snapshotBridgeStatus);
  const [testingPlatform, setTestingPlatform] = useState<BridgePlatform | null>(null);
  const [reconnectingPlatform, setReconnectingPlatform] = useState<BridgePlatform | null>(null);
  const [globalSettingsSaving, setGlobalSettingsSaving] = useState(false);

  // Selected agent for bridge config (independent of Agent tab selection)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    store.currentAgentId
  );
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  // Sync initial value when store becomes ready (only if null)
  useEffect(() => {
    if (selectedAgentId) return;
    if (store.currentAgentId) setSelectedAgentId(store.currentAgentId);
  }, [selectedAgentId, store.currentAgentId]);

 //
  const [publicIshiki, setPublicIshiki] = useState(initialPublicIshiki);
  const [publicIshikiOriginal, setPublicIshikiOriginal] = useState(initialPublicIshiki);

  // Credential fields
  const [tgToken, setTgToken] = useState(snapshotCredentials.tgToken);
  const [fsAppId, setFsAppId] = useState(snapshotCredentials.fsAppId);
  const [fsAppSecret, setFsAppSecret] = useState(snapshotCredentials.fsAppSecret);
  const [dtClientId, setDtClientId] = useState(snapshotCredentials.dtClientId);
  const [dtClientSecret, setDtClientSecret] = useState(snapshotCredentials.dtClientSecret);
  const [dtRobotCode, setDtRobotCode] = useState(snapshotCredentials.dtRobotCode);
  const [qqAppId, setQqAppId] = useState(snapshotCredentials.qqAppId);
  const [qqAppSecret, setQqAppSecret] = useState(snapshotCredentials.qqAppSecret);

  const applyStatus = useCallback((nextStatus: BridgeStatus | null) => {
    setStatus(nextStatus);
    const nextCredentials = bridgeCredentials(nextStatus);
    setTgToken(nextCredentials.tgToken);
    setFsAppId(nextCredentials.fsAppId);
    setFsAppSecret(nextCredentials.fsAppSecret);
    setDtClientId(nextCredentials.dtClientId);
    setDtClientSecret(nextCredentials.dtClientSecret);
    setDtRobotCode(nextCredentials.dtRobotCode);
    setQqAppId(nextCredentials.qqAppId);
    setQqAppSecret(nextCredentials.qqAppSecret);
  }, []);

  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId !== selectedAgentId) return;
    const nextStatus = normalizeBridgeStatus(settingsSnapshot.bridgeStatus);
    if (nextStatus) applyStatus(nextStatus);
  }, [applyStatus, selectedAgentId, settingsSnapshot]);

  // Fetch public ishiki for selected agent (abort stale requests on agent switch)
  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId === selectedAgentId) {
      const content = settingsSnapshot.publicIshiki || '';
      setPublicIshiki(content);
      setPublicIshikiOriginal(content);
      return;
    }
    const ac = new AbortController();
    codiaFetch(`/api/agents/${selectedAgentId}/public-ishiki`, { signal: ac.signal })
      .then(r => r.json())
      .then(data => { setPublicIshiki(data.content || ''); setPublicIshikiOriginal(data.content || ''); })
      .catch(err => { if (err?.name !== 'AbortError') console.warn('[bridge] fetch public-ishiki failed:', err); });
    return () => ac.abort();
  }, [selectedAgentId, settingsSnapshot]);

  const savePublicIshiki = async () => {
    const agentId = selectedAgentId;
    if (!agentId || publicIshiki === publicIshikiOriginal) return;
    try {
      await codiaFetch(`/api/agents/${agentId}/public-ishiki`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: publicIshiki }),
      });
      setPublicIshikiOriginal(publicIshiki);
      showToast(t('settings.saved'), 'success');
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const query = selectedAgentId ? `?agentId=${encodeURIComponent(selectedAgentId)}` : '';
      const res = await codiaFetch(`/api/bridge/status${query}`, signal ? { signal } : undefined);
      const data = await res.json();
      if (signal?.aborted) return;
      applyStatus(normalizeBridgeStatus(data));
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      console.error('[bridge] load status failed:', err);
    }
  }, [applyStatus, selectedAgentId]);

  // Auto-fetch when selectedAgentId changes (abort stale on switch)
  useEffect(() => {
    if (!selectedAgentId) return;
    const ac = new AbortController();
    loadStatus(ac.signal);
    return () => ac.abort();
  }, [selectedAgentId, loadStatus]);

  useEffect(() => {
    const handler = () => loadStatus();
    window.addEventListener('codia-bridge-reload', handler);
    return () => window.removeEventListener('codia-bridge-reload', handler);
  }, [loadStatus]);

  const saveBridgeConfig = async (plat: string, credentials: Record<string, string> | null, enabled?: boolean) => {
    // Snapshot agentId at call time to avoid stale closure
    const agentId = selectedAgentId;
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      await codiaFetch(`/api/bridge/config${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials, enabled }),
      });
      showToast(t('settings.saved'), 'success');
      // Only reload if user hasn't switched agent during the save (read latest from ref)
      if (selectedAgentIdRef.current === agentId) await loadStatus();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const testPlatform = async (plat: BridgePlatform, credentials: Record<string, string>) => {
    setTestingPlatform(plat);
    try {
      const res = await codiaFetch('/api/bridge/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials }),
      });
      const data = await res.json();
      if (data.ok) {
        const info = plat === 'telegram' ? ` @${data.info?.username || ''}` : '';
        showToast(t('settings.bridge.testOk') + info, 'success');
      } else {
        showToast(t('settings.bridge.testFail') + ': ' + (data.error || ''), 'error');
      }
    } catch (err: unknown) {
      showToast(t('settings.bridge.testFail') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setTestingPlatform(null);
    }
  };

  const setOwner = async (plat: string, userId: string) => {
    const agentId = selectedAgentId;
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      await codiaFetch(`/api/bridge/owner${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, userId: userId || null }),
      });
      showToast(t('settings.bridge.ownerSaved'), 'success');
    } catch {
      showToast(t('settings.saveFailed'), 'error');
    }
  };

  const reconnectPlatform = async (plat: BridgePlatform) => {
    const agentId = selectedAgentId;
    setReconnectingPlatform(plat);
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const res = await codiaFetch(`/api/bridge/reconnect${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat }),
      });
      const data = await res.json();
      if (data?.ok === false) {
        throw new Error(data.error || t('settings.bridge.diagReconnectFailed'));
      }
      showToast(t('settings.bridge.diagReconnectSuccess'), 'success');
    } catch (err: unknown) {
      showToast(t('settings.bridge.diagReconnectFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      if (selectedAgentIdRef.current === agentId) await loadStatus();
      setReconnectingPlatform(null);
    }
  };

  const saveGlobalSettings = async (partial: { permissionMode?: BridgePermissionMode; readOnly?: boolean; receiptEnabled?: boolean; richStreamingEnabled?: boolean }) => {
    setGlobalSettingsSaving(true);
    try {
      const res = await codiaFetch('/api/bridge/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      const saved = await res.json();
      if (saved.error) throw new Error(saved.error);
      if (
        typeof saved.permissionMode === 'string'
        && typeof saved.readOnly === 'boolean'
        && typeof saved.receiptEnabled === 'boolean'
        && typeof saved.richStreamingEnabled === 'boolean'
      ) {
        setStatus(prev => prev ? {
          ...prev,
          permissionMode: saved.permissionMode,
          readOnly: saved.readOnly,
          receiptEnabled: saved.receiptEnabled,
          richStreamingEnabled: saved.richStreamingEnabled,
        } : prev);
      }
      showToast(t('settings.saved'), 'success');
      await Promise.all([
        loadStatus(),
        loadSettingsConfig(),
      ]);
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setGlobalSettingsSaving(false);
    }
  };

  return {
    status, testingPlatform, reconnectingPlatform, globalSettingsSaving, showToast, loadStatus,
    selectedAgentId, setSelectedAgentId,
    publicIshiki, setPublicIshiki, savePublicIshiki,
    tgToken, setTgToken,
    fsAppId, setFsAppId, fsAppSecret, setFsAppSecret,
    dtClientId, setDtClientId, dtClientSecret, setDtClientSecret, dtRobotCode, setDtRobotCode,
    qqAppId, setQqAppId, qqAppSecret, setQqAppSecret,
    saveBridgeConfig, testPlatform, setOwner, reconnectPlatform, saveGlobalSettings,
  };
}
