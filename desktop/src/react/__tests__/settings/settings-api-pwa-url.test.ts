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

import { codiaUrl } from '../../settings/api';

describe('settings codiaUrl', () => {
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
      __CODIA_PWA__: {
        serverUrl: (path: string) => `/__codia_backend__${path}`,
      },
      localStorage: {
        getItem: (key: string) => (key === 'codia-token' ? 'pwa.settings-avatar-token' : null),
      },
    });

    const url = codiaUrl('/api/agents/codia/avatar?t=1');
    expect(url).toBe('/__codia_backend__/api/agents/codia/avatar?t=1');

    const authenticatedUrl = codiaUrl('/api/agents/codia/avatar?t=1', { includeTokenQuery: true });
    expect(authenticatedUrl).toBe('/__codia_backend__/api/agents/codia/avatar?t=1&token=pwa.settings-avatar-token');
  });
});
