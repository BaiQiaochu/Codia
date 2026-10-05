import type { PlatformApi } from '../types';

export function getDesktopApi(): PlatformApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.gsap || window.platform;
}
