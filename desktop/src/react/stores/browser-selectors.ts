import { useStore } from './index';

const DEFAULT_BROWSER_STATE = {
  running: false,
  url: null as string | null,
  thumbnail: null as string | null,
};

/** Resolve the browser state scoped to a session without coupling the slice to the store. */
export function useBrowserState(sessionPath?: string | null) {
  return useStore((state) => {
    const key = sessionPath ?? state.currentSessionPath;
    if (!key) return DEFAULT_BROWSER_STATE;
    return state.browserBySession[key] || DEFAULT_BROWSER_STATE;
  });
}

export function useAnyBrowserRunning() {
  return useStore((state) => Object.values(state.browserBySession).some(browser => browser.running));
}
