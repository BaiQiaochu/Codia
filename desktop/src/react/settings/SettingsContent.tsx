import React, { useEffect, useMemo, useRef } from 'react';
import { useSettingsStore } from './store';
import { useShallow } from 'zustand/react/shallow';
import { gsapFetch } from './api';
import {
  createLocalServerConnection,
  readPersistedServerConnectionState,
  refreshLocalServerConnectionState,
  upsertServerConnection,
  type ServerConnection,
} from '../services/server-connection';
import { t } from './helpers';
import { loadAgents, loadAvatars, loadSettingsSnapshot } from './actions';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { SettingsNav, settingsCategoryLabel, settingsModuleLabel } from './SettingsNav';
import {
  buildSettingsCategories,
  findSettingsCategory,
  normalizeSettingsModuleId,
  type SettingsCategory,
} from './settings-navigation';
import { Toast } from './Toast';
import { GeneralTab } from './tabs/GeneralTab';
import { AgentTab } from './tabs/AgentTab';
import { MeTab } from './tabs/MeTab';
import { InterfaceTab } from './tabs/InterfaceTab';
import { BrowserTab } from './tabs/BrowserTab';
import { WorkTab } from './tabs/WorkTab';
import { SkillsTab } from './tabs/SkillsTab';
import { McpTab } from './tabs/McpTab';
import { BridgeTab } from './tabs/BridgeTab';
import { ProvidersTab } from './tabs/ProvidersTab';
import { MediaTab } from './tabs/MediaTab';
import { ExperimentsTab } from './tabs/ExperimentsTab';
import { AboutTab } from './tabs/AboutTab';
import { PluginsTab } from './tabs/PluginsTab';
import { PluginMarketplaceTab } from './tabs/PluginMarketplaceTab';
import { SecurityTab } from './tabs/SecurityTab';
import { SharingTab } from './tabs/SharingTab';
import { DiagnosticsTab } from './tabs/DiagnosticsTab';
import { AccessTab } from './tabs/AccessTab';
import { getNativeSettingsTabComponent } from './native-settings-tabs';
import { CropOverlay } from './overlays/CropOverlay';
import { AgentCreateOverlay } from './overlays/AgentCreateOverlay';
import { AgentDeleteOverlay } from './overlays/AgentDeleteOverlay';
import { MemoryViewer } from './overlays/MemoryViewer';
import { CompiledMemoryViewer } from './overlays/CompiledMemoryViewer';
import { ClearMemoryConfirm } from './overlays/ClearMemoryConfirm';
import { BridgeTutorial } from './overlays/BridgeTutorial';
import { WechatQrcodeOverlay } from './overlays/WechatQrcodeOverlay';
import { InputContextMenu } from '../components/InputContextMenu';
import styles from './Settings.module.css';

const TAB_COMPONENTS: Record<string, React.ComponentType> = {
  general: GeneralTab,
  agent: AgentTab,
  me: MeTab,
  interface: InterfaceTab,
  browser: BrowserTab,
  work: WorkTab,
  skills: SkillsTab,
  mcp: McpTab,
  bridge: BridgeTab,
  providers: ProvidersTab,
  media: MediaTab,
  experiments: ExperimentsTab,
  sharing: SharingTab,
  access: AccessTab,
  plugins: PluginsTab,
  'plugin-marketplace': PluginMarketplaceTab,
  diagnostics: DiagnosticsTab,
  security: SecurityTab,
  about: AboutTab,
};

const WIDE_SETTINGS_TABS = new Set(['agent', 'providers', 'media', 'plugin-marketplace']);

interface SettingsContentProps {
  variant: 'window' | 'modal';
  onClose?: () => void;
  onActiveTabChange?: (tab: string) => void;
  listenToWindowTabSwitch?: boolean;
  activeTabOverride?: string;
}

function normalizeNativeTabForPlatform(tab: string, _platformName: string | null | undefined): string {
  if (tab === 'license') return 'diagnostics';
  if (tab === 'computer') return 'experiments';
  if (tab === 'search') return 'providers';
  return tab;
}

function normalizeSettingsTab(tab: string, platformName: string | null | undefined): string {
  const normalized = normalizeNativeTabForPlatform(tab, platformName);
  // Keep old deep links and persisted selections usable after the General and
  // Interface pages were merged into the single General settings page.
  return normalized === 'general' || normalized === 'interface' ? 'about' : normalized;
}

function connectionState(connection: ServerConnection | null) {
  const persisted = readPersistedServerConnectionState();
  if (!connection) {
    return {
      serverConnections: persisted.serverConnections,
      activeServerConnectionId: null,
      activeServerConnection: null,
    };
  }
  const serverConnections = upsertServerConnection(persisted.serverConnections, connection);
  return {
    serverConnections,
    activeServerConnectionId: persisted.activeServerConnectionId && serverConnections[persisted.activeServerConnectionId]
      ? persisted.activeServerConnectionId
      : connection.connectionId,
    activeServerConnection: persisted.activeServerConnectionId && serverConnections[persisted.activeServerConnectionId]
      ? serverConnections[persisted.activeServerConnectionId]
      : connection,
  };
}

export function SettingsModuleTabs({
  category,
  activeModuleId,
  onSelect,
}: {
  category: SettingsCategory;
  activeModuleId: string;
  onSelect: (tab: string) => void;
}) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const moveFocus = (currentIndex: number, nextIndex: number) => {
    const count = category.modules.length;
    if (count === 0) return;
    buttonRefs.current[(nextIndex + count) % count]?.focus();
  };

  return (
    <div
      className={styles['settings-module-tabs']}
      role="tablist"
      aria-label={settingsCategoryLabel(category)}
    >
      {category.modules.map((module, index) => {
        const selected = module.id === activeModuleId;
        return (
          <button
            key={module.id}
            ref={(node) => { buttonRefs.current[index] = node; }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-settings-module={module.id}
            className={`${styles['settings-module-tab']}${selected ? ` ${styles.active}` : ''}`}
            onClick={() => onSelect(module.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                moveFocus(index, index + 1);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                moveFocus(index, index - 1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                moveFocus(index, 0);
              } else if (event.key === 'End') {
                event.preventDefault();
                moveFocus(index, category.modules.length - 1);
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(module.id);
              }
            }}
          >
            {settingsModuleLabel(module)}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsContent({
  variant,
  onClose,
  onActiveTabChange,
  listenToWindowTabSwitch = false,
  activeTabOverride,
}: SettingsContentProps) {
  const { activeTab, platformName, pluginSettingsTabs, set, ready } = useSettingsStore(
    useShallow((state) => ({
      activeTab: state.activeTab,
      platformName: state.platformName,
      pluginSettingsTabs: state.pluginSettingsTabs,
      set: state.set,
      ready: state.ready,
    })),
  );
  const requestedActiveTab = activeTabOverride || activeTab;

  useEffect(() => {
    void initSettings();
  }, []);

  useEffect(() => {
    if (!listenToWindowTabSwitch) return;
    const platform = window.platform;
    if (!platform?.onSwitchTab) return;
    const unsubscribe = platform.onSwitchTab((tab: string) => {
      const state = useSettingsStore.getState();
      set({ activeTab: normalizeSettingsTab(tab, state.platformName) });
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, [listenToWindowTabSwitch, set]);

  useEffect(() => {
    const nextTab = normalizeSettingsTab(requestedActiveTab, platformName);
    if (nextTab !== activeTab) {
      set({ activeTab: nextTab });
    }
  }, [activeTab, platformName, requestedActiveTab, set]);

  useEffect(() => {
    const nextTab = normalizeSettingsTab(requestedActiveTab, platformName);
    onActiveTabChange?.(nextTab);
  }, [onActiveTabChange, platformName, requestedActiveTab]);

  useEffect(() => {
    const platform = window.platform;
    if (!platform?.onServerRestarted) return;
    const unsubscribe = platform.onServerRestarted((data: { port: number; token?: string }) => {
      const store = useSettingsStore.getState();
      const serverToken = data.token || store.serverToken;
      const nextConnectionState = refreshLocalServerConnectionState({
        serverConnections: store.serverConnections,
        activeServerConnectionId: store.activeServerConnectionId,
        activeServerConnection: store.activeServerConnection,
        serverPort: data.port,
        serverToken,
      });
      store.set({
        serverPort: data.port,
        serverToken,
        ...nextConnectionState,
      });
      loadAgents().catch(() => {});
      loadAvatars().catch(() => {});
      loadSettingsSnapshot({ retainSameKeyData: true }).catch(() => {});
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, []);

  const effectiveActiveTab = normalizeSettingsTab(requestedActiveTab, platformName);
  const settingsCategories = useMemo(
    () => buildSettingsCategories(pluginSettingsTabs || []),
    [pluginSettingsTabs],
  );
  const activeCategory = findSettingsCategory(settingsCategories, effectiveActiveTab);
  const activeModuleId = normalizeSettingsModuleId(effectiveActiveTab);
  const dynamicTab = (pluginSettingsTabs || []).find((tab) => tab.id === effectiveActiveTab);
  const ActiveTab = TAB_COMPONENTS[effectiveActiveTab]
    || (dynamicTab ? getNativeSettingsTabComponent(dynamicTab.nativeComponent) : null)
    || AgentTab;
  const isModal = variant === 'modal';
  const isWideTab = WIDE_SETTINGS_TABS.has(effectiveActiveTab);
  const activeCategoryTitle = settingsCategoryLabel(activeCategory);
  const selectModule = (tab: string) => {
    set({ activeTab: tab });
    onActiveTabChange?.(tab);
  };

  return (
    <ErrorBoundary region="settings">
      <div
        className={`settings-panel ${isModal ? styles['settings-panel-modal'] : ''} ${isWideTab ? styles['settings-panel-wide'] : ''}`}
        id="settingsPanel"
      >
        <div className={`settings-header ${isModal ? styles['settings-header-modal'] : ''}`}>
          {isModal ? (
            <>
              <div className={styles['settings-title-group']}>
                <button
                  type="button"
                  className={styles['settings-return-btn']}
                  onClick={onClose}
                  aria-label={t('settings.back')}
                  data-settings-return
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
                <h1 className={styles['settings-title']}>{t('settings.title')}</h1>
              </div>
              <h1 className={styles['settings-header-tab-title']}>{activeCategoryTitle}</h1>
            </>
          ) : (
            <h1 className={styles['settings-title']}>{t('settings.title')}</h1>
          )}
        </div>
        <div className={styles['settings-body']}>
          <SettingsNav onTabChange={onActiveTabChange} />
          <div className={`${styles['settings-main']} ${isWideTab ? styles['settings-main-wide'] : ''}`}>
            {!isModal && (
              <h1 className={styles['settings-tab-title']}>{activeCategoryTitle}</h1>
            )}
            <SettingsModuleTabs
              category={activeCategory}
              activeModuleId={activeModuleId}
              onSelect={selectModule}
            />
            <ErrorBoundary region={effectiveActiveTab}>
              {ready && <ActiveTab />}
            </ErrorBoundary>
          </div>
        </div>
      </div>

      <Toast />
      <CropOverlay />
      <AgentCreateOverlay />
      <AgentDeleteOverlay />
      <MemoryViewer />
      <CompiledMemoryViewer />
      <ClearMemoryConfirm />
      <BridgeTutorial />
      <WechatQrcodeOverlay />
      <InputContextMenu />

      {!ready && (
        <div className="settings-loading-mask" id="settingsLoadingMask">
          <div className={styles['settings-loading-text']}>
            {t('common.loading') || '加载中...'}
          </div>
        </div>
      )}
    </ErrorBoundary>
  );
}

async function initSettings() {
  const platform = window.platform;
  const store = useSettingsStore.getState();

  const timeout = setTimeout(() => {
    if (!store.ready) {
      console.warn('[settings] init timeout (15s), forcing ready');
      store.set({ ready: true });
    }
  }, 15_000);

  try {
    const serverPort = Number(await platform.getServerPort());
    const serverToken = await platform.getServerToken();
    let platformName: string | null = null;
    try {
      platformName = typeof platform.getPlatform === 'function' ? await platform.getPlatform() : null;
    } catch {
      platformName = null;
    }
    store.set({
      serverPort,
      serverToken,
      platformName,
      ...connectionState(createLocalServerConnection({ serverPort, serverToken })),
    });
    const i18n = window.i18n;
    try {
      const cfgRes = await gsapFetch('/api/config');
      const cfg = await cfgRes.json();
      const locale = cfg.locale || 'system';
      await i18n.load(locale);
    } catch {
      try {
        await i18n.load('system');
      } catch {
        // ignore locale fallback failure
      }
    }

    await loadAgents();
    await loadAvatars();
    await loadSettingsSnapshot();

    store.set({ ready: true });
  } catch (err) {
    console.error('[settings] init failed:', err);
    store.set({ ready: true });
  } finally {
    clearTimeout(timeout);
  }
}
