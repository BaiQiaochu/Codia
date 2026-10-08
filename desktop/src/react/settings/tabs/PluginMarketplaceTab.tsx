import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { gsapFetch } from '../api';
import { t } from '../helpers';
import { SettingsSection } from '../components/SettingsSection';
import { renderMarkdownPreview } from '../../utils/markdown';
import { refreshPluginUI } from '../../stores/plugin-ui-actions';
import styles from '../Settings.module.css';

interface MarketplacePlugin {
  id: string;
  name: string;
  publisher?: string;
  version?: string;
  description?: string;
  trust?: 'restricted' | 'full-access';
  permissions?: string[];
  contributions?: string[];
  repository?: string | null;
  compatibility?: { minAppVersion?: string; gsapApi?: string };
  distribution?: { kind?: 'source' | 'release'; path?: string; packageUrl?: string; sha256?: string } | null;
  installed?: boolean;
  installedVersion?: string | null;
  canInstall?: boolean;
}

interface MarketplaceResponse {
  source?: { kind?: string; configured?: boolean; path?: string; url?: string };
  plugins: MarketplacePlugin[];
  warnings?: string[];
}

function renderMarketSourceStatus(marketplace: MarketplaceResponse | null): string {
  if (!marketplace) return t('settings.plugins.marketLoading');
  return marketplace.source?.configured
    ? t('settings.plugins.marketplaceCount', { count: String(marketplace.plugins.length) })
    : t('settings.plugins.marketplaceNoSource');
}

function metadataValue(value: string | null | undefined): string {
  return value && value.trim() ? value : '-';
}

function renderPluginTrustPanel(selectedPlugin: MarketplacePlugin) {
  const permissions = selectedPlugin.permissions || [];
  const distribution = selectedPlugin.distribution;

  return (
    <div
      data-plugin-marketplace-trust-panel
      className={styles['settings-muted-note']}
      style={{ display: 'grid', gap: 'var(--space-xs)' }}
    >
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
          trust: {metadataValue(selectedPlugin.trust)}
        </span>
        <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
          installed: {metadataValue(selectedPlugin.installedVersion)}
        </span>
        <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
          min app: {metadataValue(selectedPlugin.compatibility?.minAppVersion)}
        </span>
        <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
          api: {metadataValue(selectedPlugin.compatibility?.gsapApi)}
        </span>
      </div>
      <div>
        permissions: {permissions.length > 0 ? permissions.join(', ') : '-'}
      </div>
      <div>
        distribution: {metadataValue(distribution?.kind)}
        {distribution?.path ? ` · ${distribution.path}` : ''}
        {distribution?.packageUrl ? ` · ${distribution.packageUrl}` : ''}
        {selectedPlugin.distribution?.sha256 ? ` · sha256:${selectedPlugin.distribution?.sha256}` : ''}
      </div>
    </div>
  );
}

export function PluginMarketplaceTab() {
  const { showToast, set } = useSettingsStore();
  const [marketplace, setMarketplace] = useState<MarketplaceResponse | null>(null);
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [selectedPlugin, setSelectedPlugin] = useState<MarketplacePlugin | null>(null);
  const [readme, setReadme] = useState('');
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [installingPluginId, setInstallingPluginId] = useState<string | null>(null);

  const loadReadme = useCallback(async (plugin: MarketplacePlugin) => {
    setSelectedPlugin(plugin);
    setReadme('');
    setReadmeLoading(true);
    try {
      const res = await gsapFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/readme`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setReadme(data.markdown || '');
    } catch (err: unknown) {
      showToast(t('settings.plugins.marketReadmeLoadError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setReadmeLoading(false);
    }
  }, [showToast]);

  const loadMarketplace = useCallback(async () => {
    setMarketplaceLoading(true);
    try {
      const res = await gsapFetch('/api/plugins/marketplace');
      const data = await res.json() as {
        error?: string;
        source?: MarketplaceResponse['source'];
        plugins?: MarketplacePlugin[];
        warnings?: string[];
      };
      if (data.error) throw new Error(data.error);
      const plugins = Array.isArray(data.plugins) ? data.plugins : [];
      const next = {
        source: data.source || {},
        plugins,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
      };
      setMarketplace(next);
      if (plugins.length > 0) {
        const currentId = selectedPlugin?.id;
        const initial = plugins.find((plugin) => plugin.id === currentId) || plugins[0];
        await loadReadme(initial);
      } else {
        setSelectedPlugin(null);
        setReadme('');
      }
    } catch (err: unknown) {
      showToast(t('settings.plugins.marketLoadError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setMarketplaceLoading(false);
    }
  }, [loadReadme, selectedPlugin?.id, showToast]);

  useEffect(() => {
    void loadMarketplace();
  }, [loadMarketplace]);

  const installPlugin = async (plugin: MarketplacePlugin) => {
    setInstallingPluginId(plugin.id);
    try {
      const res = await gsapFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        timeout: 120_000,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.plugins.installSuccess', { name: data.name || plugin.name }), 'success');
      await refreshPluginUI();
      await loadMarketplace();
    } catch (err: unknown) {
      showToast(
        t('settings.plugins.installError') + ': ' + (err instanceof Error ? err.message : String(err)),
        'error',
      );
    } finally {
      setInstallingPluginId(null);
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="plugin-marketplace">
      <div className={styles['plugin-marketplace-toolbar']}>
        <button
          type="button"
          className={styles['settings-return-btn']}
          onClick={() => set({ activeTab: 'plugins' })}
          aria-label={t('settings.plugins.marketBack')}
          title={t('settings.plugins.marketBack')}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className={styles['skills-list-desc']}>{t('settings.plugins.marketplaceHint')}</span>
        <div className={styles['plugin-marketplace-toolbar-actions']}>
          <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
            {renderMarketSourceStatus(marketplace)}
          </span>
          <button
            type="button"
            className={styles['settings-icon-btn']}
            title={t('settings.plugins.reload')}
            onClick={() => void loadMarketplace()}
            disabled={marketplaceLoading}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={marketplaceLoading ? styles.spin : ''}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>
      </div>

      <SettingsSection variant="flush">
        {!marketplace ? (
          <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>
            {t('settings.plugins.marketLoading')}
          </p>
        ) : (
          <>
            {marketplace.warnings && marketplace.warnings.length > 0 && (
              <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`} style={{ color: 'var(--danger)' }}>
                {marketplace.warnings[0]}
              </p>
            )}
            {marketplace.plugins.length === 0 ? (
              <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>
                {t('settings.plugins.marketplaceEmpty')}
              </p>
            ) : (
              <div className={styles['plugin-marketplace-grid']}>
                <div className={styles['skills-list-block']}>
                  {marketplace.plugins.map((plugin) => (
                    <div
                      key={plugin.id}
                      className={styles['skills-list-item']}
                      onClick={() => void loadReadme(plugin)}
                      style={selectedPlugin?.id === plugin.id ? { background: 'var(--bg-hover)' } : undefined}
                    >
                      <div className={styles['skills-list-info']}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span className={styles['skills-list-name']}>{plugin.name}</span>
                          {plugin.version && <span className={styles['skills-list-name-hint']}>v{plugin.version}</span>}
                          {plugin.installed && (
                            <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                              {t('settings.plugins.marketInstalled')}
                            </span>
                          )}
                        </div>
                        {plugin.description && <span className={styles['skills-list-desc']}>{plugin.description}</span>}
                        <span className={styles['skills-list-desc']}>
                          {(plugin.publisher || 'unknown') + ' · ' + (plugin.trust || 'restricted')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className={styles['skills-list-block']}>
                  <div className={styles['skills-list-item']} style={{ alignItems: 'flex-start', cursor: 'default' }}>
                    <div className={styles['skills-list-info']} style={{ gap: 'var(--space-sm)', width: '100%' }}>
                      {selectedPlugin ? (
                        <>
                          <div className={styles['plugin-marketplace-detail-header']}>
                            <div style={{ minWidth: 0 }}>
                              <div className={styles['skills-list-name']}>{selectedPlugin.name}</div>
                              <div className={styles['skills-list-desc']}>
                                {(selectedPlugin.publisher || 'unknown') + ' · v' + (selectedPlugin.version || '0.0.0')}
                              </div>
                            </div>
                            <button type="button"
                              className={styles['settings-save-btn-sm']}
                              disabled={!selectedPlugin.canInstall || installingPluginId === selectedPlugin.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                void installPlugin(selectedPlugin);
                              }}
                            >
                              {selectedPlugin.installed
                                ? t('settings.plugins.marketUpdate')
                                : t('settings.plugins.marketInstall')}
                            </button>
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {(selectedPlugin.contributions || []).map((item) => (
                              <span key={item} className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                                {item}
                              </span>
                            ))}
                          </div>
                          {renderPluginTrustPanel(selectedPlugin)}
                          <div
                            className={`preview-markdown ${styles['plugin-marketplace-readme']}`}
                            dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(readmeLoading ? t('settings.plugins.marketReadmeLoading') : (readme || selectedPlugin.description || '')) }}
                          />
                        </>
                      ) : (
                        <span className={styles['skills-list-desc']}>{t('settings.plugins.marketSelectPlugin')}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </SettingsSection>
    </div>
  );
}
