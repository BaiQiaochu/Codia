import { authenticateDeviceCredential } from "./device-registry.ts";
import { normalizePrincipal } from "./security-principal.ts";
import { authenticateWebSession } from "./web-session-store.ts";

type ConnectionKind = "local" | "lan" | "custom_remote" | "relay" | "cloud" | string;
type CredentialSource = "authorization" | "query" | "cookie";

interface AuthPrincipal {
  kind?: string | null;
  credentialKind?: string | null;
  connectionKind?: ConnectionKind | null;
  trustState?: string | null;
  serverId?: string | null;
  serverNodeId?: string | null;
  userId?: string | null;
  studioId?: string | null;
  deviceId?: string | null;
  credentialId?: string | null;
  platformAccountId?: string | null;
  officialServiceKind?: string | null;
  scopes?: unknown;
  [key: string]: unknown;
}

interface RuntimeContext {
  serverId?: string | null;
  serverNodeId?: string | null;
  userId?: string | null;
  studioId?: string | null;
  platformAccountId?: string | null;
  officialServiceKind?: string | null;
  capabilities?: unknown;
}

interface ServerAuthOptions {
  codiaHome: string;
  loopbackToken: string;
  runtimeContext?: RuntimeContext | (() => RuntimeContext | null | undefined) | null;
}

interface AuthRequestInput {
  authorization?: string | null;
  queryToken?: string | null;
  cookieHeader?: string | null;
  allowQueryToken?: boolean;
  connectionKind?: ConnectionKind;
  now?: string;
}

interface ParsedCredential {
  token: string;
  source: "authorization" | "query";
}

interface AuthDenied {
  error: "forbidden";
  reason: string;
  credentialSource?: CredentialSource;
  connectionKind?: ConnectionKind;
}

type AuthResult = Readonly<
  | { principal: AuthPrincipal; denied: null }
  | { principal: null; denied: Readonly<AuthDenied> }
>;

interface ServerAuthService {
  authenticateRequest(input?: AuthRequestInput): AuthPrincipal | null;
  authenticateRequestDetailed(input?: AuthRequestInput): AuthResult;
  authenticateToken(
    token: string | null | undefined,
    options?: Omit<AuthRequestInput, "authorization">,
  ): AuthPrincipal | null;
}

export function createServerAuthService({
  codiaHome,
  loopbackToken,
  runtimeContext,
}: ServerAuthOptions): ServerAuthService {
  if (!codiaHome) throw new Error("codiaHome required");
  if (!isNonEmptyString(loopbackToken)) throw new Error("loopbackToken required");

  function resolveRuntimeContext(): RuntimeContext | null | undefined {
    return typeof runtimeContext === "function" ? runtimeContext() : runtimeContext;
  }

  function authenticateRequest({
    authorization = null,
    queryToken = null,
    cookieHeader = null,
    allowQueryToken = false,
    connectionKind = "local",
    now,
  }: AuthRequestInput = {}): AuthPrincipal | null {
    return authenticateRequestDetailed({
      authorization,
      queryToken,
      cookieHeader,
      allowQueryToken,
      connectionKind,
      now,
    }).principal;
  }

  function authenticateRequestDetailed({
    authorization = null,
    queryToken = null,
    cookieHeader = null,
    allowQueryToken = false,
    connectionKind = "local",
    now,
  }: AuthRequestInput = {}): AuthResult {
    const parsed = parseCredential({ authorization, queryToken, allowQueryToken, connectionKind });
    if (!parsed) {
      const webPrincipal = authenticateWebSession(codiaHome, cookieHeader, { now });
      if (!webPrincipal) {
        return denyAuth("missing_credential", { connectionKind });
      }
      if (!principalAllowsConnection(webPrincipal, connectionKind)) {
        return denyAuth("connection_not_allowed", {
          credentialSource: "cookie",
          connectionKind,
        });
      }
      return allowAuth(normalizePrincipal({
        ...webPrincipal,
        connectionKind: connectionKind === "local"
          ? (webPrincipal.connectionKind || connectionKind)
          : connectionKind,
      }));
    }

    if (parsed.token === loopbackToken) {
      if (connectionKind !== "local") {
        return denyAuth("loopback_token_requires_local_transport", {
          credentialSource: parsed.source,
          connectionKind,
        });
      }
      return allowAuth(createLocalPrincipal(resolveRuntimeContext()));
    }

    const devicePrincipal = authenticateDeviceCredential(codiaHome, parsed.token, { now });
    if (!devicePrincipal) {
      return denyAuth("invalid_credential", {
        credentialSource: parsed.source,
        connectionKind,
      });
    }
    if (!principalAllowsConnection(devicePrincipal, connectionKind)) {
      return denyAuth("connection_not_allowed", {
        credentialSource: parsed.source,
        connectionKind,
      });
    }
    return allowAuth(normalizePrincipal({
      ...devicePrincipal,
      connectionKind: connectionKind === "local" ? devicePrincipal.connectionKind : connectionKind,
    }));
  }

  function authenticateToken(
    token: string | null | undefined,
    options: Omit<AuthRequestInput, "authorization"> = {},
  ): AuthPrincipal | null {
    return authenticateRequest({
      ...options,
      authorization: token ? `Bearer ${token}` : null,
    });
  }

  return Object.freeze({
    authenticateRequest,
    authenticateRequestDetailed,
    authenticateToken,
  });
}

export function parseBearerAuthorization(authorization: unknown): string | null {
  if (!isNonEmptyString(authorization)) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : null;
}

function parseCredential({
  authorization,
  queryToken,
  allowQueryToken,
  connectionKind,
}: AuthRequestInput): ParsedCredential | null {
  const bearer = parseBearerAuthorization(authorization);
  if (bearer) return { token: bearer, source: "authorization" };
  if (!allowQueryToken || !isNonEmptyString(queryToken)) return null;
  if (connectionKind !== "local") return null;
  return { token: queryToken.trim(), source: "query" };
}

function createLocalPrincipal(runtimeContext: RuntimeContext | null | undefined): AuthPrincipal {
  return normalizePrincipal({
    kind: "local_user",
    credentialKind: "loopback_token",
    connectionKind: "local",
    trustState: "local",
    serverId: runtimeContext?.serverId ?? null,
    serverNodeId: runtimeContext?.serverNodeId ?? runtimeContext?.serverId ?? null,
    userId: runtimeContext?.userId ?? null,
    studioId: runtimeContext?.studioId ?? null,
    platformAccountId: runtimeContext?.platformAccountId ?? null,
    officialServiceKind: runtimeContext?.officialServiceKind ?? null,
    scopes: Array.isArray(runtimeContext?.capabilities) ? [...runtimeContext.capabilities] : ["chat", "resources", "tools"],
  });
}

function principalAllowsConnection(
  principal: AuthPrincipal | null | undefined,
  connectionKind: ConnectionKind,
): boolean {
  if (!principal) return false;
  if (principal.kind === "local_user") return connectionKind === "local";
  if (principal.kind !== "device") return true;
  if (connectionKind === "local") return true;
  if (principal.trustState === "tunnel") return connectionKind === "custom_remote";
  return connectionKind === "lan";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function allowAuth(principal: AuthPrincipal): AuthResult {
  return Object.freeze({ principal, denied: null });
}

function denyAuth(
  reason: string,
  details: Partial<Omit<AuthDenied, "error" | "reason">> = {},
): AuthResult {
  return Object.freeze({
    principal: null,
    denied: Object.freeze({
      error: "forbidden",
      reason,
      ...details,
    }),
  });
}
