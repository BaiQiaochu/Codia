import { beforeEach, describe, expect, it } from 'vitest';
import { createDeskSlice, type DeskSlice } from '../../stores/desk-slice';

type DeskStore = DeskSlice & { currentSessionPath: string | null };

function createStore(currentSessionPath: string | null = null): DeskStore {
  let state = { currentSessionPath } as DeskStore;
  const set = (partial: Partial<DeskStore> | ((s: DeskStore) => Partial<DeskStore>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  state = {
    currentSessionPath,
    ...createDeskSlice(set as never, get as never),
  } as DeskStore;
  return new Proxy({} as DeskStore, {
    get: (_, key: string) => state[key as keyof DeskStore],
    set: (_, key: string, value: unknown) => {
      state = { ...state, [key]: value } as DeskStore;
      return true;
    },
  });
}

describe('desk-slice owner isolation', () => {
  let store: DeskStore;

  beforeEach(() => {
    store = createStore(null);
  });

  it('keeps desk owner state separate from session owner state', () => {
    store.setDeskBasePath('/desk-root');
    store.setDeskCurrentPath('desk-sub');
    store.setDeskJianContent('desk-jian');
    store.setCwdSkills([{ name: 'desk-skill', description: 'desk', source: 'Agents', filePath: '/desk/SKILL.md', baseDir: '/desk' }]);

    store.currentSessionPath = '/session-a';
    store.setDeskBasePath('/session-root');
    store.setDeskCurrentPath('session-sub');
    store.setDeskJianContent('session-jian');
    store.setCwdSkills([{ name: 'session-skill', description: 'session', source: 'Agents', filePath: '/session/SKILL.md', baseDir: '/session' }]);

    const deskState = store.getDeskStateForOwner('desk');
    const sessionState = store.getDeskStateForOwner('/session-a');

    expect(deskState?.deskBasePath).toBe('/desk-root');
    expect(deskState?.deskCurrentPath).toBe('desk-sub');
    expect(deskState?.deskJianContent).toBe('desk-jian');
    expect(deskState?.cwdSkills.map((s) => s.name)).toEqual(['desk-skill']);

    expect(sessionState?.deskBasePath).toBe('/session-root');
    expect(sessionState?.deskCurrentPath).toBe('session-sub');
    expect(sessionState?.deskJianContent).toBe('session-jian');
    expect(sessionState?.cwdSkills.map((s) => s.name)).toEqual(['session-skill']);
  });

  it('can clone desk state to a new session and restore it later', () => {
    store.setDeskBasePath('/desk-root');
    store.setDeskCurrentPath('desk-sub');
    store.setDeskJianContent('desk-jian');
    store.setCwdSkills([{ name: 'desk-skill', description: 'desk', source: 'Agents', filePath: '/desk/SKILL.md', baseDir: '/desk' }]);

    store.cloneDeskStateToOwner('/session-b');

    store.currentSessionPath = '/session-b';
    store.restoreDeskStateForOwner('/session-b');

    expect(store.deskBasePath).toBe('/desk-root');
    expect(store.deskCurrentPath).toBe('desk-sub');
    expect(store.deskJianContent).toBe('desk-jian');
    expect(store.cwdSkills.map((s) => s.name)).toEqual(['desk-skill']);
  });
});
