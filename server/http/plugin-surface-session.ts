import { normalizePrincipal } from "../../core/security-principal.ts";
import {
  PluginSurfaceSessionError,
  verifyPluginSurfaceSession,
} from "../../core/plugin-surface-session-service.ts";
import {
  PLUGIN_SURFACE_SESSION_HEADER,
  PLUGIN_SURFACE_SESSION_QUERY,
} from "../../packages/plugin-protocol/src/index.ts";

export { PluginSurfaceSessionError };
export { PLUGIN_SURFACE_SESSION_HEADER, PLUGIN_SURFACE_SESSION_QUERY };

const LEGACY_PLUGIN_SURFACE_SESSION_HEADER = "X-Hana-Plugin-Surface-Session";

const CONNECTION_TRUST_STATES = Object.freeze({
  local: "local",
  lan: "lan",
  custom_remote: "tunnel",
});

export function authenticatePluginSurfaceRequest(c: any, engine: any, { connectionKind = null } = {}) {
  const routePath = new URL(c.req.url).pathname;
  const pluginId = pluginIdFromProxyPath(routePath);
  if (!pluginId) return null;
  const token = c.req.header(PLUGIN_SURFACE_SESSION_HEADER)
    || c.req.header(LEGACY_PLUGIN_SURFACE_SESSION_HEADER)
    || c.req.query(PLUGIN_SURFACE_SESSION_QUERY)
    || null;
  if (!token) return null;
  const gsapHome = engine?.gsapHome || engine?.hanakoHome;
  if (!gsapHome) {
    throw new PluginSurfaceSessionError("plugin surface session storage unavailable", {
      code: "plugin_surface_session_unavailable",
      status: 500,
    });
  }
  const session = verifyPluginSurfaceSession({
    gsapHome,
    pluginId,
    token,
  });
  return normalizePrincipal({
    kind: "plugin",
    pluginId: session.pluginId,
    credentialId: session.sessionId,
    credentialKind: "plugin_surface_session",
    connectionKind,
    trustState: CONNECTION_TRUST_STATES[connectionKind] || "unknown",
    scopes: [],
  });
}

function pluginIdFromProxyPath(routePath: string) {
  const match = /^\/api\/plugins\/([^/]+)\/.+$/.exec(String(routePath || ""));
  if (!match) return null;
  try {
    const pluginId = decodeURIComponent(match[1]);
    return pluginId || null;
  } catch {
    return null;
  }
}
