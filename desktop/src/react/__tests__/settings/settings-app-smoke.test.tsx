// @vitest-environment jsdom
import React, { act } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RestartPayload = { port: number; token?: string };
type PlatformBridge = {
  getServerPort: () => Promise<number>;
  getServerToken: () => Promise<string>;
  onSwitchTab: ReturnType<typeof vi.fn>;
  onServerRestarted: ReturnType<typeof vi.fn<(cb: (data: RestartPayload) => void) => void>>;
};
type I18nBridge = { load: ReturnType<typeof vi.fn<(locale: string) => Promise<void>>> };
type MockSettingsStore = {
  activeTab: string;
  ready: boolean;
  serverPort: number | null;
  serverToken: string | null;
  set: ReturnType<typeof vi.fn<(partial: Record<string, unknown>) => void>>;
  getSettingsAgentId: () => string;
  showToast: ReturnType<typeof vi.fn>;
};
type UseSettingsStoreMock = (() => MockSettingsStore) & {
  getState: () => MockSettingsStore;
  setState: (partial: Record<string, unknown>) => void;
};

const loadAgentsMock = vi.fn(async (..._args: unknown[]) => {});
const loadAvatarsMock = vi.fn(async (..._args: unknown[]) => {});
const loadSettingsSnapshotMock = vi.fn(async (..._args: unknown[]) => {});
const codiaFetchMock = vi.fn();

let storeState: MockSettingsStore;

const useSettingsStoreMock = Object.assign(
  () => storeState,
  {
    getState: () => storeState,
    setState: (partial: Record<string, unknown>) => { Object.assign(storeState, partial); },
  },
) as UseSettingsStoreMock;

function stubComponent(name: string) {
  return () => React.createElement('div', { 'data-testid': name });
}

vi.mock('../../settings/store', () => ({
  useSettingsStore: useSettingsStoreMock,
}));

vi.mock('../../settings/api', () => ({
  codiaFetch: (...args: unknown[]) => codiaFetchMock(...args),
}));

vi.mock('../../settings/actions', () => ({
  loadAgents: (...args: unknown[]) => loadAgentsMock(...args),
  loadAvatars: (...args: unknown[]) => loadAvatarsMock(...args),
  loadSettingsSnapshot: (...args: unknown[]) => loadSettingsSnapshotMock(...args),
}));

vi.mock('../../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));
vi.mock('../../components/WindowControls', () => ({ WindowControls: stubComponent('WindowControls') }));
vi.mock('../../components/InputContextMenu', () => ({ InputContextMenu: stubComponent('InputContextMenu') }));
vi.mock('../../settings/SettingsNav', () => ({
  SettingsNav: stubComponent('SettingsNav'),
  settingsCategoryLabel: (category: { fallback: string }) => category.fallback,
  settingsModuleLabel: (module: { fallback?: string; id: string }) => module.fallback || module.id,
}));
vi.mock('../../settings/Toast', () => ({ Toast: stubComponent('Toast') }));
vi.mock('../../settings/tabs/AgentTab', () => ({ AgentTab: stubComponent('AgentTab') }));
vi.mock('../../settings/tabs/MeTab', () => ({ MeTab: stubComponent('MeTab') }));
vi.mock('../../settings/tabs/InterfaceTab', () => ({ InterfaceTab: stubComponent('InterfaceTab') }));
vi.mock('../../settings/tabs/BrowserTab', () => ({ BrowserTab: stubComponent('BrowserTab') }));
vi.mock('../../settings/tabs/WorkTab', () => ({ WorkTab: stubComponent('WorkTab') }));
vi.mock('../../settings/tabs/SkillsTab', () => ({ SkillsTab: stubComponent('SkillsTab') }));
vi.mock('../../settings/tabs/BridgeTab', () => ({ BridgeTab: stubComponent('BridgeTab') }));
vi.mock('../../settings/tabs/ProvidersTab', () => ({ ProvidersTab: stubComponent('ProvidersTab') }));
vi.mock('../../settings/tabs/MediaTab', () => ({ MediaTab: stubComponent('MediaTab') }));
vi.mock('../../settings/tabs/ContextTab', () => ({ ContextTab: stubComponent('ContextTab') }));
vi.mock('../../settings/tabs/ComputerUseSection', () => ({ ComputerUseSection: stubComponent('ComputerUseSection') }));
vi.mock('../../settings/tabs/AboutTab', () => ({ AboutTab: stubComponent('AboutTab') }));
vi.mock('../../settings/tabs/PluginsTab', () => ({ PluginsTab: stubComponent('PluginsTab') }));
vi.mock('../../settings/tabs/DiagnosticsTab', () => ({ DiagnosticsTab: stubComponent('DiagnosticsTab') }));
vi.mock('../../settings/tabs/SecurityTab', () => ({ SecurityTab: stubComponent('SecurityTab') }));
vi.mock('../../settings/tabs/SharingTab', () => ({ SharingTab: stubComponent('SharingTab') }));
vi.mock('../../settings/overlays/CropOverlay', () => ({ CropOverlay: () => null }));
vi.mock('../../settings/overlays/AgentCreateOverlay', () => ({ AgentCreateOverlay: () => null }));
vi.mock('../../settings/overlays/AgentDeleteOverlay', () => ({ AgentDeleteOverlay: () => null }));
vi.mock('../../settings/overlays/MemoryViewer', () => ({ MemoryViewer: () => null }));
vi.mock('../../settings/overlays/CompiledMemoryViewer', () => ({ CompiledMemoryViewer: () => null }));
vi.mock('../../settings/overlays/ClearMemoryConfirm', () => ({ ClearMemoryConfirm: () => null }));
vi.mock('../../settings/overlays/BridgeTutorial', () => ({ BridgeTutorial: () => null }));
vi.mock('../../settings/overlays/WechatQrcodeOverlay', () => ({ WechatQrcodeOverlay: () => null }));
vi.mock('../../settings/overlays/WhatsappQrcodeOverlay', () => ({ WhatsappQrcodeOverlay: () => null }));

describe('settings app smoke', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.resetModules();
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    storeState = {
      activeTab: 'agent',
      ready: true,
      serverPort: null,
      serverToken: null,
      set: vi.fn((partial: Record<string, unknown>) => { Object.assign(storeState, partial); }),
      getSettingsAgentId: () => 'agent-1',
      showToast: vi.fn(),
    };

    codiaFetchMock.mockResolvedValue({
      json: async () => ({ locale: 'en' }),
    });
  });

  it('mounts setting modules only after initial connection and config loading', async () => {
    storeState.ready = false;
    let resolvePort!: (port: number) => void;
    const port = new Promise<number>((resolve) => { resolvePort = resolve; });
    window.platform = {
      getServerPort: () => port,
      getServerToken: async () => 'token-1',
      onServerRestarted: vi.fn(),
    } as unknown as typeof window.platform;
    window.i18n = { load: vi.fn(async () => {}) } as unknown as typeof window.i18n;
    window.t = (key: string) => key;
    const { SettingsContent } = await import('../../settings/SettingsContent');
    const { rerender } = render(<SettingsContent variant="modal" />);
    expect(screen.queryByTestId('AgentTab')).toBeNull();
    expect(codiaFetchMock).not.toHaveBeenCalled();
    await act(async () => { resolvePort(8123); });
    await waitFor(() => expect(storeState.ready).toBe(true));
    // This file's store mock is not reactive; render the resolved state explicitly.
    rerender(<SettingsContent variant="modal" />);
    expect(screen.getByTestId('AgentTab')).toBeTruthy();
    expect(loadSettingsSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes avatars and settings snapshot after a server restart event', async () => {
    let restartHandler: ((data: RestartPayload) => void) | null = null;
    const testWindow = window as unknown as {
      platform?: PlatformBridge;
      i18n?: I18nBridge;
      t?: (key: string) => string;
    };

    testWindow.platform = {
      getServerPort: vi.fn(async () => 8123),
      getServerToken: vi.fn(async () => 'token-1'),
      onSwitchTab: vi.fn(),
      onServerRestarted: vi.fn((cb: (data: RestartPayload) => void) => {
        restartHandler = cb;
      }),
    };
    testWindow.i18n = { load: vi.fn(async () => {}) };
    testWindow.t = (key: string) => key;

    const { SettingsApp } = await import('../../settings/SettingsApp');

    render(React.createElement(SettingsApp));

    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
      expect(loadAvatarsMock).toHaveBeenCalledTimes(1);
      expect(loadSettingsSnapshotMock).toHaveBeenCalledTimes(1);
    });

    expect(restartHandler).toBeTypeOf('function');

    await act(async () => {
      restartHandler?.({ port: 9234, token: 'token-2' });
    });

    await waitFor(() => {
      expect(storeState.set).toHaveBeenCalledWith(expect.objectContaining({
        serverPort: 9234,
        serverToken: 'token-2',
        activeServerConnectionId: 'local',
        activeServerConnection: expect.objectContaining({
          baseUrl: 'http://127.0.0.1:9234',
          token: 'token-2',
        }),
      }));
      expect(loadAgentsMock).toHaveBeenCalledTimes(2);
      expect(loadAvatarsMock).toHaveBeenCalledTimes(2);
      expect(loadSettingsSnapshotMock).toHaveBeenCalledTimes(2);
    });
  }, 30_000);
});
