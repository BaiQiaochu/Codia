export type StudioConnectionKind = 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud';
export type ServerTrustState = 'local' | 'lan' | 'tunnel' | 'cloud';
export type ConnectionCredentialKind = 'none' | 'loopback_token' | 'device_credential' | 'user_session';
export type OfficialServiceKind = 'relay' | 'cloud_studio' | 'inference' | 'billing';

export type StudioConnectionTransport =
  | 'loopback'
  | 'trusted_lan'
  | 'user_managed_tunnel'
  | 'official_relay'
  | 'official_cloud';

export type StudioAccessActorKind =
  | 'anonymous'
  | 'local_user'
  | 'device'
  | 'account_user'
  | 'platform_account';

export type StudioAccessDataOwner = 'user_server' | 'gsap_cloud_studio';

export type StudioAccessCapability =
  | 'chat'
  | 'resources.read'
  | 'resources.write'
  | 'files.read'
  | 'files.write'
  | 'files.openLocal'
  | 'tools.run'
  | 'plugins.use'
  | 'settings.read'
  | 'settings.write';

export interface StudioConnectionProfile {
  kind: StudioConnectionKind;
  transport: StudioConnectionTransport;
  credentialKinds: ConnectionCredentialKind[];
  trustState: ServerTrustState;
  remoteReachable: boolean;
  requiresDevicePairing: boolean;
  requiresPlatformAccount: boolean;
  dataOwner: StudioAccessDataOwner;
  officialServiceKind: OfficialServiceKind | null;
}

export interface StudioAccessConnection {
  connectionId: string;
  kind: StudioConnectionKind;
  serverId: string;
  userId?: string;
  studioId: string;
  baseUrl: string;
  wsUrl: string;
  token: string | null;
  authState: string;
  trustState: ServerTrustState;
  credentialKind: ConnectionCredentialKind;
  platformAccountId?: string | null;
  officialServiceKind?: OfficialServiceKind | null;
  capabilities: string[];
}

export interface StudioAccessGrant {
  grantId: string;
  connectionId: string;
  actorKind: StudioAccessActorKind;
  scope: {
    serverId: string;
    userId: string | null;
    studioId: string;
  };
  transport: StudioConnectionTransport;
  dataOwner: StudioAccessDataOwner;
  localOnly: boolean;
  capabilities: StudioAccessCapability[];
}

export const STUDIO_ACCESS_CAPABILITIES: readonly StudioAccessCapability[];
export function getStudioConnectionProfile(kind: StudioConnectionKind): StudioConnectionProfile;
export function validateStudioConnectionTrust(connection: StudioAccessConnection): void;
export function deriveStudioAccessGrant(connection: StudioAccessConnection): StudioAccessGrant;
