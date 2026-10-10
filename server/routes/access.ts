// @ts-nocheck
import os from "os";
import QRCode from "qrcode";
import { Hono } from "hono";
import { createDeviceCredential, loadDeviceAccessRegistries } from "../../core/device-registry.ts";
import {
  loadServerNetworkConfig,
  saveServerNetworkConfig,
} from "../../core/server-network-config.ts";
import {
  clearLocalAccountPassword,
  getLocalAccountSummary,
  setLocalAccountPassword,
  updateLocalAccountProfile,
} from "../../core/local-user-account.ts";
import { safeJson } from "../hono-helpers.ts";
import {
  DESKTOP_REMOTE_ACCESS_SCOPES,
  MOBILE_REMOTE_ACCESS_SCOPES,
} from "../../shared/access-scope-profiles.ts";

const ACCESS_PROFILES = Object.freeze({
  mobile: Object.freeze({
    deviceKind: "mobile",
    fallbackDisplayName: "Mobile PWA",
    urlField: "lanMobileUrl",
    candidateUrlField: "candidateLanMobileUrl",
    localUrlField: "localMobileUrl",
    defaultScopes: MOBILE_REMOTE_ACCESS_SCOPES,
    allowedScopes: new Set(MOBILE_REMOTE_ACCESS_SCOPES),
    requiredScopes: Object.freeze(["resources.read"]),
  }),
  desktop: Object.freeze({
    deviceKind: "desktop",
    fallbackDisplayName: "Desktop Frontend",
    urlField: "lanServerUrl",
    candidateUrlField: "candidateLanServerUrl",
    localUrlField: "localServerUrl",
    defaultScopes: DESKTOP_REMOTE_ACCESS_SCOPES,
    allowedScopes: new Set(DESKTOP_REMOTE_ACCESS_SCOPES),
    requiredScopes: DESKTOP_REMOTE_ACCESS_SCOPES,
  }),
});

export function createAccessRoute({
  engine,
  runtimeState = {},
  listLanAddresses = getLanAddresses,
  now = () => new Date().toISOString(),
}: {
  engine?: any;
  runtimeState?: any;
  listLanAddresses?: () => any[];
  now?: () => string;
} = {}) {
  const codiaHome = engine?.codiaHome;
  if (!codiaHome) throw new Error("engine.codiaHome required");
  const route = new Hono();

  route.get("/access/summary", (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    return c.json(createAccessSummary(engine, runtimeState, listLanAddresses));
  });

  route.get("/access/mobile-qr.svg", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    const summary = createAccessSummary(engine, runtimeState, listLanAddresses);
    const port = normalizeQrPort(c.req.query("port"), summary.network.actualPort);
    const url = buildLanMobileUrl(summary.network.lanAddresses, port);
    if (!url) {
      return c.json({ error: "lan_address_unavailable" }, 400);
    }
    const svg = await QRCode.toString(url, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
    });
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(svg);
  });

  route.put("/access/network", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const existing = loadServerNetworkConfig(codiaHome);
      const mode = normalizeNetworkMode(body?.mode);
      const listenPort = normalizePort(body?.listenPort ?? body?.configuredPort ?? existing.listenPort);
      const listenHost = mode === "lan" ? "0.0.0.0" : "127.0.0.1";
      const network = saveServerNetworkConfig(codiaHome, {
        ...existing,
        mode,
        listenHost,
        listenPort,
      }, { now: now() });

      applyRuntimeNetworkState(runtimeState, network);
      syncWebAccessPreference(engine, mode);

      return c.json({
        ok: true,
        network: createNetworkSummary(network, runtimeState, listLanAddresses),
      });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/access/mobile-credentials", async (c) => {
    return issueAccessCredential(c, ACCESS_PROFILES.mobile);
  });

  route.post("/access/desktop-credentials", async (c) => {
    return issueAccessCredential(c, ACCESS_PROFILES.desktop);
  });

  async function issueAccessCredential(c, profile) {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const runtimeContext = resolveRuntimeContext(c, engine);
      const issued = createDeviceCredential(codiaHome, {
        serverNodeId: runtimeContext.serverNodeId,
        userId: runtimeContext.userId,
        studioIds: [runtimeContext.studioId],
        displayName: normalizeDisplayName(body?.displayName, profile.fallbackDisplayName),
        deviceKind: profile.deviceKind,
        trustState: "lan",
        scopes: normalizeScopes(body?.scopes, profile),
        expiresAt: body?.expiresAt ?? null,
        now: now(),
      });
      const summary = createAccessSummary(engine, runtimeState, listLanAddresses);
      return c.json({
        ok: true,
        secret: issued.secret,
        accessUrl: summary.network[profile.urlField]
          || summary.network[profile.candidateUrlField]
          || summary.network[profile.localUrlField],
        device: sanitizeDevice(issued.device),
        credential: sanitizeCredential(issued.credential),
      });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  }

  route.put("/access/account/profile", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const account = updateLocalAccountProfile(codiaHome, {
        username: body?.username,
        displayName: body?.displayName,
        now: now(),
      });
      return c.json({ ok: true, account });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.put("/access/account/password", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const account = setLocalAccountPassword(codiaHome, {
        password: body?.password,
        now: now(),
      });
      return c.json({ ok: true, account });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.delete("/access/account/password", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const account = clearLocalAccountPassword(codiaHome, { now: now() });
      return c.json({ ok: true, account });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return route;
}

export function createAccessSummary(engine, runtimeState, listLanAddresses) {
  const network = loadServerNetworkConfig(engine.codiaHome);
  const registries = loadDeviceAccessRegistries(engine.codiaHome);
  return {
    network: createNetworkSummary(network, runtimeState, listLanAddresses),
    account: getLocalAccountSummary(engine.codiaHome),
    devices: registries.devices.devices.map(sanitizeDevice),
    credentials: registries.credentials.credentials.map(sanitizeCredential),
  };
}

function createNetworkSummary(network, runtimeState, listLanAddresses) {
  const actualPort = Number.isInteger(runtimeState?.actualPort)
    ? runtimeState.actualPort
    : network.listenPort;
  const runtimeMode = runtimeState?.mode || network.mode;
  const runtimeHost = runtimeState?.listenHost || network.listenHost;
  const lanAddresses = listLanAddresses();
  const localServerUrl = buildServerUrl("127.0.0.1", actualPort);
  const candidateLanServerUrl = buildLanServerUrl(lanAddresses, network.listenPort);
  const lanServerUrl = network.mode === "lan" && lanAddresses.length > 0
    ? buildServerUrl(lanAddresses[0], actualPort)
    : null;
  const localMobileUrl = buildMobileUrl("127.0.0.1", actualPort);
  const candidateLanMobileUrl = buildLanMobileUrl(lanAddresses, network.listenPort);
  const lanMobileUrl = network.mode === "lan" && lanAddresses.length > 0
    ? buildMobileUrl(lanAddresses[0], actualPort)
    : null;
  return {
    mode: network.mode,
    listenHost: network.listenHost,
    configuredPort: network.listenPort,
    actualPort,
    runtimeMode,
    runtimeHost,
    restartRequired: runtimeMode !== network.mode
      || runtimeHost !== network.listenHost
      || actualPort !== network.listenPort,
    lanAddresses,
    localServerUrl,
    candidateLanServerUrl,
    lanServerUrl,
    localMobileUrl,
    candidateLanMobileUrl,
    lanMobileUrl,
  };
}

function applyRuntimeNetworkState(runtimeState, network) {
  if (typeof runtimeState.applyNetworkConfig === "function") {
    runtimeState.applyNetworkConfig(network);
    return;
  }
  if (!Number.isInteger(runtimeState.actualPort) || runtimeState.actualPort === network.listenPort) {
    runtimeState.mode = network.mode;
    runtimeState.listenHost = network.listenHost;
  }
}

function syncWebAccessPreference(engine, mode) {
  const prefs = engine?.preferences;
  if (typeof prefs?.getWebAccess !== "function" || typeof prefs?.setWebAccess !== "function") return;
  const current = prefs.getWebAccess() || {};
  prefs.setWebAccess({
    api_key: current.api_key,
    created_at: current.created_at || undefined,
    enabled: current.enabled,
    external_enabled: mode === "lan",
    public_base_url: current.public_base_url,
  });
}

function buildServerUrl(host, port) {
  return `http://${formatUrlHost(host)}:${port}/`;
}

function buildMobileUrl(host, port) {
  return `http://${formatUrlHost(host)}:${port}/mobile/`;
}

function buildLanServerUrl(lanAddresses, port) {
  const host = Array.isArray(lanAddresses) ? lanAddresses[0] : null;
  return host ? buildServerUrl(host, port) : null;
}

function buildLanMobileUrl(lanAddresses, port) {
  const host = Array.isArray(lanAddresses) ? lanAddresses[0] : null;
  return host ? buildMobileUrl(host, port) : null;
}

function formatUrlHost(host) {
  const value = String(host || "");
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function requireLocalOwner(c) {
  return isLocalOwnerPrincipal(readAuthPrincipal(c))
    ? null
    : c.json({ error: "local_only_route" }, 403);
}

function readAuthPrincipal(c) {
  if (typeof c?.get !== "function") return null;
  try {
    return c.get("authPrincipal") || null;
  } catch {
    return null;
  }
}

function isLocalOwnerPrincipal(principal) {
  return principal?.kind === "local_user"
    && principal.connectionKind === "local"
    && principal.credentialKind === "loopback_token";
}

function resolveRuntimeContext(c, engine) {
  const principal = readAuthPrincipal(c);
  const runtimeContext = typeof engine.getRuntimeContext === "function" ? engine.getRuntimeContext() : {};
  const serverNodeId = principal?.serverNodeId || runtimeContext?.serverNodeId || runtimeContext?.serverId;
  const userId = principal?.userId || runtimeContext?.userId;
  const studioId = principal?.studioId || runtimeContext?.studioId;
  if (!serverNodeId) throw new Error("serverNodeId unavailable");
  if (!userId) throw new Error("userId unavailable");
  if (!studioId) throw new Error("studioId unavailable");
  return { serverNodeId, userId, studioId };
}

function normalizeNetworkMode(value) {
  if (value === "loopback" || value === "lan") return value;
  throw new Error("mode must be loopback or lan");
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("listenPort must be between 1024 and 65535");
  }
  return port;
}

function normalizeQrPort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return normalizePort(value);
}

function normalizeDisplayName(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, 80);
}

function normalizeScopes(value, profile) {
  const defaultScopes = profile?.defaultScopes || MOBILE_REMOTE_ACCESS_SCOPES;
  const allowedScopes = profile?.allowedScopes || new Set(defaultScopes);
  const requiredScopes = profile?.requiredScopes || [];
  const raw = Array.isArray(value) && value.length > 0 ? value : defaultScopes;
  const validScopes = raw.filter((scope) => typeof scope === "string" && allowedScopes.has(scope));
  if (validScopes.length === 0) throw new Error("at least one supported scope is required");
  const scopeSet = new Set(validScopes);
  for (const scope of requiredScopes) scopeSet.add(scope);
  return defaultScopes.filter((scope) => scopeSet.has(scope));
}

function sanitizeDevice(device) {
  const { publicKey, ...safe } = device || {};
  return publicKey ? { ...safe, publicKey } : safe;
}

function sanitizeCredential(credential) {
  const { secretHash: _secretHash, secretSalt: _secretSalt, ...safe } = credential || {};
  return safe;
}

export function getLanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      out.push(entry.address);
    }
  }
  return out;
}
