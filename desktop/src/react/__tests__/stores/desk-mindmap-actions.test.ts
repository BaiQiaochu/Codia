// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type DeskState = {
  currentSessionPath: string | null;
  deskBasePath: string;
  deskCurrentPath: string;
  deskFiles: Array<{ name: string }>;
  toastMessages: Array<{ message: string; type: string }>;
  setDeskFiles: (files: Array<{ name: string }>) => void;
  setDeskTreeFiles: (subdir: string, files: Array<{ name: string }>) => void;
  addToast: (message: string, type: string) => void;
};

function createTestStore(initial?: Partial<DeskState>) {
  let state: DeskState = {
    currentSessionPath: '/session-a',
    deskBasePath: '/desk-a',
    deskCurrentPath: '',
    deskFiles: [],
    toastMessages: [],
    setDeskFiles: (files) => { state.deskFiles = files; },
    setDeskTreeFiles: () => {},
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

function jsonResponse(data: unknown) {
  return { json: async () => data };
}

let testStore = createTestStore();
const codiaFetchMock = vi.fn();

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

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: (...args: unknown[]) => codiaFetchMock(...args),
}));

vi.mock('../../stores/agent-actions', () => ({
  clearChat: vi.fn(),
}));

describe('desk mind map actions', () => {
  beforeEach(() => {
    testStore = createTestStore({
      deskFiles: [
        { name: 'Mind Map.xmind' },
        { name: 'Mind Map 2.xmind' },
      ],
    });
    codiaFetchMock.mockReset();
    window.t = ((key: string) => (key === 'desk.newMindmapFile' ? 'Mind Map.xmind' : key)) as typeof window.t;
  });

  it('creates a unique XMind mind map through the desk file route', async () => {
    codiaFetchMock.mockResolvedValue(jsonResponse({ ok: true, files: [{ name: 'Mind Map 3.xmind' }] }));
    const mod = await import('../../stores/desk-actions');

    await expect(mod.deskCreateMindmap()).resolves.toBe(true);

    const body = JSON.parse(codiaFetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      action: 'createMindmap',
      dir: '/desk-a',
      subdir: '',
      name: 'Mind Map 3.xmind',
      title: 'Mind Map 3',
    });
    expect(testStore.getState().deskFiles).toEqual([{ name: 'Mind Map 3.xmind' }]);
  });

  it('creates an XMind mind map from a selected document', async () => {
    codiaFetchMock.mockResolvedValue(jsonResponse({ ok: true, files: [{ name: 'brief.xmind' }] }));
    const mod = await import('../../stores/desk-actions');

    await expect(mod.deskCreateMindmapFromDocument('brief.md')).resolves.toBe(true);

    const body = JSON.parse(codiaFetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      action: 'createMindmapFromDocument',
      dir: '/desk-a',
      subdir: '',
      sourceName: 'brief.md',
      name: 'brief.xmind',
    });
    expect(testStore.getState().deskFiles).toEqual([{ name: 'brief.xmind' }]);
  });
});
