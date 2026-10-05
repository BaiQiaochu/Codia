import { describe, expect, it } from 'vitest';
import { shouldShowContextRingTokenLabel } from '../../components/input/context-ring-visibility';

describe('context ring token label visibility', () => {
  it('hides the inline token label for normal-size contexts', () => {
    expect(shouldShowContextRingTokenLabel(99_999)).toBe(false);
    expect(shouldShowContextRingTokenLabel(null)).toBe(false);
    expect(shouldShowContextRingTokenLabel(Number.NaN)).toBe(false);
  });

  it('shows the inline token label only for large contexts', () => {
    expect(shouldShowContextRingTokenLabel(100_000)).toBe(true);
    expect(shouldShowContextRingTokenLabel(131_072)).toBe(true);
  });
});
