// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WelcomeScreen } from '../../components/WelcomeScreen';

type StoreState = {
  welcomeVisible: boolean;
  serverPort: string | null;
  activeServerConnection?: { url: string };
  agents: unknown[];
  agentName: string;
  agentAvatarUrl: string | null;
  agentYuan: string;
  currentAgentId: string | null;
  selectedAgentId: string | null;
  memoryEnabled: boolean;
  memoryMasterEnabled: boolean;
  selectedFolder: string | null;
  selectedWorkspaceMountId: string | null;
  selectedWorkspaceLabel: string | null;
  studioWorkspaces: Array<{
    workspaceId: string;
    mountId: string;
    label: string;
    sourceKind: string | null;
    provider: string | null;
    presentation: string | null;
    capabilities: string[];
    isDefault: boolean;
    nativeRootPath?: string | null;
  }>;
  homeFolder: string | null;
  workspaceFolders: string[];
  cwdHistory: string[];
  locale: string;
  currentTab: 'chat' | 'workflow';
  currentSessionPath: string | null;
  setDraft: ReturnType<typeof vi.fn>;
  requestInputFocus: ReturnType<typeof vi.fn>;
};

let state: StoreState;

const loadStudioWorkspacesMock = vi.fn(async (..._args: unknown[]) => []);
const applyStudioWorkspaceMock = vi.fn(async (..._args: unknown[]) => undefined);
const createLocalStudioWorkspaceFromFolderMock = vi.fn(async (..._args: unknown[]) => null);
const removeStudioWorkspaceMock = vi.fn(async (..._args: unknown[]) => true);
const { switchTabMock, live2DPropsMock, resolveLive2DAssetsMock } = vi.hoisted(() => ({
  switchTabMock: vi.fn(),
  live2DPropsMock: vi.fn(),
  resolveLive2DAssetsMock: vi.fn(() => ({
    modelUrl: 'http://127.0.0.1:15733/desktop/assets/codia/live2d/model/Codia.model3.json',
    shaderPath: 'http://127.0.0.1:15733/desktop/assets/codia/live2d/shaders/',
  })),
}));

vi.mock('../../live2d/assets', () => ({ resolveCodiaLive2DAssets: resolveLive2DAssetsMock }));
vi.mock('../../components/CodiaLive2DMascot', () => ({
  CodiaLive2DMascot: (props: { fallback: React.ReactNode; className?: string }) => {
    live2DPropsMock(props);
    return <div data-testid="live2d-mascot" className={props.className}>{props.fallback}</div>;
  },
}));

vi.mock('../../stores', () => ({
  get useStore() {
    return Object.assign(
      (selector?: (s: StoreState) => unknown) => (selector ? selector(state) : state),
      {
        getState: () => state,
        setState: (partial: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)) => {
          const patch = typeof partial === 'function' ? partial(state) : partial;
          state = { ...state, ...patch };
        },
      },
    );
  },
}));

vi.mock('../../stores/desk-actions', () => ({
  activateWorkspaceDesk: vi.fn(async () => undefined),
  addWorkspaceFolder: vi.fn(),
  applyFolder: vi.fn(async () => undefined),
  applyStudioWorkspace: (...args: unknown[]) => applyStudioWorkspaceMock(...args),
  createLocalStudioWorkspaceFromFolder: (...args: unknown[]) => createLocalStudioWorkspaceFromFolderMock(...args),
  loadStudioWorkspaces: (...args: unknown[]) => loadStudioWorkspacesMock(...args),
  removeRecentWorkspace: vi.fn(async () => undefined),
  removeStudioWorkspace: (...args: unknown[]) => removeStudioWorkspaceMock(...args),
  removeWorkspaceFolder: vi.fn(),
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: vi.fn(async () => ({ json: async () => ({}) })),
}));

vi.mock('../../utils/ui-helpers', () => ({
  loadModels: vi.fn(async () => undefined),
}));

vi.mock('../../stores/settings-modal-actions', () => ({
  openSettingsModal: vi.fn(),
}));

vi.mock('../../components/channels/tab-router', () => ({ switchTab: switchTabMock }));

vi.mock('../../utils/agent-display', () => ({
  AgentAvatar: ({ className, alt }: { className?: string; alt?: string }) => (
    <span className={className} aria-label={alt || 'agent'} />
  ),
  refreshAgentAvatarVersion: vi.fn(),
  resolveAgentDisplayInfo: () => ({ displayName: 'G-SAP', yuan: 'gsap' }),
}));

describe('WelcomeScreen studio workspaces', () => {
  beforeEach(() => {
    state = {
      welcomeVisible: true,
      serverPort: '15733',
      agents: [],
      agentName: 'G-SAP',
      agentAvatarUrl: null,
      agentYuan: 'gsap',
      currentAgentId: null,
      selectedAgentId: null,
      memoryEnabled: true,
      memoryMasterEnabled: true,
      selectedFolder: null,
      selectedWorkspaceMountId: 'mount_docs',
      selectedWorkspaceLabel: 'Docs',
      studioWorkspaces: [
        { workspaceId: 'default', mountId: 'default', label: 'Default', sourceKind: null, provider: null, presentation: null, capabilities: [], isDefault: true, nativeRootPath: null },
        { workspaceId: 'docs', mountId: 'mount_docs', label: 'Docs', sourceKind: 'storage', provider: 'local_fs', presentation: 'folder', capabilities: [], isDefault: false, nativeRootPath: null },
      ],
      homeFolder: null,
      workspaceFolders: [],
      cwdHistory: [],
      locale: 'en',
      currentTab: 'chat',
      currentSessionPath: null,
      setDraft: vi.fn(),
      requestInputFocus: vi.fn(),
    };
    (window as typeof window & { t?: (key: string) => string }).t = (key: string) => {
      if (key === 'input.workspace') return 'Workspace: ';
      if (key === 'input.removeStudioWorkspace') return 'Remove workspace';
      return key;
    };
    (window as typeof window & { platform: Partial<typeof window.platform> }).platform = {
      selectFolder: vi.fn(async () => '/tmp/docs'),
    } as unknown as typeof window.platform;
    loadStudioWorkspacesMock.mockClear();
    applyStudioWorkspaceMock.mockClear();
    createLocalStudioWorkspaceFromFolderMock.mockClear();
    removeStudioWorkspaceMock.mockClear();
    switchTabMock.mockClear();
    live2DPropsMock.mockClear();
    resolveLive2DAssetsMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads, selects, and removes studio workspaces from the welcome picker', async () => {
    render(<WelcomeScreen />);

    await waitFor(() => expect(loadStudioWorkspacesMock).toHaveBeenCalledOnce());
    expect(screen.queryByText('今天想对')).toBeNull();
    const workspaceControls = screen.getByText('Workspace: Docs').closest('[class*="workspaceControls"]');
    expect(workspaceControls?.contains(screen.getByRole('button', { name: 'settings.title' }))).toBe(true);
    fireEvent.click(screen.getByText('Workspace: Docs'));
    fireEvent.click(screen.getAllByText('Default')[0]);
    expect(applyStudioWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({ mountId: 'default' }));

    fireEvent.click(screen.getByText('Workspace: Docs'));
    fireEvent.click(screen.getByLabelText('Remove workspace'));
    expect(removeStudioWorkspaceMock).toHaveBeenCalledWith('mount_docs');
  });

  it('connects quick actions to the live input and workflow page', async () => {
    const draftEvents: Array<{ text?: string; source?: string; quickAction?: string }> = [];
    const onDraft = (event: Event) => {
      draftEvents.push((event as CustomEvent<{ text?: string; source?: string }>).detail || {});
    };
    window.addEventListener('gsap-input-draft-request', onDraft);

    try {
      render(<WelcomeScreen />);
      fireEvent.click(screen.getByRole('button', { name: /整理我的想法/ }));
      expect(state.setDraft).not.toHaveBeenCalled();
      expect(draftEvents.at(-1)).toMatchObject({
        text: '', quickAction: 'ideas',
        source: 'welcome-quick-action',
      });

      fireEvent.click(screen.getByRole('button', { name: /开始编程协作/ }));
      expect(window.platform.selectFolder).not.toHaveBeenCalled();
      expect(draftEvents.at(-1)?.quickAction).toBe('code');

      fireEvent.click(screen.getByRole('button', { name: /搭建一个工作流/ }));
      expect(draftEvents.at(-1)?.quickAction).toBe('workflow');
      expect(switchTabMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /问问我的 Agent/ }));
      expect(draftEvents.at(-1)?.quickAction).toBe('agents');
    } finally {
      window.removeEventListener('gsap-input-draft-request', onDraft);
    }
  });

  it('uses the local asset port and a dedicated mascot surface, preserving the PNG fallback', () => {
    state.activeServerConnection = { url: 'https://remote.example.test' };
    const { container } = render(<WelcomeScreen />);

    expect(resolveLive2DAssetsMock).toHaveBeenCalledWith(window.location.href, 15733);
    expect(live2DPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true, gpuSafeMode: false, hardwareAccelerationEnabled: true,
      assets: expect.objectContaining({ modelUrl: expect.stringContaining('/model/Codia.model3.json') }),
    }));
    expect(screen.getByTestId('live2d-mascot').closest('[data-codia-mascot-frame]')).toBeNull();
    expect(container.querySelector('[data-codia-mascot-frame] img')).not.toBeNull();
  });

  it('waits for the desktop GPU policy and passes the actual safe mode to the mascot', async () => {
    let resolvePolicy!: (value: { gpuSafeMode: boolean; hardwareAccelerationEnabled: boolean }) => void;
    window.platform.getGpuRuntimeState = vi.fn(() => new Promise<{ gpuSafeMode: boolean; hardwareAccelerationEnabled: boolean }>(resolve => { resolvePolicy = resolve; }));
    render(<WelcomeScreen />);
    expect(live2DPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    await act(async () => resolvePolicy({ gpuSafeMode: true, hardwareAccelerationEnabled: false }));
    expect(live2DPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true, gpuSafeMode: true, hardwareAccelerationEnabled: false,
    }));
  });

  it('keeps the PNG fallback when the desktop GPU policy cannot be read', async () => {
    window.platform.getGpuRuntimeState = vi.fn().mockRejectedValue(new Error('IPC unavailable'));
    render(<WelcomeScreen />);
    await act(async () => { await Promise.resolve(); });
    expect(window.platform.getGpuRuntimeState).toHaveBeenCalledOnce();
    expect(live2DPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('does not mount a mascot when the welcome screen is hidden', () => {
    state.welcomeVisible = false;
    render(<WelcomeScreen />);
    expect(live2DPropsMock).not.toHaveBeenCalled();
  });
});
