import React, { useState, useCallback, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { autoSaveConfig, t } from '../helpers';
import { gsapFetch } from '../api';
import { loadSettingsConfig } from '../actions';
import { Toggle } from '../widgets/Toggle';
import styles from '../Settings.module.css';

interface Checkpoint {
  id: string;
  ts: number;
  tool: string;
  path: string;
  size: number;
}

const RETENTION_OPTIONS = [
  { value: 1, key: 'settings.security.retention1d' },
  { value: 3, key: 'settings.security.retention3d' },
  { value: 7, key: 'settings.security.retention7d' },
];

const SIZE_OPTIONS = [
  { value: 512, label: '512 KB' },
  { value: 1024, label: '1 MB' },
  { value: 5120, label: '5 MB' },
  { value: 10240, label: '10 MB' },
];

type NetworkProxyMode = 'system' | 'manual' | 'direct';

interface NetworkProxyConfig {
  mode: NetworkProxyMode;
  httpProxy: string;
  httpsProxy: string;
  wsProxy: string;
  wssProxy: string;
  noProxy: string;
}

type NetworkProxyTextField = Exclude<keyof NetworkProxyConfig, 'mode'>;

const DEFAULT_NETWORK_PROXY: NetworkProxyConfig = {
  mode: 'system',
  httpProxy: '',
  httpsProxy: '',
  wsProxy: '',
  wssProxy: '',
  noProxy: 'localhost, 127.0.0.1, ::1',
};

function normalizeNetworkProxyDraft(value: Partial<NetworkProxyConfig> | null | undefined): NetworkProxyConfig {
  const mode = value?.mode === 'manual' || value?.mode === 'direct' ? value.mode : 'system';
  return {
    ...DEFAULT_NETWORK_PROXY,
    ...(value || {}),
    mode,
    httpProxy: value?.httpProxy || '',
    httpsProxy: value?.httpsProxy || '',
    wsProxy: value?.wsProxy || '',
    wssProxy: value?.wssProxy || '',
    noProxy: value?.noProxy || DEFAULT_NETWORK_PROXY.noProxy,
  };
}

export function SecurityTab() {
  const { settingsConfig, showToast, platformName } = useSettingsStore();
  const sandboxEnabled = settingsConfig?.sandbox !== false;
  const isWindows = platformName === 'win32';
  const sandboxNetworkEnabled = isWindows || settingsConfig?.sandbox_network !== false;
  const sandboxNetworkDisabled = !sandboxEnabled || isWindows;
  const fileBackup = {
    enabled: false,
    retention_days: 1,
    max_file_size_kb: 1024,
    ...(settingsConfig?.file_backup || {}),
  };

  const [backupsOpen, setBackupsOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [proxyDraft, setProxyDraft] = useState<NetworkProxyConfig>(
    () => normalizeNetworkProxyDraft(settingsConfig?.network_proxy),
  );

  useEffect(() => {
    setProxyDraft(normalizeNetworkProxyDraft(settingsConfig?.network_proxy));
  }, [settingsConfig?.network_proxy]);

  const handleSandboxToggle = useCallback(async (on: boolean) => {
    await autoSaveConfig({ sandbox: on }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleSandboxNetworkToggle = useCallback(async (on: boolean) => {
    await autoSaveConfig({ sandbox_network: on }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleBackupToggle = useCallback(async (on: boolean) => {
    const current = useSettingsStore.getState().settingsConfig?.file_backup || {};
    await autoSaveConfig({ file_backup: { ...current, enabled: on } }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleRetentionChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const days = parseInt(e.target.value, 10);
    const current = useSettingsStore.getState().settingsConfig?.file_backup || {};
    await autoSaveConfig({ file_backup: { ...current, retention_days: days } }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleMaxSizeChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const kb = parseInt(e.target.value, 10);
    const current = useSettingsStore.getState().settingsConfig?.file_backup || {};
    await autoSaveConfig({ file_backup: { ...current, max_file_size_kb: kb } }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleProxyModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const mode = e.target.value as NetworkProxyMode;
    setProxyDraft(prev => ({ ...prev, mode }));
  }, []);

  const handleProxyFieldChange = useCallback((field: NetworkProxyTextField, value: string) => {
    setProxyDraft(prev => ({ ...prev, [field]: value }));
  }, []);

  const handleProxySave = useCallback(async () => {
    const saved = await autoSaveConfig({ network_proxy: proxyDraft }, { silent: true });
    if (!saved) return;
    window.platform?.settingsChanged?.('network-proxy-changed', { network_proxy: proxyDraft });
    showToast(t('settings.autoSaved'), 'success');
    await loadSettingsConfig();
  }, [proxyDraft, showToast]);

  const loadCheckpoints = useCallback(async () => {
    setLoading(true);
    try {
      const res = await gsapFetch('/api/checkpoints');
      const data = await res.json();
      setCheckpoints(data.checkpoints || []);
    } catch {
      setCheckpoints([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRestore = useCallback(async (id: string) => {
    try {
      const res = await gsapFetch(`/api/checkpoints/${id}/restore`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        showToast(t('settings.security.restoreSuccess'), 'success');
      } else {
        showToast(t('settings.security.restoreFailed'), 'error');
      }
    } catch {
      showToast(t('settings.security.restoreFailed'), 'error');
    }
  }, [showToast]);

  const toggleBackups = useCallback(() => {
    const next = !backupsOpen;
    setBackupsOpen(next);
    if (next) loadCheckpoints();
  }, [backupsOpen, loadCheckpoints]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  const formatPath = (p: string) => {
    const parts = p.split('/').filter(Boolean);
    if (parts.length <= 2) return p;
    return '.../' + parts.slice(-2).join('/');
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="security">
      {/* Sandbox Section */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.security.sandbox')}</h2>
        <div className={styles['tool-caps-group']}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.security.sandbox')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.security.sandboxDesc')}</span>
            </div>
            <Toggle on={sandboxEnabled} onChange={handleSandboxToggle} />
          </div>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.security.sandboxNetwork')}</span>
              <span className={styles['tool-caps-desc']}>
                {isWindows
                  ? t('settings.security.sandboxNetworkWin32Unsupported')
                  : sandboxEnabled
                  ? t('settings.security.sandboxNetworkDesc')
                  : t('settings.security.sandboxNetworkDisabledDesc')}
              </span>
            </div>
            <Toggle
              on={sandboxNetworkEnabled}
              onChange={handleSandboxNetworkToggle}
              disabled={sandboxNetworkDisabled}
            />
          </div>
        </div>
        {!sandboxEnabled && (
          <p className={`${styles['tool-caps-desc']} ${styles['warn']} ${styles['settings-section-hint']}`}>
            {t('settings.security.sandboxWarning')}
          </p>
        )}
      </section>

      {/* Network Proxy Section */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.security.networkProxy')}</h2>
        <div className={styles['tool-caps-group']}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.security.networkProxyMode')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.security.networkProxyModeDesc')}</span>
            </div>
            <select
              className={styles['settings-select']}
              value={proxyDraft.mode}
              onChange={handleProxyModeChange}
            >
              <option value="system">{t('settings.security.networkProxySystem')}</option>
              <option value="manual">{t('settings.security.networkProxyManual')}</option>
              <option value="direct">{t('settings.security.networkProxyDirect')}</option>
            </select>
          </div>

          {proxyDraft.mode === 'manual' && (
            <div className={`${styles['tool-caps-item']} ${styles['settings-proxy-editor']}`}>
              <div className={styles['tool-caps-label']}>
                <span className={styles['tool-caps-name']}>{t('settings.security.networkProxyManualTitle')}</span>
                <span className={styles['tool-caps-desc']}>{t('settings.security.networkProxyManualDesc')}</span>
              </div>
              <div className={styles['settings-proxy-grid']}>
                <input
                  className={styles['settings-input']}
                  value={proxyDraft.httpProxy}
                  onChange={(e) => handleProxyFieldChange('httpProxy', e.target.value)}
                  placeholder={t('settings.security.networkProxyHttp')}
                />
                <input
                  className={styles['settings-input']}
                  value={proxyDraft.httpsProxy}
                  onChange={(e) => handleProxyFieldChange('httpsProxy', e.target.value)}
                  placeholder={t('settings.security.networkProxyHttps')}
                />
                <input
                  className={styles['settings-input']}
                  value={proxyDraft.wsProxy}
                  onChange={(e) => handleProxyFieldChange('wsProxy', e.target.value)}
                  placeholder={t('settings.security.networkProxyWs')}
                />
                <input
                  className={styles['settings-input']}
                  value={proxyDraft.wssProxy}
                  onChange={(e) => handleProxyFieldChange('wssProxy', e.target.value)}
                  placeholder={t('settings.security.networkProxyWss')}
                />
                <input
                  className={`${styles['settings-input']} ${styles['settings-proxy-wide']}`}
                  value={proxyDraft.noProxy}
                  onChange={(e) => handleProxyFieldChange('noProxy', e.target.value)}
                  placeholder={t('settings.security.networkProxyNoProxy')}
                />
              </div>
            </div>
          )}

          <button type="button" className={styles['settings-text-btn']} onClick={handleProxySave}>
            {t('settings.security.networkProxySave')}
          </button>
        </div>
      </section>

      {/* File Backup Section */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.security.fileBackup')}</h2>
        <div className={styles['tool-caps-group']}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.security.fileBackup')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.security.fileBackupDesc')}</span>
            </div>
            <Toggle on={fileBackup.enabled} onChange={handleBackupToggle} />
          </div>

          {fileBackup.enabled && (
            <>
              <div className={styles['tool-caps-item']}>
                <span className={styles['tool-caps-name']}>{t('settings.security.retention')}</span>
                <select
                  className={styles['settings-select']}
                  value={fileBackup.retention_days}
                  onChange={handleRetentionChange}
                >
                  {RETENTION_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{t(opt.key)}</option>
                  ))}
                </select>
              </div>

              <div className={styles['tool-caps-item']}>
                <span className={styles['tool-caps-name']}>{t('settings.security.maxFileSize')}</span>
                <select
                  className={styles['settings-select']}
                  value={fileBackup.max_file_size_kb}
                  onChange={handleMaxSizeChange}
                >
                  {SIZE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <button type="button" className={styles['settings-text-btn']} onClick={toggleBackups}>
                {backupsOpen ? t('settings.security.hideBackups') : t('settings.security.viewBackups')}
              </button>

              {backupsOpen && (
                <div className={styles['settings-backup-list']}>
                  {loading ? (
                    <span className={styles['tool-caps-desc']}>...</span>
                  ) : checkpoints.length === 0 ? (
                    <span className={styles['tool-caps-desc']}>{t('settings.security.noBackups')}</span>
                  ) : (
                    checkpoints.map(cp => (
                      <div key={cp.id} className={styles['settings-backup-item']}>
                        <span className={styles['settings-backup-time']}>{formatTime(cp.ts)}</span>
                        <span className={styles['settings-backup-path']}>{formatPath(cp.path)}</span>
                        <button type="button"
                          className={styles['settings-backup-restore-btn']}
                          onClick={() => handleRestore(cp.id)}
                        >
                          {t('settings.security.restoreBtn')}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
