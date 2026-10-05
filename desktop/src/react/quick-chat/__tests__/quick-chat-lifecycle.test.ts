import { describe, expect, it } from 'vitest';
import { shouldResetQuickChatSessionAfterIdle } from '../quick-chat-lifecycle';

describe('quick chat lifecycle', () => {
  it('keeps the current detached session within the reuse timeout', () => {
    expect(shouldResetQuickChatSessionAfterIdle({
      lastHiddenAt: 1_000,
      now: 1_000 + 9 * 60 * 1000,
      reuseTimeoutMinutes: 10,
      isStreaming: false,
    })).toBe(false);
  });

  it('starts a fresh detached session after the reuse timeout', () => {
    expect(shouldResetQuickChatSessionAfterIdle({
      lastHiddenAt: 1_000,
      now: 1_000 + 10 * 60 * 1000,
      reuseTimeoutMinutes: 10,
      isStreaming: false,
    })).toBe(true);
  });

  it('does not reset an active streaming session', () => {
    expect(shouldResetQuickChatSessionAfterIdle({
      lastHiddenAt: 1_000,
      now: 1_000 + 30 * 60 * 1000,
      reuseTimeoutMinutes: 10,
      isStreaming: true,
    })).toBe(false);
  });
});
