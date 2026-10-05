import { describe, expect, it, vi } from 'vitest';

import {
  appendConnectionAuth,
  buildConnectionUrl,
  buildConnectionWsUrl,
  connectDeviceServerConnection,
  createDeviceServerConnection,
  createLocalServerConnection,
  hasServerConnection,
  isLocalOwnerConnection,
  persistServerConnectionSelection,
  readPersistedServerConnectionState,
  refreshLocalServerConnectionState,
  resolveServerConnection,
  upsertServerConnection,
  writePersistedServerConnectionState,
} from '../../services/server-connection';

describe('server connection helpers', () => {
  it('creates the neutral local server connection from port and token', () => {
    const local = createLocalServerConnection({
      serverPort: 3210,
      serverToken: 'test-token-123',
    });

    expect(local).toMatchObject({
      connectionId: 'local',
      kind: 'local',
      label: '本机服务',
      baseUrl: 'http://127.0.0.1:3210',
      wsUrl: 'ws://127.0.0.1:3210',
      token: 'test-token-123',
      credentialKind: 'loopback_token',
      trustState: 'local',
      capabilities: ['chat', 'resources', 'files', 'tools'],
    });
    expect(isLocalOwnerConnection(local)).toBe(true);
  });

  it('prefers the active connection registry over legacy port and token fields', () => {
    const active = createLocalServerConnection({
      serverPort: 4242,
      serverToken: 'active-token',
    })!;

    expect(hasServerConnection({ activeServerConnection: active })).toBe(true);
    expect(resolveServerConnection({
      activeServerConnectionId: 'local',
      serverConnections: { local: active },
      serverPort: 3210,
      serverToken: 'legacy-token',
    })).toBe(active);
  });

  it('creates a LAN device connection without leaking its credential into URLs', () => {
    const remote = createDeviceServerConnection({
      baseUrl: '192.168.31.75:14500/mobile/',
      credential: 'gsap_dev_remote_secret',
      identity: {
        connectionKind: 'lan',
        serverId: 'server_lan',
        serverNodeId: 'node_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Server',
        trustState: 'lan',
        authState: 'paired',
        credentialKind: 'device_credential',
        capabilities: ['chat', 'resources', 'files'],
      },
    });

    expect(remote).toMatchObject({
      connectionId: 'lan:node_lan:studio_lan',
      baseUrl: 'http://192.168.31.75:14500',
      wsUrl: 'ws://192.168.31.75:14500',
      token: 'gsap_dev_remote_secret',
      credentialKind: 'device_credential',
    });
    expect(buildConnectionUrl(remote, '/api/resources/res_1/content', { includeTokenQuery: true }))
      .toBe('http://192.168.31.75:14500/api/resources/res_1/content');
    expect(buildConnectionWsUrl(remote, '/ws')).toBe('ws://192.168.31.75:14500/ws');
  });

  it('logs in before creating a manual LAN connection', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'http://192.168.31.75:14500/api/web-auth/login') {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url === 'http://192.168.31.75:14500/api/server/identity') {
        return {
          ok: true,
          json: async () => ({
            connectionKind: 'lan',
            serverId: 'server_lan',
            serverNodeId: 'node_lan',
            userId: 'user_lan',
            studioId: 'studio_lan',
            label: 'LAN Server',
            trustState: 'lan',
            authState: 'paired',
            credentialKind: 'device_credential',
            capabilities: ['chat', 'resources', 'files'],
          }),
        } as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const connection = await connectDeviceServerConnection({
      baseUrl: 'http://192.168.31.75:14500/',
      credential: 'gsap_dev_remote_secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://192.168.31.75:14500/api/web-auth/login', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ credential: 'gsap_dev_remote_secret' }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://192.168.31.75:14500/api/server/identity', expect.objectContaining({
      headers: { Authorization: 'Bearer gsap_dev_remote_secret' },
      credentials: 'include',
    }));
    expect(connection.connectionId).toBe('lan:node_lan:studio_lan');
    expect(isLocalOwnerConnection(connection)).toBe(false);
  });

  it('persists only non-local server connections under the G-SAP key', () => {
    const storageData = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageData.get(key) ?? null,
      setItem: (key: string, value: string) => { storageData.set(key, value); },
      removeItem: (key: string) => { storageData.delete(key); },
    };
    const local = createLocalServerConnection({ serverPort: 3210, serverToken: 'local-token' })!;
    const remote = createDeviceServerConnection({
      baseUrl: 'http://192.168.31.75:14500',
      credential: 'gsap_dev_remote_secret',
      identity: {
        connectionKind: 'lan',
        serverId: 'server_lan',
        serverNodeId: 'node_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Server',
        trustState: 'lan',
        authState: 'paired',
        credentialKind: 'device_credential',
        capabilities: ['chat'],
      },
    });

    writePersistedServerConnectionState({
      serverConnections: { local, [remote.connectionId]: remote },
      activeServerConnectionId: remote.connectionId,
    }, storage);

    expect(storageData.has('gsap-server-connections-v1')).toBe(true);
    const loaded = readPersistedServerConnectionState(storage);
    expect(Object.keys(loaded.serverConnections)).toEqual([remote.connectionId]);
    expect(loaded.activeServerConnectionId).toBe(remote.connectionId);
    expect(persistServerConnectionSelection(remote, storage).activeServerConnectionId).toBe(remote.connectionId);
  });

  it('refreshes local transport without stealing the active remote connection', () => {
    const local = createLocalServerConnection({ serverPort: 3210, serverToken: 'old-token' })!;
    const remote = createDeviceServerConnection({
      baseUrl: 'http://192.168.31.75:14500',
      credential: 'gsap_dev_remote_secret',
      identity: {
        connectionKind: 'lan',
        serverId: 'server_lan',
        serverNodeId: 'node_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Server',
        trustState: 'lan',
        authState: 'paired',
        credentialKind: 'device_credential',
        capabilities: ['chat'],
      },
    });

    const next = refreshLocalServerConnectionState({
      serverConnections: { local, [remote.connectionId]: remote },
      activeServerConnectionId: remote.connectionId,
      activeServerConnection: remote,
      serverPort: 9988,
      serverToken: 'new-token',
    });

    expect(next.activeServerConnectionId).toBe(remote.connectionId);
    expect(next.activeServerConnection).toBe(next.serverConnections[remote.connectionId]);
    expect(next.serverConnections.local).toMatchObject({
      baseUrl: 'http://127.0.0.1:9988',
      token: 'new-token',
    });
  });

  it('rejects LAN entries that try to reuse loopback tokens', () => {
    const local = createLocalServerConnection({ serverPort: 3210, serverToken: 'local-token' })!;
    const invalidRemote = {
      ...local,
      connectionId: 'lan:bad',
      kind: 'lan' as const,
      label: 'Bad LAN Server',
      baseUrl: 'http://192.168.1.20:14500',
      wsUrl: 'ws://192.168.1.20:14500',
      trustState: 'lan' as const,
      credentialKind: 'loopback_token' as const,
    };

    expect(() => upsertServerConnection({ local }, invalidRemote))
      .toThrow('lan connection must not use loopback_token');
  });

  it('adds Authorization without putting local loopback tokens into fetch URLs', () => {
    const local = createLocalServerConnection({ serverPort: '3210', serverToken: 'test-token-123' })!;

    expect(buildConnectionUrl(local, '/api/health')).toBe('http://127.0.0.1:3210/api/health');
    expect(buildConnectionWsUrl(local, '/ws')).toBe('ws://127.0.0.1:3210/ws?token=test-token-123');
    expect(appendConnectionAuth(local, { 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token-123',
    });
  });
});
