import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  activeServerConnection: unknown | null;
  activeServerConnectionId: string | null;
  serverConnections: Record<string, unknown>;
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
  workspaceDeskStateByRoot: Record<string, unknown>;
  appViewMode: 'standard' | 'obsidian';
  jianOpen: boolean;
  jianAutoCollapsed: boolean;
  currentTab: string;
  inputFocusRequested: boolean;
  toastMessages: Array<{ message: string; type: string }>;
  previewByOwner: Record<string, { openTabs: string[]; activeTabId: string | null; markdownPreviewIds: string[]; artifacts?: unknown[] }>;
  cwdSkills: unknown[];
  cwdSkillsOpen: boolean;
  previewOpen: boolean;
  jianDrawerOpen: boolean;
  rightWorkspaceTab: string;
  jianView: string;
  setDeskCurrentPath: (path: string) => void;
  setDeskFiles: (files: Array<{ name: string }>) => void;
  setDeskTreeFiles: (subdir: string, files: Array<{ name: string }>) => void;
  setDeskSelectedPath: (path: string) => void;
  setDeskBasePath: (path: string) => void;
  setSelectedWorkspaceMount: (mountId: string | null, label?: string | null) => void;
  setDeskWorkspaceMount: (mountId: string | null, label?: string | null, nativeRootPath?: string | null) => void;
  setStudioWorkspaces: (workspaces: DeskState['studioWorkspaces']) => void;
  setWorkspaceDeskState: (root: string, state: unknown) => void;
  setDeskJianContent: (content: string | null) => void;
  setDeskContextAttached: (attached: boolean) => void;
  setJianOpen: (open: boolean) => void;
  requestInputFocus: () => void;
  addToast: (message: string, type: string) => void;
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
    activeServerConnection: null,
    activeServerConnectionId: null,
    serverConnections: {},
    studioWorkspaces: [],
    workspaceDeskStateByRoot: {},
    appViewMode: 'standard',
    jianOpen: true,
    jianAutoCollapsed: false,
    currentTab: 'chat',
    inputFocusRequested: false,
    toastMessages: [],
    previewByOwner: {},
    cwdSkills: [],
    cwdSkillsOpen: false,
    previewOpen: false,
    jianDrawerOpen: false,
    rightWorkspaceTab: 'workspace',
    jianView: 'desk',
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
    setJianOpen: (open) => { state.jianOpen = open; },
    requestInputFocus: () => { state.inputFocusRequested = true; },
    addToast: (message, type) => { state.toastMessages = [...state.toastMessages, { message, type }]; },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

describe('desk-actions', () => {
  beforeEach(() => {
    testStore = createTestStore();
    gsapFetchMock.mockReset();
    clearChatMock.mockReset();
  });

  it('keeps the latest desk file load when responses resolve out of order', async () => {
    const first = deferred<{ json: () => Promise<unknown> }>();
    const second = deferred<{ json: () => Promise<unknown> }>();

    gsapFetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/desk/files') && url.includes('dir=%2Fdesk-a')) return first.promise;
      if (url.includes('/api/desk/files') && url.includes('dir=%2Fdesk-b')) return second.promise;
      if (url.startsWith('/api/desk/jian')) return Promise.resolve(jsonResponse({ content: null }));
      throw new Error(`unexpected request: ${url}`);
    });

    const mod = await import('../../stores/desk-actions');

    const firstLoad = mod.loadDeskFiles('', '/desk-a');
    const secondLoad = mod.loadDeskFiles('next', '/desk-b');

    second.resolve(jsonResponse({ files: [{ name: 'new.txt' }], basePath: '/desk-b' }));
    await secondLoad;

    first.resolve(jsonResponse({ files: [{ name: 'old.txt' }], basePath: '/desk-a' }));
    await firstLoad;

    const state = testStore.getState();
    expect(state.deskBasePath).toBe('/desk-b');
    expect(state.deskCurrentPath).toBe('next');
    expect(state.deskFiles).toEqual([{ name: 'new.txt' }]);
  });

  it('does not apply a stale jian save after switching sessions', async () => {
    const savePost = deferred<{ json: () => Promise<unknown> }>();

    gsapFetchMock.mockImplementation((url: string) => {
      if (url === '/api/desk/jian') return savePost.promise;
      if (url.startsWith('/api/desk/files')) return Promise.resolve(jsonResponse({ files: [{ name: 'should-not-apply.txt' }] }));
      throw new Error(`unexpected request: ${url}`);
    });

    const mod = await import('../../stores/desk-actions');

    const savePromise = mod.saveJianContent('jian-a');

    testStore.setState({
      currentSessionPath: '/session-b',
      deskBasePath: '/desk-b',
      deskCurrentPath: 'subdir',
      deskJianContent: 'jian-b',
      deskFiles: [{ name: 'keep.txt' }],
    });

    savePost.resolve(jsonResponse({ ok: true }));
    await savePromise;

    const state = testStore.getState();
    expect(state.currentSessionPath).toBe('/session-b');
    expect(state.deskBasePath).toBe('/desk-b');
    expect(state.deskCurrentPath).toBe('subdir');
    expect(state.deskJianContent).toBe('jian-b');
    expect(state.deskFiles).toEqual([{ name: 'keep.txt' }]);
    expect(gsapFetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens the right sidebar even with a legacy reading-mode value and persists the choice', async () => {
    testStore = createTestStore({ appViewMode: 'obsidian', jianOpen: false });
    const mod = await import('../../stores/desk-actions');

    const storage = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    try {
      mod.toggleJianSidebar(true);
      expect(testStore.getState().jianOpen).toBe(true);
      expect(storage.setItem).toHaveBeenCalledWith('gsap-jian-chat', 'open');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns false and shows a toast when creating a desk file fails', async () => {
    gsapFetchMock.mockResolvedValue(jsonResponse({ error: 'error.noWorkspace' }));
    const mod = await import('../../stores/desk-actions');

    await expect(mod.deskCreateFile('')).resolves.toBe(false);

    expect(testStore.getState().deskFiles).toEqual([]);
    expect(testStore.getState().toastMessages).toEqual([
      { message: 'error.noWorkspace', type: 'error' },
    ]);
  });

  it('creates a unique markdown file name when the default note already exists', async () => {
    const d = new Date();
    const ts = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    testStore = createTestStore({
      deskFiles: [
        { name: `${ts}-备注.md` },
        { name: `${ts}-备注 2.md` },
      ],
    });
    gsapFetchMock.mockResolvedValue(jsonResponse({ ok: true, files: [] }));
    const mod = await import('../../stores/desk-actions');

    await expect(mod.deskCreateFile('')).resolves.toBe(true);

    const body = JSON.parse(gsapFetchMock.mock.calls[0][1].body as string);
    expect(body.name).toBe(`${ts}-备注 3.md`);
  });

  it('safe-deletes default workspace tree items through ResourceIO for remote desktop clients', async () => {
    const trashItem = vi.fn(async () => true);
    vi.stubGlobal('window', { platform: { trashItem } });
    testStore = createTestStore({
      activeServerConnection: {
        connectionId: 'browser:server_lan',
        kind: 'lan',
        serverId: 'server_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN G-SAP',
        baseUrl: 'http://gsap.local:14500',
        wsUrl: 'ws://gsap.local:14500',
        token: null,
        authState: 'paired',
        trustState: 'lan',
        credentialKind: 'device_credential',
        platformAccountId: null,
        officialServiceKind: null,
        capabilities: ['resources', 'files'],
      },
      deskBasePath: '/server/workspace',
      deskTreeFilesByPath: {
        notes: [{ name: 'chapter.md' }],
      },
    });
    gsapFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, files: [] }));

    const mod = await import('../../stores/desk-actions');
    const ok = await mod.deskTrashTreeItems([{ sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false }]);

    expect(ok).toBe(true);
    expect(trashItem).not.toHaveBeenCalled();
    expect(gsapFetchMock).toHaveBeenCalledWith('/api/workbench/actions', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'safeDelete',
        mountId: 'default',
        subdir: 'notes',
        name: 'chapter.md',
      }),
    }));
    expect(testStore.getState().deskTreeFilesByPath.notes).toEqual([]);
  });
});
