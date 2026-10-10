import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock useStore before importing codiaFetch
vi.mock('../../stores', () => ({
  useStore: {
    getState: () => storeState,
  },
}));

import { codiaUrl, codiaFetch } from '../../hooks/use-codia-fetch';

interface TestStoreState {
  serverPort: string;
  serverToken: string | null;
  serverConnections: Record<string, unknown>;
  activeServerConnectionId: string | null;
  activeServerConnection: unknown | null;
}

let storeState: TestStoreState = {
  serverPort: '3210',
  serverToken: 'test-token-123',
  serverConnections: {},
  activeServerConnectionId: null,
  activeServerConnection: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  storeState = {
    serverPort: '3210',
    serverToken: 'test-token-123',
    serverConnections: {},
    activeServerConnectionId: null,
    activeServerConnection: null,
  };
});

function setPwaBridge(serverUrl: (path: string) => string) {
  vi.stubGlobal('window', { __CODIA_PWA__: { serverUrl } });
}

describe('codiaUrl', () => {
  it('does not append the desktop token to API URLs by default', () => {
    const url = codiaUrl('/api/health');
    expect(url).toBe('http://127.0.0.1:3210/api/health');
  });

  it('only appends the desktop token when query auth is explicitly requested', () => {
    const url = codiaUrl('/api/sessions?limit=10');
    expect(url).toBe('http://127.0.0.1:3210/api/sessions?limit=10');

    const authenticatedUrl = codiaUrl('/api/sessions?limit=10', { includeTokenQuery: true });
    expect(authenticatedUrl).toBe('http://127.0.0.1:3210/api/sessions?limit=10&token=test-token-123');
  });

  it('only appends the stored PWA token when query auth is explicitly requested', () => {
    storeState.serverToken = null as unknown as string;
    vi.stubGlobal('window', {
      __CODIA_PWA__: {
        serverUrl: (path: string) => `/__codia_backend__${path}`,
      },
      localStorage: {
        getItem: (key: string) => (key === 'codia-token' ? 'pwa.avatar-token' : null),
      },
    });

    const url = codiaUrl('/api/agents/codia/avatar?t=1');
    expect(url).toBe('/__codia_backend__/api/agents/codia/avatar?t=1');

    const authenticatedUrl = codiaUrl('/api/agents/codia/avatar?t=1', { includeTokenQuery: true });

    expect(authenticatedUrl).toBe('/__codia_backend__/api/agents/codia/avatar?t=1&token=pwa.avatar-token');
  });
});

describe('codiaFetch', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    storeState = {
      serverPort: '3210',
      serverToken: 'test-token-123',
      serverConnections: {},
      activeServerConnectionId: null,
      activeServerConnection: null,
    };
    vi.stubGlobal('fetch', mockFetch);
  });

  it('sends Authorization header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });

    await codiaFetch('/api/health');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3210/api/health');
    expect(opts.headers.Authorization).toBe('Bearer test-token-123');
  });

  it('throws on non-2xx responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(codiaFetch('/api/missing')).rejects.toThrow('404');
  });

  it('non-2xx errors include JSON response body messages', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'vision model must support image input' }),
    });

    await expect(codiaFetch('/api/preferences/models')).rejects.toThrow(
      '400 vision model must support image input',
    );
  });

  it('preserves method and caller headers', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await codiaFetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const call = mockFetch.mock.calls[0];
    const url = call[0];
    const opts = call[1];
    expect(url).toBe('http://127.0.0.1:3210/api/test');
    expect(opts.headers).toHaveProperty('Authorization', 'Bearer test-token-123');
  });

  it('attaches an AbortSignal to requests', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await codiaFetch('/api/test');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('routes API requests through the PWA same-origin backend proxy', async () => {
    setPwaBridge((path: string) => `/__codia_backend__${path}`);
    mockFetch.mockResolvedValueOnce({ ok: true });

    await codiaFetch('/api/health');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/__codia_backend__/api/health');
    expect(opts.headers.Authorization).toBe('Bearer test-token-123');
  });

  it('uses a stored PWA token when desktop serverToken is unavailable', async () => {
    storeState.serverToken = null as unknown as string;
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => (key === 'codia-token' ? 'pwa.test-token' : null),
      },
    });
    mockFetch.mockResolvedValueOnce({ ok: true });

    await codiaFetch('/api/health');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer pwa.test-token');
  });

  it('routes through the active LAN server connection when one is selected', async () => {
    storeState = {
      serverPort: '3210',
      serverToken: 'local-token',
      serverConnections: {},
      activeServerConnectionId: 'lan:remote',
      activeServerConnection: {
        connectionId: 'lan:remote',
        kind: 'lan',
        serverId: 'remote',
        studioId: 'studio_remote',
        label: 'Remote Server',
        baseUrl: 'http://192.168.31.75:14500',
        wsUrl: 'ws://192.168.31.75:14500',
        token: 'codia_dev_remote_secret',
        authState: 'paired',
        trustState: 'lan',
        credentialKind: 'device_credential',
        platformAccountId: null,
        officialServiceKind: null,
        capabilities: ['chat'],
      },
    };
    mockFetch.mockResolvedValueOnce({ ok: true });

    await codiaFetch('/api/health');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://192.168.31.75:14500/api/health');
    expect(opts.headers.Authorization).toBe('Bearer codia_dev_remote_secret');
    expect(codiaUrl('/api/agents/codia/avatar')).toBe('http://192.168.31.75:14500/api/agents/codia/avatar');
  });
});
