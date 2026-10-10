import type { PlatformApi } from '../types';

const noopUnsubscribe = () => {};
const OPEN_SETTINGS_EVENT = 'codia-mobile-open-settings';

export function installMobilePlatform(): void {
  if (typeof window === 'undefined') return;
  document.documentElement.setAttribute('data-platform', 'web');
  if (window.platform) return;

  const api: Partial<PlatformApi> = {
    getServerPort: async () => window.location.port || '',
    getServerToken: async () => '',
    openSettings: (tab?: string) => {
      window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { tab } }));
    },
    onOpenSettingsModal: (callback: (tab?: string) => void) => {
      const listener = (event: Event) => {
        callback((event as CustomEvent<{ tab?: string }>).detail?.tab);
      };
      window.addEventListener(OPEN_SETTINGS_EVENT, listener);
      return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
    },
    openBrowserViewer: () => {},
    selectFolder: async () => null,
    selectFiles: async () => [],
    selectSkill: async () => null,
    readFile: async () => null,
    writeFile: async () => false,
    writeFileBinary: async () => false,
    copyFile: async () => false,
    readFileSnapshot: async () => null,
    writeFileIfUnchanged: async () => ({ ok: false }),
    watchFile: async () => false,
    unwatchFile: async () => false,
    onFileChanged: () => {},
    watchWorkspace: async () => false,
    unwatchWorkspace: async () => false,
    onWorkspaceChanged: () => noopUnsubscribe,
    readFileBase64: async () => null,
    getFileUrl: (value: string) => browserSafeUrl(value),
    readDocxHtml: async () => null,
    readXlsxHtml: async () => null,
    spawnViewer: async () => null,
    onViewerClosed: () => noopUnsubscribe,
    openFolder: async () => ({ success: false, code: 'unsupported', message: '移动端不支持打开本机文件夹' }),
    openFile: async (value: string) => {
      const url = browserSafeUrl(value);
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return { success: true, path: value };
      }
      return { success: false, code: 'unsupported', message: '移动端不支持打开本机文件' };
    },
    openExternal: (url: string) => window.open(url, '_blank', 'noopener,noreferrer'),
    showInFinder: async () => ({ success: false, code: 'unsupported', message: '移动端不支持在文件管理器中定位' }),
    trashItem: async () => false,
    settingsChanged: () => {},
    syncWindowTheme: () => {},
    onSettingsChanged: () => noopUnsubscribe,
    onSwitchTab: () => noopUnsubscribe,
    onServerRestarted: () => noopUnsubscribe,
    getFilePath: () => null,
    appReady: () => {},
    getPlatform: async () => 'web',
    updateBrowserViewer: () => {},
    onBrowserUpdate: () => noopUnsubscribe,
    closeBrowserViewer: () => {},
    closeBrowser: () => {},
    browserGoBack: () => {},
    browserGoForward: () => {},
    browserReload: () => {},
    showNotification: () => {},
    getAppVersion: async () => '',
  };

  window.platform = api as PlatformApi;
}

function browserSafeUrl(value: string): string {
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  if (value.startsWith('/api/')) return value;
  return '';
}
