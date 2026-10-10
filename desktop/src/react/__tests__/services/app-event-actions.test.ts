import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, unknown>;
type MockAgentRow = { id: string; name: string; memoryMasterEnabled?: boolean };
type TestPlatform = { settingsChanged: ReturnType<typeof vi.fn> };

const mockState: MockState = {};

const mockcodiaFetch = vi.fn();
const mockApplyAgentIdentity = vi.fn(async () => {});
const mockLoadAgents = vi.fn(async () => {});
const mockLoadSessions = vi.fn(async () => {});
const mockLoadModels = vi.fn(async () => {});
const mockActivateWorkspaceDesk = vi.fn(async () => {});
const mockLoadChannels = vi.fn(async () => {});
const mockEnsureSession = vi.fn(async () => true);

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => mockState,
    setState: (patch: MockState | ((state: MockState) => MockState)) => {
      const next = typeof patch === 'function' ? patch(mockState) : patch;
      Object.assign(mockState, next);
    },
  },
}));

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: mockcodiaFetch,
}));

vi.mock('../../stores/agent-actions', () => ({
  applyAgentIdentity: mockApplyAgentIdentity,
  loadAgents: mockLoadAgents,
}));

vi.mock('../../stores/session-actions', () => ({
  ensureSession: mockEnsureSession,
  loadSessions: mockLoadSessions,
}));


vi.mock('../../utils/ui-helpers', () => ({
  loadModels: mockLoadModels,
}));

vi.mock('../../stores/desk-actions', () => ({
  activateWorkspaceDesk: mockActivateWorkspaceDesk,
}));

vi.mock('../../stores/channel-actions', () => ({
  loadChannels: mockLoadChannels,
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

function testWindow(): Record<string, unknown> & {
  __loadDeskSkills?: ReturnType<typeof vi.fn>;
  dispatchEvent?: ReturnType<typeof vi.fn>;
} {
  return window as unknown as Record<string, unknown> & {
    __loadDeskSkills?: ReturnType<typeof vi.fn>;
    dispatchEvent?: ReturnType<typeof vi.fn>;
  };
}

function testI18n(): { locale: string } {
  return (globalThis as Record<string, unknown>).i18n as { locale: string };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('app-event-actions', () => {
  beforeEach(() => {
    Object.keys(mockState).forEach((key) => delete mockState[key]);
    mockcodiaFetch.mockReset();
    mockApplyAgentIdentity.mockReset();
    mockLoadAgents.mockReset();
    mockLoadSessions.mockReset();
    mockLoadModels.mockReset();
    mockActivateWorkspaceDesk.mockReset();
    mockLoadChannels.mockReset();
    mockEnsureSession.mockReset();
    mockEnsureSession.mockResolvedValue(true);
    vi.resetModules();

    Object.assign(mockState, {
      agentName: 'Codia',
      currentAgentId: null,
      currentSessionPath: null,
      cwdHistory: [],
      workspaceFolders: [],
    });

    (globalThis as Record<string, unknown>).window = {
      __loadDeskSkills: vi.fn(),
      setTheme: vi.fn(),
      setPaperTexture: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    (globalThis as Record<string, unknown>).i18n = {
      locale: 'zh-CN',
      defaultName: 'Codia',
      load: vi.fn(async (locale: string) => {
        testI18n().locale = locale;
      }),
    };
  });

  it('agent-switched reloads dependent state and preserves desk skill refresh hooks', async () => {
    mockcodiaFetch
      .mockResolvedValueOnce(jsonResponse({
        desk: { home_folder: '/agent-home' },
        cwd_history: ['/agent-home/work', '/recent'],
      }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [{ id: 'job-1' }] }));

    Object.assign(mockState, {
      currentChannel: { id: 'old' },
      channelMessages: [{ id: 'm1' }],
      channelMembers: [{ id: 'u1' }],
      channelMemberRoles: { u1: 'admin' },
      channelInfoDescription: 'old description',
      thinkingLevel: 'high',
      activities: [{ id: 'a1' }],
    });

    const { handleAppEvent } = await import('../../services/app-event-actions');
    handleAppEvent('agent-switched', { agentName: 'Codia', agentId: 'agent-a' });
    await flushPromises();

    expect(mockApplyAgentIdentity).toHaveBeenCalledWith({
      agentName: 'Codia',
      agentId: 'agent-a',
    });
    expect(mockLoadSessions).toHaveBeenCalledTimes(1);
    expect(mockLoadChannels).toHaveBeenCalledTimes(1);
    expect(mockLoadModels).toHaveBeenCalledTimes(1);
    expect(testWindow().__loadDeskSkills).toHaveBeenCalledTimes(1);
    expect(mockState.currentChannel).toBeNull();
    expect(mockState.channelMessages).toEqual([]);
    expect(mockState.channelMembers).toEqual([]);
    expect(mockState.channelMemberRoles).toEqual({});
    expect(mockState.channelInfoDescription).toBe('');
    expect(mockState.thinkingLevel).toBe('auto');
    expect(mockState.activities).toEqual([]);
    expect(mockState.homeFolder).toBe('/agent-home');
    expect(mockState.selectedFolder).toBe('/agent-home');
    expect(mockState.cwdHistory).toEqual(['/agent-home/work', '/recent']);
    expect(mockState.automationCount).toBe(1);
    expect(mockActivateWorkspaceDesk).toHaveBeenCalledWith('/agent-home');
  });

  it('skills-changed refreshes desk skills', async () => {
    const { handleAppEvent } = await import('../../services/app-event-actions');

    handleAppEvent('skills-changed', { agentId: 'agent-a' });

    expect(testWindow().__loadDeskSkills).toHaveBeenCalledTimes(1);
    expect(testWindow().dispatchEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(testWindow().dispatchEvent).mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe('codia-skills-changed');
    expect(event.detail).toEqual({ agentId: 'agent-a' });
  });
  it('models-changed reloads models and requests context usage for the active session', async () => {
    Object.assign(mockState, { currentSessionPath: '/session/a.jsonl' });
    const requestContextUsage = vi.fn();
    const { configureAppEventActions, handleAppEvent } = await import('../../services/app-event-actions');

    configureAppEventActions({ requestContextUsage });
    handleAppEvent('models-changed');

    expect(mockLoadModels).toHaveBeenCalledTimes(1);
    expect(requestContextUsage).toHaveBeenCalledWith('/session/a.jsonl');
  });

  it('model-metadata-changed reloads models without touching active session context', async () => {
    Object.assign(mockState, { currentSessionPath: '/session/a.jsonl' });
    const requestContextUsage = vi.fn();
    const { configureAppEventActions, handleAppEvent } = await import('../../services/app-event-actions');

    configureAppEventActions({ requestContextUsage });
    handleAppEvent('model-metadata-changed', { providerId: 'openai', modelId: 'gpt-test' });

    expect(mockLoadModels).toHaveBeenCalledTimes(1);
    expect(requestContextUsage).not.toHaveBeenCalled();
  });

  it('agent-updated refreshes the list for other agents but keeps current agent identity updates local', async () => {
    Object.assign(mockState, { currentAgentId: 'agent-a' });
    const { handleAppEvent } = await import('../../services/app-event-actions');

    handleAppEvent('agent-updated', {
      agentId: 'agent-b',
      agentName: 'Other Agent',
      yuan: 'other-yuan',
    });

    expect(mockLoadAgents).toHaveBeenCalledTimes(1);
    expect(mockApplyAgentIdentity).not.toHaveBeenCalled();

    mockLoadAgents.mockClear();
    mockApplyAgentIdentity.mockClear();

    handleAppEvent('agent-updated', {
      agentId: 'agent-a',
      agentName: 'Codia Prime',
      yuan: 'muse',
    });

    expect(mockLoadAgents).not.toHaveBeenCalled();
    expect(mockApplyAgentIdentity).toHaveBeenCalledWith({
      agentName: 'Codia Prime',
      agentId: 'agent-a',
      yuan: 'muse',
      ui: { settings: false },
    });
  });

  it('memory-master-changed updates the current agent gate and cached agent row', async () => {
    Object.assign(mockState, {
      currentAgentId: 'agent-a',
      memoryMasterEnabled: true,
      agents: [
        { id: 'agent-a', name: 'Codia', memoryMasterEnabled: true },
        { id: 'agent-b', name: 'Other', memoryMasterEnabled: true },
      ],
    });
    const { handleAppEvent } = await import('../../services/app-event-actions');

    handleAppEvent('memory-master-changed', { agentId: 'agent-a', enabled: false });

    expect(mockState.memoryMasterEnabled).toBe(false);
    expect((mockState.agents as MockAgentRow[]).find(a => a.id === 'agent-a')?.memoryMasterEnabled).toBe(false);
    expect((mockState.agents as MockAgentRow[]).find(a => a.id === 'agent-b')?.memoryMasterEnabled).toBe(true);
  });

  it('does not echo desktop IPC network proxy broadcasts back to the shell', async () => {
    const settingsChanged = vi.fn();
    window.platform = { settingsChanged } as unknown as Window['platform'] & TestPlatform;

    const { handleAppEvent } = await import('../../services/app-event-actions');
    handleAppEvent(
      'network-proxy-changed',
      { network_proxy: { mode: 'direct' } },
      { source: 'desktop-ipc' },
    );

    expect(settingsChanged).not.toHaveBeenCalled();
  });

  it('forwards server network proxy app events to the shell once', async () => {
    const settingsChanged = vi.fn();
    window.platform = { settingsChanged } as unknown as Window['platform'] & TestPlatform;

    const { handleAppEvent } = await import('../../services/app-event-actions');
    handleAppEvent(
      'network-proxy-changed',
      { network_proxy: { mode: 'direct' } },
      { source: 'server' },
    );

    expect(settingsChanged).toHaveBeenCalledTimes(1);
    expect(settingsChanged).toHaveBeenCalledWith('network-proxy-changed', { network_proxy: { mode: 'direct' } });
  });

  it('agent-workspace-changed only updates the current agent workspace and refreshes the default desk', async () => {
    Object.assign(mockState, {
      currentAgentId: 'agent-a',
      homeFolder: '/old-home',
      selectedFolder: '/old-home',
      workspaceFolders: ['/old-home/project'],
      cwdHistory: ['/old-home'],
      deskBasePath: '/old-home',
      pendingNewSession: true,
      currentSessionPath: null,
    });

    const { handleAppEvent } = await import('../../services/app-event-actions');
    handleAppEvent('agent-workspace-changed', {
      agentId: 'agent-a',
      homeFolder: '/new-home',
      cwdHistory: ['/new-home', '/recent'],
    });

    expect(mockState.homeFolder).toBe('/new-home');
    expect(mockState.selectedFolder).toBe('/new-home');
    expect(mockState.workspaceFolders).toEqual([]);
    expect(mockState.cwdHistory).toEqual(['/new-home', '/recent']);
    expect(mockActivateWorkspaceDesk).toHaveBeenCalledWith('/new-home');

    mockActivateWorkspaceDesk.mockClear();
    handleAppEvent('agent-workspace-changed', {
      agentId: 'agent-b',
      homeFolder: '/other-home',
      cwdHistory: ['/other-home'],
    });

    expect(mockState.homeFolder).toBe('/new-home');
    expect(mockState.selectedFolder).toBe('/new-home');
    expect(mockState.cwdHistory).toEqual(['/new-home', '/recent']);
    expect(mockActivateWorkspaceDesk).not.toHaveBeenCalled();
  });
});
