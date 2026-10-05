import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionSlice, type SessionSlice } from '../../stores/session-slice';

function makeSlice(): SessionSlice {
  let state: SessionSlice;
  const set = (partial: Partial<SessionSlice> | ((s: SessionSlice) => Partial<SessionSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createSessionSlice(set);
  return new Proxy({} as SessionSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('session-slice', () => {
  let slice: SessionSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('initializes session state', () => {
    expect(slice.sessions).toEqual([]);
    expect(slice.currentSessionPath).toBeNull();
    expect(slice.currentSessionId).toBeNull();
    expect(slice.sessionLocatorsById).toEqual({});
    expect(slice.sessionStreams).toEqual({});
    expect(slice.pendingNewSession).toBe(false);
    expect(slice.memoryEnabled).toBe(true);
    expect(slice.sessionTodos).toEqual([]);
  });

  it('stores stream metadata by path without a locator', () => {
    slice.setSessionStream('/a', { streamId: 'stream_a', lastSeq: 1 });
    slice.setSessionStream('/b', { streamId: 'stream_b', lastSeq: 2 });
    expect(slice.sessionStreams).toEqual({
      '/a': { streamId: 'stream_a', lastSeq: 1 },
      '/b': { streamId: 'stream_b', lastSeq: 2 },
    });

    slice.removeSessionStream('/a');
    expect(slice.sessionStreams).toEqual({
      '/b': { streamId: 'stream_b', lastSeq: 2 },
    });
  });

  it('tracks session locators from loaded sessions', () => {
    const sessions = [{ path: '/s1', sessionId: 'sess_1' }, { path: '/s2' }] as never[];
    slice.setSessions(sessions);
    expect(slice.sessions).toEqual(sessions);
    expect(slice.sessionLocatorsById).toEqual({ sess_1: { path: '/s1' } });
  });

  it('clears current session id when current path is cleared', () => {
    slice.setCurrentSessionRef({ sessionId: 'sess_1', path: '/s1' });
    expect(slice.currentSessionPath).toBe('/s1');
    expect(slice.currentSessionId).toBe('sess_1');
    slice.setCurrentSessionPath(null);
    expect(slice.currentSessionPath).toBeNull();
    expect(slice.currentSessionId).toBeNull();
  });

  it('known locator session-owned maps use sessionId as storage key', () => {
    const todo = { content: 'write spec', status: 'pending' } as never;
    const drift = { version: 1, fingerprint: 'new', frozenFingerprint: 'old', hasDrift: true } as never;
    const confirmation = {
      type: 'session_confirmation',
      confirmId: 'confirm_1',
      kind: 'tool',
      surface: 'input',
      status: 'pending',
      title: 'Confirm',
    } as never;

    slice.setSessions([{ path: '/s1', sessionId: 'sess_1' }] as never[]);
    slice.setCurrentSessionRef({ sessionId: 'sess_1', path: '/s1' });

    slice.setSessionStream('/s1', { streamId: 'stream_1', lastSeq: 2 });
    slice.setSessionTodosForPath('/s1', [todo]);
    slice.bumpTodosLiveVersion('/s1');
    slice.setSessionCapabilityDrift('/s1', drift);
    slice.setSessionCapabilityRefreshing('/s1', true);
    slice.setPendingSessionConfirmation('/s1', confirmation);

    expect(slice.sessionStreams).toEqual({ sess_1: { streamId: 'stream_1', lastSeq: 2 } });
    expect(slice.todosBySession).toEqual({ sess_1: [todo] });
    expect(slice.sessionTodos).toEqual([todo]);
    expect(slice.todosLiveVersionBySession).toEqual({ sess_1: 1 });
    expect(slice.capabilityDriftBySession).toEqual({ sess_1: drift });
    expect(slice.capabilityRefreshingSessions).toEqual(['sess_1']);
    expect(slice.pendingSessionConfirmationsByPath).toEqual({ sess_1: confirmation });

    slice.removeSessionStream('/s1');
    slice.setSessionCapabilityDrift('/s1', null);
    slice.setSessionCapabilityRefreshing('/s1', false);
    slice.resolvePendingSessionConfirmation('confirm_1');

    expect(slice.sessionStreams).toEqual({});
    expect(slice.capabilityDriftBySession).toEqual({});
    expect(slice.capabilityRefreshingSessions).toEqual([]);
    expect(slice.pendingSessionConfirmationsByPath).toEqual({});
  });
});
