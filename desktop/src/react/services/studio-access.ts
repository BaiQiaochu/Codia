interface TrustCheckedConnection {
  connectionId: string;
  kind: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud';
  trustState: 'local' | 'lan' | 'tunnel' | 'cloud';
  credentialKind: 'none' | 'loopback_token' | 'device_credential' | 'user_session';
}

export function validateStudioConnectionTrust(connection: TrustCheckedConnection): void {
  if (!connection.connectionId) {
    throw new Error('server connection requires connectionId');
  }
  if (connection.kind === 'local') {
    if (connection.trustState !== 'local') {
      throw new Error('local connection must use local trust');
    }
    if (connection.credentialKind !== 'loopback_token') {
      throw new Error('local connection must use loopback_token');
    }
    return;
  }
  if (connection.kind === 'lan') {
    if (connection.trustState !== 'lan') {
      throw new Error('lan connection must use lan trust');
    }
    if (connection.credentialKind === 'loopback_token') {
      throw new Error('lan connection must not use loopback_token');
    }
    return;
  }
  if (connection.kind === 'custom_remote' && connection.trustState !== 'tunnel') {
    throw new Error('custom_remote connection must use tunnel trust');
  }
  if ((connection.kind === 'relay' || connection.kind === 'cloud') && connection.credentialKind === 'loopback_token') {
    throw new Error(`${connection.kind} connection must not use loopback_token`);
  }
}
