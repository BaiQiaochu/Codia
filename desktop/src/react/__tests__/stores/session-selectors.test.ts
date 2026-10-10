import { describe, expect, it } from 'vitest';
import {
  EMPTY_ARRAY,
  EMPTY_SELECTED_IDS,
  EMPTY_STRING_ARRAY,
  selectIsStreamingSession,
  selectSelectedIdsBySession,
  toArray,
  toStringArray,
} from '../../stores/session-selectors';

describe('session-selectors', () => {
  it('returns a stable empty selection reference for missing session keys', () => {
    const state = {
      selectedIdsBySession: {},
      streamingSessions: [],
    };

    expect(selectSelectedIdsBySession(state, '/missing')).toBe(EMPTY_SELECTED_IDS);
    expect(selectSelectedIdsBySession(state, '')).toBe(EMPTY_SELECTED_IDS);
  });

  it('returns the stored selection array when a session key exists', () => {
    const selected = ['m-1', 'm-2'];
    const state = {
      selectedIdsBySession: {
        '/panel': selected,
        '/current': ['other'],
      },
      streamingSessions: [],
    };

    expect(selectSelectedIdsBySession(state, '/panel')).toBe(selected);
  });

  it('returns selected ids stored under a stable session id locator', () => {
    const selected = ['m-1', 'm-2'];
    const state = {
      selectedIdsBySession: {
        'sess-panel': selected,
        '/panel': ['stale'],
      },
      streamingSessions: ['sess-panel'],
      sessions: [{ path: '/panel', sessionId: 'sess-panel' }],
      sessionLocatorsById: {
        'sess-panel': { path: '/panel' },
      },
    };

    expect(selectSelectedIdsBySession(state, '/panel')).toBe(selected);
    expect(selectIsStreamingSession(state, '/panel')).toBe(true);
  });

  it('returns a stable empty selection reference for malformed buckets', () => {
    const state = {
      selectedIdsBySession: {
        '/panel': undefined,
        '/bad': 'm-1',
      },
      streamingSessions: [],
    } as never;

    expect(selectSelectedIdsBySession(state, '/panel')).toBe(EMPTY_SELECTED_IDS);
    expect(selectSelectedIdsBySession(state, '/bad')).toBe(EMPTY_SELECTED_IDS);
  });

  it('checks streaming state only against an explicit session path', () => {
    const state = {
      selectedIdsBySession: {},
      streamingSessions: ['/panel'],
    };

    expect(selectIsStreamingSession(state, '/panel')).toBe(true);
    expect(selectIsStreamingSession(state, '/current')).toBe(false);
    expect(selectIsStreamingSession(state, '')).toBe(false);
  });

  it('does not throw when streamingSessions is missing', () => {
    const state = {
      selectedIdsBySession: {},
      streamingSessions: undefined,
    } as never;

    expect(selectIsStreamingSession(state, '/panel')).toBe(false);
  });

  it('keeps normal string arrays by reference and uses a stable empty fallback', () => {
    const normal = ['/s1', '/s2'];
    expect(toStringArray(normal)).toBe(normal);
    expect(toStringArray(['/s1', 1, null, '/s2'])).toEqual(['/s1', '/s2']);
    expect(toStringArray(null)).toBe(EMPTY_STRING_ARRAY);
    expect(toStringArray(undefined)).toBe(EMPTY_STRING_ARRAY);
  });

  it('keeps normal arrays by reference and uses a stable empty fallback', () => {
    const normal = [{ id: 'a' }];
    expect(toArray(normal)).toBe(normal);
    expect(toArray(null)).toBe(EMPTY_ARRAY);
    expect(toArray(undefined)).toBe(EMPTY_ARRAY);
  });
});
