import registry from '../../shared/theme-registry';

declare global {
  interface Window {
    setTheme: (name: string) => void;
    loadSavedTheme: () => void;
  }
}

export const THEME_LIST = registry.getThemeIds();

/**
 * 包装全局 theme 系统
 * 实际主题切换由 theme.js 处理（CSS variable 驱动），React 不需要重渲染
 */
export function useTheme() {
  return {
    setTheme: window.setTheme,
    loadSavedTheme: window.loadSavedTheme,
    getSavedTheme: () => registry.migrateSavedTheme(
      localStorage.getItem(registry.STORAGE_KEY) || localStorage.getItem(registry.LEGACY_STORAGE_KEY),
    ),
    themes: THEME_LIST,
  };
}
