import { normalizeYuanKey } from './yuan';
import { getYuanVisual } from '../../../../shared/yuan-visuals.ts';

export const DEFAULT_ASSISTANT_AVATAR = 'character-cards/gsap-default-avatar.png';

export const YUAN_FALLBACK_AVATARS: Record<string, string> = {
  gsap: DEFAULT_ASSISTANT_AVATAR,
  hermes: DEFAULT_ASSISTANT_AVATAR,
  butter: DEFAULT_ASSISTANT_AVATAR,
  ming: DEFAULT_ASSISTANT_AVATAR,
  kong: DEFAULT_ASSISTANT_AVATAR,
};

export function yuanFallbackAvatar(yuan?: string): string {
  const key = normalizeYuanKey(yuan);
  return `assets/${YUAN_FALLBACK_AVATARS[key] || getYuanVisual(key).avatar || DEFAULT_ASSISTANT_AVATAR}`;
}
