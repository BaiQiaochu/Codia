export const STUDIO_ACCESS_CAPABILITIES = Object.freeze([
  "chat",
  "resources.read",
  "resources.write",
  "files.read",
  "files.write",
  "files.openLocal",
  "tools.run",
  "plugins.use",
  "settings.read",
  "settings.write",
]);

const CONNECTION_PROFILES = Object.freeze({
  local: Object.freeze({
    kind: "local",
    transport: "loopback",
    credentialKinds: Object.freeze(["loopback_token"]),
    trustState: "local",
    remoteReachable: false,
    requiresDevicePairing: false,
    requiresPlatformAccount: false,
    dataOwner: "user_server",
    officialServiceKind: null,
  }),
  lan: Object.freeze({
    kind: "lan",
    transport: "trusted_lan",
    credentialKinds: Object.freeze(["device_credential", "user_session"]),
    trustState: "lan",
    remoteReachable: true,
    requiresDevicePairing: true,
    requiresPlatformAccount: false,
    dataOwner: "user_server",
    officialServiceKind: null,
  }),
  custom_remote: Object.freeze({
    kind: "custom_remote",
    transport: "user_managed_tunnel",
    credentialKinds: Object.freeze(["device_credential", "user_session"]),
    trustState: "tunnel",
    remoteReachable: true,
    requiresDevicePairing: true,
    requiresPlatformAccount: false,
    dataOwner: "user_server",
    officialServiceKind: null,
  }),
  relay: Object.freeze({
    kind: "relay",
    transport: "official_relay",
    credentialKinds: Object.freeze(["user_session"]),
    trustState: "tunnel",
    remoteReachable: true,
    requiresDevicePairing: true,
    requiresPlatformAccount: true,
    dataOwner: "user_server",
    officialServiceKind: "relay",
  }),
  cloud: Object.freeze({
    kind: "cloud",
    transport: "official_cloud",
    credentialKinds: Object.freeze(["user_session"]),
    trustState: "cloud",
    remoteReachable: true,
    requiresDevicePairing: false,
    requiresPlatformAccount: true,
    dataOwner: "gsap_cloud_studio",
    officialServiceKind: "cloud_studio",
  }),
});

export function getStudioConnectionProfile(kind) {
  const profile = CONNECTION_PROFILES[kind];
  if (!profile) throw new Error(`unknown StudioConnection kind: ${kind}`);
  return {
    ...profile,
    credentialKinds: [...profile.credentialKinds],
  };
}

export function validateStudioConnectionTrust(connection) {
  const profile = getStudioConnectionProfile(connection.kind);

  if (connection.kind === "local") {
    if (!isLoopbackUrl(connection.baseUrl) || !isLoopbackUrl(connection.wsUrl)) {
      throw new Error("local connection must use loopback baseUrl and wsUrl");
    }
  } else if (connection.credentialKind === "loopback_token") {
    throw new Error(`${connection.kind} connection must not use loopback_token`);
  }

  if (!profile.credentialKinds.includes(connection.credentialKind)) {
    throw new Error(
      `${connection.kind} connection requires credentialKind=${profile.credentialKinds.join("|")}`,
    );
  }

  if (connection.trustState !== profile.trustState) {
    throw new Error(`${connection.kind} connection requires trustState=${profile.trustState}`);
  }

  if ((connection.officialServiceKind ?? null) !== profile.officialServiceKind) {
    const value = profile.officialServiceKind === null ? "null" : profile.officialServiceKind;
    throw new Error(`${connection.kind} connection requires officialServiceKind=${value}`);
  }

  if (profile.requiresPlatformAccount && !connection.platformAccountId) {
    throw new Error(`${connection.kind} connection requires platformAccountId`);
  }
}

export function deriveStudioAccessGrant(connection) {
  validateStudioConnectionTrust(connection);
  const profile = getStudioConnectionProfile(connection.kind);
  return {
    grantId: `access:${connection.connectionId}:${connection.studioId}`,
    connectionId: connection.connectionId,
    actorKind: actorKindForConnection(connection),
    scope: {
      serverId: connection.serverId,
      userId: connection.userId ?? null,
      studioId: connection.studioId,
    },
    transport: profile.transport,
    dataOwner: profile.dataOwner,
    localOnly: profile.transport === "loopback",
    capabilities: deriveCapabilities(connection, profile),
  };
}

function deriveCapabilities(connection, profile) {
  if (profile.kind === "local") {
    return [...STUDIO_ACCESS_CAPABILITIES];
  }

  const requested = new Set(connection.capabilities);
  const allowed = new Set();
  if (requested.has("chat")) allowed.add("chat");
  if (requested.has("resources")) allowed.add("resources.read");
  if (requested.has("files") || requested.has("files.read")) allowed.add("files.read");
  if (requested.has("files") || requested.has("files.write")) allowed.add("files.write");
  if (requested.has("tools")) allowed.add("tools.run");

  return STUDIO_ACCESS_CAPABILITIES.filter((capability) => allowed.has(capability));
}

function actorKindForConnection(connection) {
  switch (connection.credentialKind) {
    case "loopback_token":
      return "local_user";
    case "device_credential":
      return "device";
    case "user_session":
      if (!connection.platformAccountId && !connection.officialServiceKind) {
        return "account_user";
      }
      return "platform_account";
    case "none":
    default:
      return "anonymous";
  }
}

function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
