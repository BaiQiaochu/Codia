import { describe, expect, it } from 'vitest';
import { createContextSlice, type ContextSlice } from '../../stores/context-slice';

function makeSlice(): ContextSlice {
  let state: ContextSlice;
  const set = (partial: Partial<ContextSlice> | ((s: ContextSlice) => Partial<ContextSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createContextSlice(set);
  return new Proxy({} as ContextSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
    set: (_, key: string, value: unknown) => {
      state = { ...state, [key]: value };
      return true;
    },
  });
}

describe('context-slice', () => {
  it('状态数组异常缺失时 add/remove compaction 不崩溃', () => {
    const slice = makeSlice();
    (slice as unknown as { compactingSessions: unknown }).compactingSessions = undefined;

    slice.addCompactingSession('/s1');
    expect(slice.compactingSessions).toEqual(['/s1']);

    (slice as unknown as { compactingSessions: unknown }).compactingSessions = undefined;
    slice.removeCompactingSession('/s1');
    expect(slice.compactingSessions).toEqual([]);
  });
});
