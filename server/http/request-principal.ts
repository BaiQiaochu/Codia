import { authorizeHttpRoute } from "./route-security.ts";
import {
  PluginSurfaceSessionError,
  authenticatePluginSurfaceRequest,
} from "./plugin-surface-session.ts";

interface DetailedAuthResult {
  principal: object | null;
  denied: {
    error?: string;
    reason?: string;
    credentialSource?: string;
    connectionKind?: string;
  } | null;
}

interface HttpAuthService {
  authenticateRequestDetailed: (input: {
    authorization?: string | null;
    queryToken?: string | null;
    cookieHeader?: string | null;
    allowQueryToken?: boolean;
    connectionKind?: string;
  }) => DetailedAuthResult;
}

export function resolveHttpRequestPrincipal(c: any, engine: any, {
  serverAuthService,
  connectionKind,
  wsTicketService = null,
  legacyPrincipal = null,
}: {
  serverAuthService: HttpAuthService;
  connectionKind: string;
  wsTicketService?: any;
  legacyPrincipal?: object | null;
}) {
  const routePath = new URL(c.req.url).pathname;
  const allowLocalQueryToken = connectionKind === "local";
  const authResult = serverAuthService.authenticateRequestDetailed({
    authorization: c.req.header("authorization"),
    queryToken: allowLocalQueryToken ? c.req.query("token") : null,
    cookieHeader: c.req.header("cookie"),
    allowQueryToken: allowLocalQueryToken,
    connectionKind,
  });
  let principal = authResult.principal || legacyPrincipal;
  if (!principal && routePath === "/ws") {
    const ticket = c.req.query("wsTicket");
    if (ticket) {
      principal = wsTicketService?.consumeTicket?.(ticket, {
        connectionKind,
        path: routePath,
      }) || null;
      if (!principal) {
        return {
          ok: false as const,
          status: 403,
          body: {
            error: "forbidden",
            reason: "invalid_ws_ticket",
            connectionKind,
          },
        };
      }
    }
  }
  if (!principal && authResult.denied?.reason === "missing_credential") {
    try {
      principal = authenticatePluginSurfaceRequest(c, engine, { connectionKind });
    } catch (err: any) {
      if (err instanceof PluginSurfaceSessionError) {
        return {
          ok: false as const,
          status: err.status,
          body: { error: err.code, detail: err.message },
        };
      }
      throw err;
    }
  }
  if (!principal) {
    const denied = authResult.denied || {};
    return {
      ok: false as const,
      status: 403,
      body: {
        error: denied.error || "forbidden",
        reason: denied.reason || "auth_failed",
        ...(denied.credentialSource ? { credentialSource: denied.credentialSource } : {}),
        connectionKind: denied.connectionKind || connectionKind,
      },
    };
  }
  const authz: any = authorizeHttpRoute({
    method: c.req.method,
    path: routePath,
    principal,
  });
  if (!authz.allowed) {
    return {
      ok: false as const,
      status: authz.status,
      body: {
        error: authz.error,
        ...(authz.reason ? { reason: authz.reason } : {}),
        ...(authz.requiredScope ? { requiredScope: authz.requiredScope } : {}),
      },
    };
  }
  return { ok: true as const, principal, authResult };
}
