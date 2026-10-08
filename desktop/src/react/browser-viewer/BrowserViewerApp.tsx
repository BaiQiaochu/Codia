import { useEffect, useMemo, useRef, useState, type FormEvent, type WheelEvent } from 'react';
import { initTheme } from '../bootstrap';
import { getDesktopApi } from '../utils/desktop-api';

declare function t(key: string): string;
declare function setTheme(name: string): void;

initTheme();

function getThemeFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const theme = (payload as { theme?: unknown }).theme;
  return typeof theme === 'string' ? theme : null;
}

type BrowserTab = {
  tabId: string;
  title?: string;
  url?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
};

function tr(key: string, fallback: string) {
  try {
    const value = typeof t === 'function' ? t(key) : '';
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}

function tabTitle(tab: BrowserTab) {
  const title = tab.title?.trim();
  if (title) return title;
  if (tab.url) {
    try {
      return new URL(tab.url).hostname || tab.url;
    } catch {
      return tab.url;
    }
  }
  return tr('browser.newTab', 'New Tab');
}

export function BrowserViewerApp() {
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [draftUrl, setDraftUrl] = useState('');
  const tabListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const desktopApi = getDesktopApi();

    desktopApi?.onSettingsChanged?.((type, data) => {
      const theme = type === 'theme-changed' ? getThemeFromPayload(data) : null;
      if (theme) setTheme(theme);
    });

    desktopApi?.onBrowserUpdate?.((data: any) => {
      if (Array.isArray(data.tabs)) setTabs(data.tabs);
      if (data.activeTabId !== undefined) setActiveTabId(data.activeTabId);
      if (data.canGoBack !== undefined) setCanBack(data.canGoBack);
      if (data.canGoForward !== undefined) setCanForward(data.canGoForward);
      if (typeof data.url === 'string') setDraftUrl(data.url);
      if (data.running === false) {
        setCanBack(false);
        setCanForward(false);
        setTabs([]);
        setActiveTabId(null);
        setDraftUrl('');
      }
    });

    window.i18n?.load?.(navigator.language || 'zh');
  }, []);

  const desktopApi = getDesktopApi();
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.tabId === activeTabId) || tabs[0] || null,
    [tabs, activeTabId],
  );

  useEffect(() => {
    if (!activeTab) return;
    if (typeof activeTab.canGoBack === 'boolean') setCanBack(activeTab.canGoBack);
    if (typeof activeTab.canGoForward === 'boolean') setCanForward(activeTab.canGoForward);
  }, [activeTab]);

  useEffect(() => {
    setDraftUrl(activeTab?.url || '');
  }, [activeTab?.url]);

  const handleTabWheel = (event: WheelEvent<HTMLDivElement>) => {
    const el = tabListRef.current;
    if (!el) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY;
    if (!delta) return;
    el.scrollLeft += delta;
    event.preventDefault();
  };

  const handleAddressSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = draftUrl.trim();
    if (!target) return;
    Promise.resolve(desktopApi?.browserNavigateTo?.(target)).catch((err) => {
      console.error('[browser-viewer] navigate failed:', err);
    });
  };

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <button
            type="button"
            className="tb-btn close-btn"
            title={tr('browser.closeBtn', 'Close')}
            onClick={() => desktopApi?.closeBrowserViewer?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
              <path d="M4 4l6 6M10 4l-6 6" />
            </svg>
          </button>

          <button
            type="button"
            className="stop-btn"
            title={tr('browser.emergencyStop', 'Stop')}
            onClick={() => desktopApi?.browserEmergencyStop?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
            </svg>
          </button>

          <div className="nav-sep" />

          <button
            type="button"
            className={`tb-btn${canBack ? '' : ' disabled'}`}
            title={tr('browser.back', 'Back')}
            onClick={() => desktopApi?.browserGoBack?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8.5 2.5L4.5 7l4 4.5" />
            </svg>
          </button>

          <button
            type="button"
            className={`tb-btn${canForward ? '' : ' disabled'}`}
            title={tr('browser.forward', 'Forward')}
            onClick={() => desktopApi?.browserGoForward?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5.5 2.5L9.5 7l-4 4.5" />
            </svg>
          </button>

          <button
            type="button"
            className="tb-btn"
            title={tr('browser.reload', 'Reload')}
            onClick={() => desktopApi?.browserReload?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 7a4 4 0 1 1-4-4" />
              <path d="M11 3v2.5H8.5" />
            </svg>
          </button>
        </div>

        <form className="address-form" onSubmit={handleAddressSubmit}>
          <input
            className="address-input"
            aria-label={tr('browser.address', 'Address')}
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.currentTarget.value)}
            placeholder={tr('browser.addressPlaceholder', 'Search or enter address')}
            spellCheck={false}
          />
        </form>

        <div className="browser-tab-strip">
          <div
            ref={tabListRef}
            className="browser-tab-list"
            onWheel={handleTabWheel}
          >
            {tabs.map((tab) => {
              const isActive = tab.tabId === (activeTab?.tabId || activeTabId);
              return (
                <button
                  type="button"
                  key={tab.tabId}
                  className={`browser-tab${isActive ? ' active' : ''}`}
                  title={tabTitle(tab)}
                  onClick={() => desktopApi?.browserSwitchTab?.(tab.tabId)}
                  onDoubleClick={() => desktopApi?.browserCloseTab?.(tab.tabId)}
                >
                  <span className="browser-tab-title">{tabTitle(tab)}</span>
                  <span
                    className="browser-tab-close"
                    title={tr('browser.closeTab', 'Close tab')}
                    onClick={(event) => {
                      event.stopPropagation();
                      desktopApi?.browserCloseTab?.(tab.tabId);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                      <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" />
                    </svg>
                  </span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="tb-btn new-tab-btn"
            title={tr('browser.newTab', 'New Tab')}
            onClick={() => desktopApi?.browserNewTab?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M7 3v8M3 7h8" />
            </svg>
          </button>
        </div>

        <div className="toolbar-drag" />
      </div>

      <div className="card-frame" />
    </>
  );
}
