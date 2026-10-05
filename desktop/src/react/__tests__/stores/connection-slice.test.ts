import { describe, expect, it } from 'vitest';
import { createConnectionSlice, type ConnectionSlice } from '../../stores/connection-slice';

function createHarness() {
  let state: ConnectionSlice;
  const set = (partial: Partial<ConnectionSlice>) => {
    state = { ...state, ...partial };
  };
  const get = () => state;
  state = createConnectionSlice(set, get);
  return {
    get state() {
      return state;
    },
  };
}

describe('connection slice registry', () => {
  it('sets local server connection into the registry and active mirror together', () => {
    const h = createHarness();

    h.state.setLocalServerConnection(3210, 'local-token');

    expect(h.state.activeServerConnectionId).toBe('local');
    expect(h.state.serverConnections.local).toEqual(h.state.activeServerConnection);
    expect(h.state.activeServerConnection).toMatchObject({
      connectionId: 'local',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:3210',
      token: 'local-token',
    });
  });

  it('can select a non-local connection without touching legacy port fields', () => {
    const h = createHarness();
    h.state.setLocalServerConnection(3210, 'local-token');
    const remote = {
      ...h.state.activeServerConnection!,
      connectionId: 'lan:remote',
      kind: 'lan' as const,
      label: 'Remote Server',
      baseUrl: 'http://192.168.31.75:14500',
      wsUrl: 'ws://192.168.31.75:14500',
      token: 'remote-token',
      trustState: 'lan' as const,
      credentialKind: 'device_credential' as const,
    };

    h.state.upsertServerConnection(remote);
    h.state.selectServerConnection('lan:remote');

    expect(h.state.serverPort).toBe('3210');
    expect(h.state.serverToken).toBe('local-token');
    expect(h.state.activeServerConnectionId).toBe('lan:remote');
    expect(h.state.activeServerConnection).toBe(remote);
  });
});
