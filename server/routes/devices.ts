import { Hono } from "hono";
import {
  approvePairingSession,
  createPairingSession,
  loadDeviceAccessRegistries,
  revokeDevice,
  revokeDeviceCredential,
} from "../../core/device-registry.ts";
import { safeJson } from "../hono-helpers.ts";

const DEFAULT_DEVICE_SCOPES = Object.freeze(["chat", "resources.read", "files.read", "files.write"]);

export function createDevicesRoute(engine) {
  const route = new Hono();
  const deviceHome = () => engine.gsapHome || engine.hanakoHome;

  route.get("/devices", (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const registries = loadDeviceAccessRegistries(deviceHome());
      return c.json({
        devices: registries.devices.devices.map(sanitizeDevice),
        credentials: registries.credentials.credentials.map(sanitizeCredential),
        pairingSessions: registries.pairingSessions.pairingSessions.map(sanitizePairingSession),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/devices/pairing-sessions", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const runtimeContext = resolveRuntimeContext(c, engine);
      const created = createPairingSession(deviceHome(), {
        serverNodeId: runtimeContext.serverNodeId,
        userId: runtimeContext.userId,
        requestedDevice: body?.requestedDevice,
        ttlMs: body?.ttlMs,
      });
      return c.json({
        pairingSessionId: created.pairingSession.pairingSessionId,
        userCode: created.userCode,
        expiresAt: created.pairingSession.expiresAt,
        requestedDevice: created.pairingSession.requestedDevice,
      });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/devices/pairing-sessions/:pairingSessionId/approve", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const runtimeContext = resolveRuntimeContext(c, engine);
      const issued = approvePairingSession(deviceHome(), {
        pairingSessionId: c.req.param("pairingSessionId"),
        userCode: body?.userCode,
        studioIds: normalizeStudioIds(body?.studioIds, runtimeContext.studioId),
        trustState: body?.trustState || "lan",
        scopes: normalizeScopes(body?.scopes),
        expiresAt: body?.expiresAt ?? null,
      });
      return c.json({
        secret: issued.secret,
        device: sanitizeDevice(issued.device),
        credential: sanitizeCredential(issued.credential),
        pairingSession: sanitizePairingSession(issued.pairingSession),
      });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/devices/:deviceId/revoke", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const device = revokeDevice(deviceHome(), c.req.param("deviceId"));
      return c.json({ ok: true, device: sanitizeDevice(device) });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/devices/credentials/:credentialId/revoke", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const credential = revokeDeviceCredential(deviceHome(), c.req.param("credentialId"));
      return c.json({ ok: true, credential: sanitizeCredential(credential) });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return route;
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

function normalizeStudioIds(value, fallbackStudioId) {
  if (Array.isArray(value) && value.length > 0) return value;
  return [fallbackStudioId];
}

function normalizeScopes(value) {
  if (Array.isArray(value) && value.length > 0) return value;
  return [...DEFAULT_DEVICE_SCOPES];
}

function sanitizeDevice(device) {
  const { publicKey, ...safe } = device || {};
  return publicKey ? { ...safe, publicKey } : safe;
}

function sanitizeCredential(credential) {
  const { secretHash: _secretHash, secretSalt: _secretSalt, ...safe } = credential || {};
  return safe;
}

function sanitizePairingSession(session) {
  const { userCodeHash: _userCodeHash, userCodeSalt: _userCodeSalt, ...safe } = session || {};
  return safe;
}
