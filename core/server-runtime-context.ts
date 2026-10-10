import { loadServerIdentity } from "./server-identity.ts";
import { createRuntimeExecutionBoundary } from "./execution-boundary.ts";

const LOCAL_CAPABILITIES = ["chat", "resources", "files", "tools"];

type RuntimeContextOptions = {
  codiaHome?: string;
  appVersion?: string;
};

type FallbackRuntimeContextOptions = {
  serverId?: string;
  userId?: string;
  spaceId?: string;
  appVersion?: string;
};

type RuntimeIdentity = {
  serverId: string;
  serverNodeId?: string | null;
  serverNodeKind?: string | null;
  serverNodeTransport?: string | null;
  userId: string;
  spaceId: string;
  label?: string | null;
  userLabel?: string | null;
  spaceLabel?: string | null;
  userKind?: string | null;
  spaceKind?: string | null;
  membershipModel?: string | null;
  storage?: unknown;
};

type RuntimeContext = {
  schemaVersion: number;
  serverId: string;
  serverNodeId: string;
  serverNodeKind: string;
  serverNodeTransport: string;
  userId: string;
  spaceId: string;
  studioId: string;
  label?: string | null;
  userLabel?: string | null;
  spaceLabel?: string | null;
  studioLabel?: string | null;
  userKind?: string | null;
  spaceKind?: string | null;
  studioKind?: string | null;
  membershipModel?: string | null;
  storage?: unknown;
  connectionKind: string;
  authState: string;
  trustState: string;
  credentialKind: string;
  platformAccountId: string | null;
  officialServiceKind: string | null;
  capabilities: string[];
  appVersion: string;
  executionBoundary?: unknown;
};

function clonePlain<T>(value: T): T | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createServerRuntimeContext({ codiaHome, appVersion = "?" }: RuntimeContextOptions = {}) {
  const identity = loadServerIdentity(codiaHome) as RuntimeIdentity;
  const spaceId = identity.spaceId;
  const runtimeContext: RuntimeContext = {
    schemaVersion: 1,
    serverId: identity.serverId,
    serverNodeId: identity.serverNodeId || identity.serverId,
    serverNodeKind: identity.serverNodeKind || "local",
    serverNodeTransport: identity.serverNodeTransport || "loopback",
    userId: identity.userId,
    spaceId,
    studioId: spaceId,
    label: identity.label,
    userLabel: identity.userLabel,
    spaceLabel: identity.spaceLabel,
    studioLabel: identity.spaceLabel,
    userKind: identity.userKind,
    spaceKind: identity.spaceKind,
    studioKind: identity.spaceKind,
    membershipModel: identity.membershipModel,
    storage: clonePlain(identity.storage),
    connectionKind: "local",
    authState: "paired",
    trustState: "local",
    credentialKind: "loopback_token",
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: [...LOCAL_CAPABILITIES],
    appVersion,
  };
  runtimeContext.executionBoundary = createRuntimeExecutionBoundary(runtimeContext);
  return deepFreeze(runtimeContext);
}

export function createFallbackRuntimeContext({
  serverId = "server_local",
  userId = "user_local",
  spaceId = "space_local",
  appVersion = "?",
}: FallbackRuntimeContextOptions = {}) {
  const runtimeContext: RuntimeContext = {
    schemaVersion: 1,
    serverId,
    serverNodeId: serverId,
    serverNodeKind: "local",
    serverNodeTransport: "loopback",
    userId,
    spaceId,
    studioId: spaceId,
    label: "Local service",
    userLabel: "Local User",
    spaceLabel: "Personal Space",
    studioLabel: "Personal Space",
    connectionKind: "local",
    authState: "paired",
    trustState: "local",
    credentialKind: "loopback_token",
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: [...LOCAL_CAPABILITIES],
    appVersion,
  };
  runtimeContext.executionBoundary = createRuntimeExecutionBoundary(runtimeContext);
  return deepFreeze(runtimeContext);
}

export function toServerIdentityResponse(
  runtimeContext: RuntimeContext,
  { appVersion }: { appVersion?: string } = {},
) {
  const spaceId = runtimeContext.spaceId || runtimeContext.studioId;
  const spaceLabel = runtimeContext.spaceLabel || runtimeContext.studioLabel;
  return {
    connectionKind: runtimeContext.connectionKind,
    serverId: runtimeContext.serverId,
    serverNodeId: runtimeContext.serverNodeId ?? runtimeContext.serverId,
    serverNodeKind: runtimeContext.serverNodeKind ?? "local",
    serverNodeTransport: runtimeContext.serverNodeTransport ?? "loopback",
    userId: runtimeContext.userId,
    spaceId,
    studioId: runtimeContext.studioId || spaceId,
    label: runtimeContext.label,
    userLabel: runtimeContext.userLabel,
    spaceLabel,
    studioLabel: runtimeContext.studioLabel || spaceLabel,
    trustState: runtimeContext.trustState,
    authState: runtimeContext.authState,
    credentialKind: runtimeContext.credentialKind,
    platformAccountId: runtimeContext.platformAccountId ?? null,
    officialServiceKind: runtimeContext.officialServiceKind ?? null,
    executionBoundary: clonePlain(runtimeContext.executionBoundary),
    capabilities: [...(runtimeContext.capabilities || LOCAL_CAPABILITIES)],
    version: appVersion || runtimeContext.appVersion || "?",
  };
}
