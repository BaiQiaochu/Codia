import { describe, expect, it, vi } from 'vitest';
import { createModelSlice, normalizeThinkingLevel } from '../../stores/model-slice';

describe('model slice thinking level', () => {
  it('normalizes legacy auto to medium and defaults new sessions to medium', () => {
    expect(normalizeThinkingLevel('auto')).toBe('medium');
    expect(normalizeThinkingLevel('high')).toBe('high');

    const set = vi.fn();
    const slice = createModelSlice(set);
    expect(slice.thinkingLevel).toBe('medium');

    slice.setThinkingLevel('auto');
    expect(set).toHaveBeenCalledWith({ thinkingLevel: 'medium' });
  });
});
