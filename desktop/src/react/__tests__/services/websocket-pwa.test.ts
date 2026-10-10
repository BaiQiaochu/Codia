import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = {
  serverPort: '3210',
  serverToken: null,
  currentSessionPath: null,
  streamingSessions: [],
};

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => storeState,
    setState: vi.fn(),
  },
}));

vi.mock('../../services/ws-message-handler', () => ({
  handleServerMessage: vi.fn(),
  applyStreamingStatus: vi.fn(),
}));

vi.mock('../../services/stream-resume', () => ({
  requestStreamResume: vi.fn(),
  injectHandlers: vi.fn(),
  injectWebSocketGetter: vi.fn(),
}));

vi.mock('../../utils/ui-helpers', () => ({
  setStatus: vi.fn(),
}));

describe('websocket PWA auth', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('appends the stored PWA token to the same-origin websocket url', async () => {
    const sockets: string[] = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
      onopen = null;
      onclose = null;
      onmessage = null;
      onerror = null;
      constructor(url: string) {
        sockets.push(url);
      }
      close() {}
      send() {}
    }

    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('window', {
      __CODIA_PWA__: {},
      location: { protocol: 'https:', host: 'example.com' },
      localStorage: { getItem: () => 'pwa.locked-token' },
    });

    const mod = await import('../../services/websocket');
    mod.connectWebSocket();

    expect(sockets[0]).toBe('wss://example.com/__codia_backend__/ws?token=pwa.locked-token');
  });

  it('uses the PWA bridge websocket URL override when mobile is hosted by the backend itself', async () => {
    const sockets: string[] = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
      onopen = null;
      onclose = null;
      onmessage = null;
      onerror = null;
      constructor(url: string) {
        sockets.push(url);
      }
      close() {}
      send() {}
    }

    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('window', {
      __CODIA_PWA__: {
        wsUrl: (token?: string | null) => token
          ? `wss://example.com/ws?token=${encodeURIComponent(token)}`
          : 'wss://example.com/ws',
      },
      location: { protocol: 'https:', host: 'example.com' },
      localStorage: { getItem: () => 'pwa.locked-token' },
    });

    const mod = await import('../../services/websocket');
    mod.connectWebSocket();

    expect(sockets[0]).toBe('wss://example.com/ws?token=pwa.locked-token');
  });
});
