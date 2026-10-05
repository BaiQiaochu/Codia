import { describe, expect, it } from 'vitest';
import { createSelectionSlice, type SelectionSlice } from '../../stores/selection-slice';

function makeSlice(extras: Record<string, unknown> = {}): SelectionSlice {
  let state: SelectionSlice & Record<string, unknown>;
  const set = (partial: Partial<SelectionSlice> | ((s: SelectionSlice) => Partial<SelectionSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = { ...createSelectionSlice(set), ...extras };
  return new Proxy({} as SelectionSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
    set: (_, key: string, value: unknown) => {
      state = { ...state, [key]: value };
      return true;
    },
  });
}

describe('selection-slice', () => {
  it('recovers when selectedIdsBySession has a non-array bucket', () => {
    const slice = makeSlice() as SelectionSlice & { selectedIdsBySession: Record<string, unknown> };
    slice.selectedIdsBySession = { '/sessions/a.jsonl': undefined };

    expect(() => slice.toggleMessageSelection('/sessions/a.jsonl', 'm-1')).not.toThrow();
    expect(slice.selectedIdsBySession['/sessions/a.jsonl']).toEqual(['m-1']);

    slice.selectedIdsBySession['/sessions/a.jsonl'] = 'm-1' as unknown as string[];
    expect(() => slice.toggleMessageSelection('/sessions/a.jsonl', 'm-2')).not.toThrow();
    expect(slice.selectedIdsBySession['/sessions/a.jsonl']).toEqual(['m-2']);
  });

  it('stores selected message ids under stable session id when a locator is known', () => {
    const slice = makeSlice({
      selectedIdsBySession: {
        '/sessions/a.jsonl': ['stale'],
      },
      sessions: [{ path: '/sessions/a.jsonl', sessionId: 'sess-select' }],
      sessionLocatorsById: {
        'sess-select': { path: '/sessions/a.jsonl' },
      },
    }) as SelectionSlice & {
      sessions?: Array<{ path?: string; sessionId?: string }>;
      sessionLocatorsById?: Record<string, { path?: string }>;
    };

    slice.setMessageSelection('/sessions/a.jsonl', ['m-1', 'm-1']);
    expect(slice.selectedIdsBySession['sess-select']).toEqual(['m-1']);
    expect(slice.selectedIdsBySession['/sessions/a.jsonl']).toBeUndefined();

    slice.addMessagesToSelection('/sessions/a.jsonl', ['m-2']);
    expect(slice.selectedIdsBySession['sess-select']).toEqual(['m-1', 'm-2']);

    slice.toggleMessageSelection('/sessions/a.jsonl', 'm-1');
    expect(slice.selectedIdsBySession['sess-select']).toEqual(['m-2']);

    slice.clearSelection('/sessions/a.jsonl');
    expect(slice.selectedIdsBySession['sess-select']).toBeUndefined();
    expect(slice.selectedIdsBySession['/sessions/a.jsonl']).toBeUndefined();
  });
});
