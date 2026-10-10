import { describe, expect, it } from 'vitest';
import { yuanFallbackAvatar } from '../../utils/yuan-avatar';

describe('yuanFallbackAvatar', () => {
  it('maps built-in Yuan types to their default avatars', () => {
    expect(yuanFallbackAvatar('codia')).toBe('assets/character-cards/codia-default-avatar.png');
    expect(yuanFallbackAvatar('hermes')).toBe('assets/character-cards/codia-default-avatar.png');
    expect(yuanFallbackAvatar('butter')).toBe('assets/character-cards/codia-default-avatar.png');
    expect(yuanFallbackAvatar('ming')).toBe('assets/character-cards/codia-default-avatar.png');
  });

  it('keeps kong on its dedicated avatar and falls back safely for unknown keys', () => {
    expect(yuanFallbackAvatar('kong')).toBe('assets/character-cards/codia-default-avatar.png');
    expect(yuanFallbackAvatar('unknown-yuan')).toBe('assets/character-cards/codia-default-avatar.png');
    expect(yuanFallbackAvatar()).toBe('assets/character-cards/codia-default-avatar.png');
  });
});
