import { beforeEach, describe, expect, it, vi } from 'vitest';

type StudioWorkspaceState = {
  workspaceId: string;
  mountId: string;
  label: string;
  sourceKind: string | null;
  provider: string | null;
  presentation: string | null;
  capabilities: string[];
  isDefault: boolean;
  nativeRootPath?: string | null;
};

type DeskState = {
  serverPort: number | null;
  currentSessionPath: string | null;
  deskBasePath: string;
  deskCurrentPath: string;
  deskFiles: Array<{ name: string }>;
  deskTreeFilesByPath: Record<string, Array<{ name: string }>>;
  deskExpandedPaths: string[];
  deskSelectedPath: string;
  deskJianContent: string | null;
  deskContextAttached: boolean;
  pendingNewSession: boolean;
  selectedFolder: string | null;
  selectedWorkspaceMountId: string | null;
  selectedWorkspaceLabel: string | null;
  homeFolder: string | null;
  workspaceFolders: string[];
  cwdHistory: string[];
  deskWorkspaceMountId: string | null;
  deskWorkspaceLabel: string | null;
  deskWorkspaceNativeRoot: string | null;
  studioWorkspaces: StudioWorkspaceState[];
  workspaceDeskStateByRoot: Record<string, unknown>;
  previewByOwner: Record<string, { openTabs: string[]; activeTabId: string | null; markdownPreviewIds: string[]; artifacts?: unknown[] }>;
  cwdSkills: unknown[];
  cwdSkillsOpen: boolean;
  previewOpen: boolean;
  jianDrawerOpen: boolean;
  rightWorkspaceTab: string;
  jianView: string;
  inputFocusRequested: boolean;
  setDeskCurrentPath: (path: string) => void;
  setDeskFiles: (files: Array<{ name: string }>) => void;
  setDeskTreeFiles: (subdir: string, files: Array<{ name: string }>) => void;
  setDeskSelectedPath: (path: string) => void;
  setDeskBasePath: (path: string) => void;
  setSelectedWorkspaceMount: (mountId: string | null, label?: string | null) => void;
  setDeskWorkspaceMount: (mountId: string | null, label?: string | null, nativeRootPath?: string | null) => void;
  setStudioWorkspaces: (workspaces: StudioWorkspaceState[]) => void;
  setWorkspaceDeskState: (root: string, state: unknown) => void;
  setDeskJianContent: (content: string | null) => void;
  setDeskContextAttached: (attached: boolean) => void;
  requestInputFocus: () => void;
};

function createTestStore(initial?: Partial<DeskState>) {
  let state: DeskState = {
    serverPort: 60204,
    currentSessionPath: '/session-a',
    deskBasePath: '/desk-a',
    deskCurrentPath: '',
    deskFiles: [],
    deskTreeFilesByPath: {},
    deskExpandedPaths: [],
    deskSelectedPath: '',
    deskJianContent: null,
    deskContextAttached: false,
    pendingNewSession: false,
    selectedFolder: null,
    selectedWorkspaceMountId: null,
    selectedWorkspaceLabel: null,
    homeFolder: null,
    workspaceFolders: [],
    cwdHistory: [],
    deskWorkspaceMountId: null,
    deskWorkspaceLabel: null,
    deskWorkspaceNativeRoot: null,
    studioWorkspaces: [],
    workspaceDeskStateByRoot: {},
    previewByOwner: {},
    cwdSkills: [],
    cwdSkillsOpen: false,
    previewOpen: false,
    jianDrawerOpen: false,
    rightWorkspaceTab: 'workspace',
    jianView: 'desk',
    inputFocusRequested: false,
    setDeskCurrentPath: (path) => { state.deskCurrentPath = path; },
    setDeskFiles: (files) => { state.deskFiles = files; },
    setDeskTreeFiles: (subdir, files) => { state.deskTreeFilesByPath = { ...state.deskTreeFilesByPath, [subdir]: files }; },
    setDeskSelectedPath: (path) => { state.deskSelectedPath = path; },
    setDeskBasePath: (path) => { state.deskBasePath = path; },
    setSelectedWorkspaceMount: (mountId, label = null) => {
      state.selectedWorkspaceMountId = mountId;
      state.selectedWorkspaceLabel = label ?? null;
    },
    setDeskWorkspaceMount: (mountId, label = null, nativeRootPath = null) => {
      state.deskWorkspaceMountId = mountId;
      state.deskWorkspaceLabel = label ?? null;
      state.deskWorkspaceNativeRoot = nativeRootPath ?? null;
    },
    setStudioWorkspaces: (workspaces) => { state.studioWorkspaces = workspaces; },
    setWorkspaceDeskState: (root, value) => {
      state.workspaceDeskStateByRoot = { ...state.workspaceDeskStateByRoot, [root]: value };
    },
    setDeskJianContent: (content) => { state.deskJianContent = content; },
    setDeskContextAttached: (attached) => { state.deskContextAttached = attached; },
    requestInputFocus: () => { state.inputFocusRequested = true; },
    ...initial,
  };

  return {
    getState: () => state,
    setState: (partial: Partial<DeskState> | ((s: DeskState) => Partial<DeskState>)) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch };
    },
  };
}

function jsonResponse(data: unknown) {
  return { json: async () => data };
}

let testStore = createTestStore();
const gsapFetchMock = vi.fn();
const clearChatMock = vi.fn();

vi.mock('../../stores/index', () => ({
  get useStore() {
    return Object.assign(
      (selector?: (s: DeskState) => unknown) => (selector ? selector(testStore.getState()) : testStore.getState()),
      {
        getState: () => testStore.getState(),
        setState: (partial: Partial<DeskState> | ((s: DeskState) => Partial<DeskState>)) => testStore.setState(partial),
      },
    );
  },
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
}));

vi.mock('../../stores/agent-actions', () => ({
  clearChat: (...args: unknown[]) => clearChatMock(...args),
}));

describe('desk-actions studio workspaces', () => {
  beforeEach(() => {
    testStore = createTestStore();
    gsapFetchMock.mockReset();
    clearChatMock.mockReset();
  });

  it('preserves cached desk files and jian content when a reload fails', async () => {
    testStore = createTestStore({
      deskFiles: [{ name: 'keep.md' }],
      deskTreeFilesByPath: {
        '': [{ name: 'keep.md' }],
        src: [{ name: 'src.ts' }],
      },
      deskJianContent: 'keep jian',
    });
    gsapFetchMock.mockRejectedValue(new Error('network down'));
    const mod = await import('../../stores/desk-actions');

    await mod.loadDeskFiles('', '/desk-a');

    const state = testStore.getState();
    expect(state.deskFiles).toEqual([{ name: 'keep.md' }]);
    expect(state.deskTreeFilesByPath).toEqual({
      '': [{ name: 'keep.md' }],
      src: [{ name: 'src.ts' }],
    });
    expect(state.deskJianContent).toBe('keep jian');
  });

  it('preserves cached tree children when a tree reload fails', async () => {
    testStore = createTestStore({
      deskTreeFilesByPath: {
        src: [{ name: 'keep.ts' }],
      },
    });
    gsapFetchMock.mockRejectedValue(new Error('network down'));
    const mod = await import('../../stores/desk-actions');

    await mod.loadDeskTreeFiles('src', { force: true, overrideDir: '/desk-a' });

    expect(testStore.getState().deskTreeFilesByPath.src).toEqual([{ name: 'keep.ts' }]);
  });

  it('loads and normalizes studio workspaces', async () => {
    gsapFetchMock.mockResolvedValue(jsonResponse({
      workspaces: [
        { workspaceId: 'default', mountId: 'default', label: 'Default', isDefault: true, capabilities: ['read'] },
        { workspaceId: 'docs', mountId: 'mount_docs', label: 'Docs', sourceKind: 'storage', provider: 'local_fs', presentation: 'folder', capabilities: ['read', 'write'] },
        { mountId: '' },
      ],
    }));
    const mod = await import('../../stores/desk-actions');

    await expect(mod.loadStudioWorkspaces()).resolves.toEqual([
      {
        workspaceId: 'default',
        mountId: 'default',
        label: 'Default',
        sourceKind: null,
        provider: null,
        presentation: null,
        capabilities: ['read'],
        isDefault: true,
        nativeRootPath: null,
      },
      {
        workspaceId: 'docs',
        mountId: 'mount_docs',
        label: 'Docs',
        sourceKind: 'storage',
        provider: 'local_fs',
        presentation: 'folder',
        capabilities: ['read', 'write'],
        isDefault: false,
        nativeRootPath: null,
      },
    ]);
    expect(testStore.getState().studioWorkspaces.map(item => item.mountId)).toEqual(['default', 'mount_docs']);
  });

  it('applies a studio workspace through the workbench file API', async () => {
    gsapFetchMock.mockImplementation((url: string) => {
      if (url === '/api/workbench/files?mountId=mount_docs') {
        return Promise.resolve(jsonResponse({
          mountId: 'mount_docs',
          mount: { label: 'Docs', nativeRootPath: '/native/docs' },
          files: [{ name: 'readme.md' }],
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const mod = await import('../../stores/desk-actions');

    await mod.applyStudioWorkspace({ mountId: 'mount_docs', label: 'Docs' });

    const state = testStore.getState();
    expect(state.selectedWorkspaceMountId).toBe('mount_docs');
    expect(state.selectedWorkspaceLabel).toBe('Docs');
    expect(state.selectedFolder).toBeNull();
    expect(state.deskWorkspaceMountId).toBe('mount_docs');
    expect(state.deskWorkspaceLabel).toBe('Docs');
    expect(state.deskWorkspaceNativeRoot).toBe('/native/docs');
    expect(state.deskBasePath).toBe('studio:mount_docs');
    expect(state.deskFiles).toEqual([{ name: 'readme.md' }]);
    expect(state.pendingNewSession).toBe(true);
    expect(clearChatMock).toHaveBeenCalledOnce();
    expect(state.inputFocusRequested).toBe(true);
  });

  it('removes an active studio workspace and clears the mounted desk', async () => {
    testStore = createTestStore({
      selectedWorkspaceMountId: 'mount_docs',
      selectedWorkspaceLabel: 'Docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
      deskBasePath: 'studio:mount_docs',
      deskFiles: [{ name: 'readme.md' }],
      deskTreeFilesByPath: { '': [{ name: 'readme.md' }] },
      studioWorkspaces: [
        { workspaceId: 'default', mountId: 'default', label: 'Default', sourceKind: null, provider: null, presentation: null, capabilities: [], isDefault: true, nativeRootPath: null },
        { workspaceId: 'docs', mountId: 'mount_docs', label: 'Docs', sourceKind: 'storage', provider: 'local_fs', presentation: 'folder', capabilities: [], isDefault: false, nativeRootPath: null },
      ],
    });
    gsapFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/api/studio/workspaces/mount_docs' && init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url === '/api/studio/workspaces') {
        return Promise.resolve(jsonResponse({
          workspaces: [
            { workspaceId: 'default', mountId: 'default', label: 'Default', isDefault: true, capabilities: [] },
          ],
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const mod = await import('../../stores/desk-actions');

    await expect(mod.removeStudioWorkspace('mount_docs')).resolves.toBe(true);

    const state = testStore.getState();
    expect(gsapFetchMock).toHaveBeenCalledWith('/api/studio/workspaces/mount_docs', { method: 'DELETE' });
    expect(state.studioWorkspaces.map(item => item.mountId)).toEqual(['default']);
    expect(state.selectedWorkspaceMountId).toBeNull();
    expect(state.selectedWorkspaceLabel).toBeNull();
    expect(state.deskWorkspaceMountId).toBeNull();
    expect(state.deskBasePath).toBe('');
    expect(state.deskFiles).toEqual([]);
  });
});
