import { describe, it, expect } from 'vitest';
import { createSelectionSlice, type SelectionSlice } from '../desktop/src/react/stores/selection-slice';

// 用最小可变 state + set 模拟 zustand，单测 slice 行为。
function makeSlice() {
  let state: SelectionSlice;
  const set = (partial: Partial<SelectionSlice> | ((s: SelectionSlice) => Partial<SelectionSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as SelectionSlice;
  };
  state = createSelectionSlice(set);
  return { get: () => state };
}

describe('selection-slice addMessagesToSelection', () => {
  const P = '/s/a.jsonl';

  it('adds ids to an empty selection', () => {
    const s = makeSlice();
    s.get().addMessagesToSelection(P, ['m1', 'm2']);
    expect(s.get().selectedIdsBySession[P]).toEqual(['m1', 'm2']);
  });

  it('unions with existing selection without duplicates', () => {
    const s = makeSlice();
    s.get().setMessageSelection(P, ['m1', 'm2']);
    s.get().addMessagesToSelection(P, ['m2', 'm3']);
    expect(s.get().selectedIdsBySession[P]).toEqual(['m1', 'm2', 'm3']);
  });

  it('ignores empty input (no session key created)', () => {
    const s = makeSlice();
    s.get().addMessagesToSelection(P, []);
    expect(s.get().selectedIdsBySession[P]).toBeUndefined();
  });
});
