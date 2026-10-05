import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { gsapFetch, gsapUrl } from '../api';
import { t } from '../helpers';
import { useSettingsStore } from '../store';
import {
  LOCAL_CONNECTION_ID,
  connectDeviceServerConnection,
  isLocalOwnerConnection,
  persistServerConnectionSelection,
  upsertServerConnection,
  writePersistedServerConnectionState,
} from '../../services/server-connection';
import { Toggle } from '../widgets/Toggle';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsButton } from '../components/SettingsButton';
import styles from '../Settings.module.css';

type AccessMode = 'loopback' | 'lan';

interface AccessSummary {
  network: {
    mode: AccessMode;
    listenHost: string;
    configuredPort: number;
    actualPort: number;
    runtimeMode: AccessMode;
    runtimeHost: string;
    restartRequired: boolean;
    lanAddresses: string[];
    localServerUrl: string;
    candidateLanServerUrl: string | null;
    lanServerUrl: string | null;
    localMobileUrl: string;
    candidateLanMobileUrl: string | null;
    lanMobileUrl: string | null;
  };
  account: {
    userId: string;
    username: string;
    displayName: string;
    passwordSet: boolean;
  };
  devices: Array<{
    deviceId: string;
    displayName: string;
    deviceKind?: string;
    status: string;
    trustState?: string;
    lastSeenAt?: string | null;
  }>;
  credentials: Array<{
    credentialId: string;
    deviceId: string;
    status: string;
    scopes: string[];
    secretPrefix?: string;
    createdAt?: string | null;
    lastUsedAt?: string | null;
  }>;
}

const DEFAULT_SCOPES = ['chat', 'resources.read', 'files.read', 'files.write'];

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function AccessTab() {
  const showToast = useSettingsStore(s => s.showToast);
  const activeConnection = useSettingsStore(s => s.activeServerConnection);
  const serverConnections = useSettingsStore(s => s.serverConnections);
  const localConnection = serverConnections[LOCAL_CONNECTION_ID] ?? null;
  const effectiveConnection = activeConnection ?? localConnection;
  const isLocalOwner = isLocalOwnerConnection(effectiveConnection);
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [mode, setMode] = useState<AccessMode>('loopback');
  const [port, setPort] = useState('14500');
  const [mobileKey, setMobileKey] = useState('');
  const [desktopKey, setDesktopKey] = useState('');
  const [generatingMobileKey, setGeneratingMobileKey] = useState(false);
  const [generatingDesktopKey, setGeneratingDesktopKey] = useState(false);
  const [remoteServerUrl, setRemoteServerUrl] = useState('');
  const [remoteServerKey, setRemoteServerKey] = useState('');
  const [connectingRemoteServer, setConnectingRemoteServer] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [savingNetwork, setSavingNetwork] = useState(false);
  const [accountDraft, setAccountDraft] = useState({ username: '', displayName: '' });
  const [passwordDraft, setPasswordDraft] = useState('');

  const loadSummary = useCallback(async () => {
    if (!isLocalOwner) {
      setSummary(null);
      setLoadingSummary(false);
      return;
    }
    setLoadingSummary(true);
    try {
      const res = await gsapFetch('/api/access/summary');
      const data = await res.json();
      setSummary(data);
      setMode(data.network.mode);
      setPort(String(data.network.configuredPort));
      setAccountDraft({
        username: data.account.username || '',
        displayName: data.account.displayName || '',
      });
    } finally {
      setLoadingSummary(false);
    }
  }, [isLocalOwner]);

  useEffect(() => {
    loadSummary().catch((err) => {
      showToast(`${t('settings.access.loadFailed')}: ${getErrorMessage(err)}`, 'error');
    });
  }, [loadSummary, showToast]);

  const mobileUrl = useMemo(() => {
    if (!summary || mode !== 'lan') return '';
    return summary.network.lanMobileUrl || summary.network.candidateLanMobileUrl || '';
  }, [mode, summary]);

  const desktopUrl = useMemo(() => {
    if (!summary || mode !== 'lan') return '';
    return summary.network.lanServerUrl || summary.network.candidateLanServerUrl || '';
  }, [mode, summary]);

  const qrUrl = useMemo(() => {
    if (mode !== 'lan' || !mobileUrl || summary?.network.restartRequired) return '';
    const query = summary?.network.actualPort
      ? `?port=${encodeURIComponent(String(summary.network.actualPort))}`
      : '';
    return gsapUrl(`/api/access/mobile-qr.svg${query}`, { includeTokenQuery: true });
  }, [mode, mobileUrl, summary?.network.actualPort, summary?.network.restartRequired]);

  const canCopyMobileUrl = mobileUrl.length > 0;
  const canCopyDesktopUrl = desktopUrl.length > 0;
  const canShowQr = mode === 'lan' && mobileUrl.length > 0 && !summary?.network.restartRequired;
  const runtimeEndpoint = summary ? `${summary.network.runtimeHost}:${summary.network.actualPort}` : '';
  const effectiveMobileUrl = summary?.network.lanMobileUrl || summary?.network.localMobileUrl || '';
  const effectiveDesktopUrl = summary?.network.lanServerUrl || summary?.network.localServerUrl || '';
  const lanAddressText = summary?.network.lanAddresses.length
    ? summary.network.lanAddresses.join(', ')
    : t('settings.access.noLanAddresses');
  const activeDevices = (summary?.devices || []).filter(device => device.status === 'active');
  const activeCredentials = (summary?.credentials || []).filter(credential => credential.status === 'active');
  const activeCredentialDeviceIds = new Set(activeCredentials.map(credential => credential.deviceId));
  const activeDevicesWithoutCredentials = activeDevices.filter(device => !activeCredentialDeviceIds.has(device.deviceId));
  const deviceById = useMemo(() => new Map(activeDevices.map(device => [device.deviceId, device])), [activeDevices]);

  const copyText = useCallback(async (value: string) => {
    if (!value) return;
    await navigator.clipboard?.writeText(value);
    showToast(t('settings.access.copied'), 'success');
  }, [showToast]);

  const saveNetworkSettings = useCallback(async (nextMode: AccessMode, nextPort: string) => {
    const listenPort = Number(nextPort);
    if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
      showToast(t('settings.access.invalidPort'), 'error');
      return;
    }
    setSavingNetwork(true);
    try {
      const res = await gsapFetch('/api/access/network', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: nextMode, listenPort }),
      });
      const data = await res.json();
      setSummary(prev => prev ? { ...prev, network: data.network } : prev);
      setMode(data.network.mode);
      setPort(String(data.network.configuredPort));
      showToast(t('settings.access.saved'), 'success');
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
      setMode(summary?.network.mode || nextMode);
    } finally {
      setSavingNetwork(false);
    }
  }, [showToast, summary?.network.mode]);

  const saveNetwork = useCallback(async () => {
    await saveNetworkSettings(mode, port);
  }, [mode, port, saveNetworkSettings]);

  const handleLanToggle = useCallback((on: boolean) => {
    if (!summary || loadingSummary || savingNetwork) return;
    const nextMode = on ? 'lan' : 'loopback';
    setMode(nextMode);
    void saveNetworkSettings(nextMode, port);
  }, [loadingSummary, port, saveNetworkSettings, savingNetwork, summary]);

  const generateMobileKey = useCallback(async () => {
    setGeneratingMobileKey(true);
    try {
      const res = await gsapFetch('/api/access/mobile-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Mobile PWA',
          scopes: DEFAULT_SCOPES,
        }),
      });
      const data = await res.json();
      setMobileKey(data.secret || '');
      await loadSummary();
      showToast(t('settings.access.mobileKeyCreated'), 'success');
    } catch (err) {
      showToast(`${t('settings.access.mobileKeyFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      setGeneratingMobileKey(false);
    }
  }, [loadSummary, showToast]);

  const generateDesktopKey = useCallback(async () => {
    setGeneratingDesktopKey(true);
    try {
      const res = await gsapFetch('/api/access/desktop-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Desktop Frontend',
          scopes: DEFAULT_SCOPES,
        }),
      });
      const data = await res.json();
      setDesktopKey(data.secret || '');
      await loadSummary();
      showToast(t('settings.access.desktopKeyCreated'), 'success');
    } catch (err) {
      showToast(`${t('settings.access.desktopKeyFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      setGeneratingDesktopKey(false);
    }
  }, [loadSummary, showToast]);

  const connectRemoteServer = useCallback(async () => {
    setConnectingRemoteServer(true);
    try {
      const connection = await connectDeviceServerConnection({
        baseUrl: remoteServerUrl,
        credential: remoteServerKey,
      });
      persistServerConnectionSelection(connection);
      const current = useSettingsStore.getState();
      current.set({
        serverConnections: upsertServerConnection(current.serverConnections, connection),
        activeServerConnectionId: connection.connectionId,
        activeServerConnection: connection,
      });
      setRemoteServerKey('');
      showToast(t('settings.access.remoteServerConnected'), 'success');
      void window.platform?.reloadMainWindow?.();
    } catch (err) {
      showToast(`${t('settings.access.remoteServerFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      setConnectingRemoteServer(false);
    }
  }, [remoteServerKey, remoteServerUrl, showToast]);

  const returnToLocalServer = useCallback(() => {
    const current = useSettingsStore.getState();
    const local = current.serverConnections[LOCAL_CONNECTION_ID];
    if (!isLocalOwnerConnection(local)) {
      showToast(t('settings.access.localConnectionUnavailable'), 'error');
      return;
    }
    current.set({
      activeServerConnectionId: local.connectionId,
      activeServerConnection: local,
    });
    writePersistedServerConnectionState({
      serverConnections: current.serverConnections,
      activeServerConnectionId: null,
    });
    showToast(t('settings.access.returnedToLocal'), 'success');
    void window.platform?.reloadMainWindow?.();
  }, [showToast]);

  const saveAccount = useCallback(async () => {
    try {
      const res = await gsapFetch('/api/access/account/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountDraft),
      });
      const data = await res.json();
      setSummary(prev => prev ? { ...prev, account: data.account } : prev);
      showToast(t('settings.access.accountSaved'), 'success');
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [accountDraft, showToast]);

  const savePassword = useCallback(async () => {
    try {
      const res = await gsapFetch('/api/access/account/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordDraft }),
      });
      const data = await res.json();
      setSummary(prev => prev ? { ...prev, account: data.account } : prev);
      setPasswordDraft('');
      showToast(t('settings.access.passwordSaved'), 'success');
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [passwordDraft, showToast]);

  const clearPassword = useCallback(async () => {
    try {
      const res = await gsapFetch('/api/access/account/password', { method: 'DELETE' });
      const data = await res.json();
      setSummary(prev => prev ? { ...prev, account: data.account } : prev);
      setPasswordDraft('');
      showToast(t('settings.access.passwordCleared'), 'success');
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [showToast]);

  const revokeDevice = useCallback(async (deviceId: string) => {
    try {
      await gsapFetch(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST' });
      await loadSummary();
      showToast(t('settings.access.deviceRevoked'), 'success');
    } catch (err) {
      showToast(`${t('settings.access.deviceRevokeFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [loadSummary, showToast]);

  const revokeCredential = useCallback(async (credentialId: string) => {
    try {
      await gsapFetch(`/api/devices/credentials/${encodeURIComponent(credentialId)}/revoke`, { method: 'POST' });
      await loadSummary();
      showToast(t('settings.access.credentialRevoked'), 'success');
    } catch (err) {
      showToast(`${t('settings.access.credentialRevokeFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [loadSummary, showToast]);

  if (!isLocalOwner) {
    const connectionLabel = effectiveConnection?.label || t('settings.access.remoteConnectionUnknown');
    const connectionUrl = effectiveConnection?.baseUrl || '';
    return (
      <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="access">
        <SettingsSection
          title={t('settings.access.remoteConnection')}
          description={t('settings.access.remoteConnectionDesc')}
        >
          <div className={styles['access-remote-panel']}>
            <div className={styles['access-status-grid']}>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteConnectionName')}</span>
                <strong>{connectionLabel}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteConnectionKind')}</span>
                <strong>{effectiveConnection?.kind || t('settings.access.remoteConnectionUnknown')}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteConnectionUrl')}</span>
                <strong>{connectionUrl || t('settings.access.remoteConnectionUnknown')}</strong>
              </div>
            </div>
            <SettingsSection.Note>{t('settings.access.remoteLocalOnlyNote')}</SettingsSection.Note>
          </div>
          <SettingsSection.Footer>
            <SettingsButton
              variant="secondary"
              onClick={returnToLocalServer}
              disabled={!isLocalOwnerConnection(localConnection)}
            >
              {t('settings.access.returnToLocal')}
            </SettingsButton>
          </SettingsSection.Footer>
        </SettingsSection>
      </div>
    );
  }

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="access">
      <SettingsSection title={t('settings.access.networkAccess')}>
        <SettingsRow
          label={t('settings.access.lanToggle')}
          hint={t('settings.access.lanHint')}
          control={
            <Toggle
              label={t('settings.access.lanToggle')}
              on={summary ? mode === 'lan' : undefined}
              onChange={handleLanToggle}
              disabled={loadingSummary || savingNetwork}
            />
          }
        />
        <SettingsRow
          label={t('settings.access.port')}
          hint={t('settings.access.portHint')}
          control={
            <input
              className={`${styles['settings-input']} ${styles['settings-port-input']}`}
              value={port}
              inputMode="numeric"
              onChange={(event) => setPort(event.target.value)}
            />
          }
        />
        <SettingsRow
          label={t('settings.access.status')}
          hint={summary?.network.restartRequired ? t('settings.access.restartRequired') : t('settings.access.statusHint')}
          layout="stacked"
          control={
            <div className={styles['access-status-grid']}>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.runtimeEndpoint')}</span>
                <strong>{runtimeEndpoint}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.effectiveMobileUrl')}</span>
                <strong>{effectiveMobileUrl}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.effectiveDesktopUrl')}</span>
                <strong>{effectiveDesktopUrl}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.lanAddresses')}</span>
                <strong>{lanAddressText}</strong>
              </div>
            </div>
          }
        />
        {summary?.network.restartRequired && (
          <SettingsSection.Warning>{t('settings.access.restartRequired')}</SettingsSection.Warning>
        )}
        <SettingsSection.Footer>
          <SettingsButton variant="primary" onClick={saveNetwork} disabled={loadingSummary || savingNetwork || !summary}>
            {t('settings.access.saveNetwork')}
          </SettingsButton>
        </SettingsSection.Footer>
      </SettingsSection>

      <SettingsSection title={t('settings.access.mobileAccess')}>
        <SettingsRow
          label={t('settings.access.mobileUrl')}
          hint={mode === 'lan' ? t('settings.access.mobileUrlLanHint') : t('settings.access.mobileUrlLocalHint')}
          layout="stacked"
          control={
            <div className={styles['access-url-row']}>
              <input className={styles['settings-input']} value={mobileUrl} readOnly />
              <SettingsButton variant="secondary" onClick={() => copyText(mobileUrl)} disabled={!canCopyMobileUrl}>
                {t('settings.access.copy')}
              </SettingsButton>
            </div>
          }
        />
        {canShowQr && (
          <SettingsRow
            label={t('settings.access.qrCode')}
            hint={t('settings.access.qrCodeHint')}
            control={<img className={styles['access-qr']} src={qrUrl} alt={t('settings.access.qrCode')} />}
          />
        )}
        <SettingsRow
          label={t('settings.access.generateMobileKey')}
          hint={t('settings.access.mobileKeyHint')}
          control={
            <SettingsButton variant="primary" onClick={generateMobileKey} disabled={generatingMobileKey}>
              {t('settings.access.generateMobileKey')}
            </SettingsButton>
          }
        />
        {mobileKey && (
          <SettingsRow
            label={t('settings.access.mobileKey')}
            hint={t('settings.access.mobileKeyOnce')}
            layout="stacked"
            control={
              <div className={styles['access-url-row']}>
                <input className={styles['settings-input']} value={mobileKey} readOnly />
                <SettingsButton variant="secondary" onClick={() => copyText(mobileKey)}>
                  {t('settings.access.copy')}
                </SettingsButton>
              </div>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.access.desktopAccess')}>
        <SettingsRow
          label={t('settings.access.desktopUrl')}
          hint={mode === 'lan' ? t('settings.access.desktopUrlLanHint') : t('settings.access.desktopUrlLocalHint')}
          layout="stacked"
          control={
            <div className={styles['access-url-row']}>
              <input className={styles['settings-input']} value={desktopUrl} readOnly />
              <SettingsButton variant="secondary" onClick={() => copyText(desktopUrl)} disabled={!canCopyDesktopUrl}>
                {t('settings.access.copy')}
              </SettingsButton>
            </div>
          }
        />
        <SettingsRow
          label={t('settings.access.generateDesktopKey')}
          hint={t('settings.access.desktopKeyHint')}
          control={
            <SettingsButton variant="primary" onClick={generateDesktopKey} disabled={generatingDesktopKey}>
              {t('settings.access.generateDesktopKey')}
            </SettingsButton>
          }
        />
        {desktopKey && (
          <SettingsRow
            label={t('settings.access.desktopKey')}
            hint={t('settings.access.desktopKeyOnce')}
            layout="stacked"
            control={
              <div className={styles['access-url-row']}>
                <input className={styles['settings-input']} value={desktopKey} readOnly />
                <SettingsButton variant="secondary" onClick={() => copyText(desktopKey)}>
                  {t('settings.access.copy')}
                </SettingsButton>
              </div>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.access.connectLanServer')}>
        <SettingsRow
          label={t('settings.access.remoteServerUrl')}
          hint={t('settings.access.remoteServerUrlHint')}
          layout="stacked"
          control={
            <label className={styles['access-field']}>
              <span>{t('settings.access.remoteServerUrl')}</span>
              <input
                aria-label={t('settings.access.remoteServerUrl')}
                className={styles['settings-input']}
                value={remoteServerUrl}
                placeholder="http://192.168.31.75:14500"
                onChange={(event) => setRemoteServerUrl(event.target.value)}
              />
            </label>
          }
        />
        <SettingsRow
          label={t('settings.access.remoteServerKey')}
          hint={t('settings.access.remoteServerKeyHint')}
          layout="stacked"
          control={
            <label className={styles['access-field']}>
              <span>{t('settings.access.remoteServerKey')}</span>
              <input
                aria-label={t('settings.access.remoteServerKey')}
                className={styles['settings-input']}
                value={remoteServerKey}
                type="password"
                placeholder="gsap_dev_..."
                onChange={(event) => setRemoteServerKey(event.target.value)}
              />
            </label>
          }
        />
        <SettingsSection.Footer>
          <SettingsButton
            variant="primary"
            onClick={connectRemoteServer}
            disabled={connectingRemoteServer || !remoteServerUrl.trim() || !remoteServerKey.trim()}
          >
            {t('settings.access.connectLanServer')}
          </SettingsButton>
        </SettingsSection.Footer>
      </SettingsSection>

      <SettingsSection title={t('settings.access.pairedDevices')}>
        <div className={styles['access-device-list']}>
          {activeDevicesWithoutCredentials.length === 0 && activeCredentials.length === 0 ? (
            <div className={styles['access-empty']}>{t('settings.access.noDevices')}</div>
          ) : (
            <>
              {activeCredentials.map(credential => {
                const device = deviceById.get(credential.deviceId);
                return (
                  <div className={styles['access-device-item']} key={credential.credentialId}>
                    <div className={styles['access-device-info']}>
                      <span className={styles['access-device-name']}>{device?.displayName || credential.deviceId}</span>
                      <span className={styles['access-device-meta']}>
                        {device?.deviceKind || 'device'} - {credential.secretPrefix || credential.credentialId} - {credential.scopes.join(', ')}
                      </span>
                    </div>
                    <SettingsButton variant="secondary" onClick={() => revokeCredential(credential.credentialId)}>
                      {t('settings.access.revokeCredential')}
                    </SettingsButton>
                  </div>
                );
              })}
              {activeDevicesWithoutCredentials.map(device => (
                <div className={styles['access-device-item']} key={device.deviceId}>
                  <div className={styles['access-device-info']}>
                    <span className={styles['access-device-name']}>{device.displayName}</span>
                    <span className={styles['access-device-meta']}>{device.deviceKind || 'device'} - {device.trustState || 'lan'}</span>
                  </div>
                  <SettingsButton variant="secondary" onClick={() => revokeDevice(device.deviceId)}>
                    {t('settings.access.revoke')}
                  </SettingsButton>
                </div>
              ))}
            </>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.access.localAccount')}>
        <SettingsRow
          label={t('settings.access.username')}
          layout="stacked"
          control={
            <label className={styles['access-field']}>
              <span>{t('settings.access.username')}</span>
              <input
                aria-label={t('settings.access.username')}
                className={styles['settings-input']}
                value={accountDraft.username}
                onChange={(event) => setAccountDraft(prev => ({ ...prev, username: event.target.value }))}
              />
            </label>
          }
        />
        <SettingsRow
          label={t('settings.access.displayName')}
          layout="stacked"
          control={
            <label className={styles['access-field']}>
              <span>{t('settings.access.displayName')}</span>
              <input
                aria-label={t('settings.access.displayName')}
                className={styles['settings-input']}
                value={accountDraft.displayName}
                onChange={(event) => setAccountDraft(prev => ({ ...prev, displayName: event.target.value }))}
              />
            </label>
          }
        />
        <SettingsSection.Footer>
          <SettingsButton variant="primary" onClick={saveAccount}>
            {t('settings.access.saveAccount')}
          </SettingsButton>
        </SettingsSection.Footer>
      </SettingsSection>

      <SettingsSection title={t('settings.access.password')}>
        <SettingsRow
          label={summary?.account.passwordSet ? t('settings.access.passwordSet') : t('settings.access.passwordNotSet')}
          hint={t('settings.access.passwordHint')}
          layout="stacked"
          control={
            <label className={styles['access-field']}>
              <span>{t('settings.access.newPassword')}</span>
              <input
                aria-label={t('settings.access.newPassword')}
                className={styles['settings-input']}
                type="password"
                value={passwordDraft}
                onChange={(event) => setPasswordDraft(event.target.value)}
              />
            </label>
          }
        />
        <SettingsSection.Footer>
          {summary?.account.passwordSet && (
            <SettingsButton variant="secondary" onClick={clearPassword}>
              {t('settings.access.clearPassword')}
            </SettingsButton>
          )}
          <SettingsButton variant="primary" onClick={savePassword} disabled={!passwordDraft}>
            {t('settings.access.savePassword')}
          </SettingsButton>
        </SettingsSection.Footer>
      </SettingsSection>
    </div>
  );
}
