import registry from '../../shared/theme-registry';
import { isPaperTextureEnabled } from '../../shared/appearance-preferences';
import { codiaFetch } from '../hooks/use-codia-fetch';

export interface SyncedAppearancePreferences {
  theme?: string;
  paperTexture?: boolean;
  leavesOverlay?: boolean;
}

export function readBrowserAppearancePreferences(): Required<SyncedAppearancePreferences> {
  return {
    theme: registry.migrateSavedTheme(window.localStorage.getItem(registry.STORAGE_KEY)),
    paperTexture: isPaperTextureEnabled(window.localStorage),
    leavesOverlay: window.localStorage.getItem('codia-leaves-overlay') === '1',
  };
}

export function applySyncedAppearancePreferences(preferences?: SyncedAppearancePreferences | null): void {
  if (!preferences || typeof preferences !== 'object') return;
  if (preferences.theme) window.setTheme?.(preferences.theme);
  if (typeof preferences.paperTexture === 'boolean') window.setPaperTexture?.(preferences.paperTexture);
  if (typeof preferences.leavesOverlay === 'boolean') {
    window.localStorage.setItem('codia-leaves-overlay', preferences.leavesOverlay ? '1' : '0');
    window.dispatchEvent(new CustomEvent('codia-settings', {
      detail: { type: 'leaves-overlay-changed', enabled: preferences.leavesOverlay },
    }));
  }
}

export async function persistAppearancePreferences(
  preferences: SyncedAppearancePreferences = readBrowserAppearancePreferences(),
): Promise<void> {
  await codiaFetch('/api/preferences/appearance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences),
  });
}
