import { describe, expect, it, vi, afterEach } from 'vitest';

let settingsState = {
  serverPort: '3210',
  serverToken: 'test-token-123',
};

vi.mock('../../settings/store', () => ({
  useSettingsStore: {
    getState: () => settingsState,
  },
}));

import { gsapUrl } from '../../settings/api';

describe('settings gsapUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    settingsState = {
      serverPort: '3210',
      serverToken: 'test-token-123',
    };
  });

  it('only appends the stored PWA token when query auth is explicitly requested', () => {
    settingsState.serverToken = null as unknown as string;
    vi.stubGlobal('window', {
      __GSAP_PWA__: {
        serverUrl: (path: string) => `/__gsap_backend__${path}`,
      },
      localStorage: {
        getItem: (key: string) => (key === 'gsap-token' ? 'pwa.settings-avatar-token' : null),
      },
    });

    const url = gsapUrl('/api/agents/gsap/avatar?t=1');
    expect(url).toBe('/__gsap_backend__/api/agents/gsap/avatar?t=1');

    const authenticatedUrl = gsapUrl('/api/agents/gsap/avatar?t=1', { includeTokenQuery: true });
    expect(authenticatedUrl).toBe('/__gsap_backend__/api/agents/gsap/avatar?t=1&token=pwa.settings-avatar-token');
  });
});
