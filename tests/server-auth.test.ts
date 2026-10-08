// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-server-auth-"));
}

function runtimeContext() {
  return {
    serverId: "server_local",
    serverNodeId: "node_local",
    userId: "user_local",
    studioId: "studio_local",
    connectionKind: "local",
    credentialKind: "loopback_token",
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: ["chat", "resources", "tools"],
  };
}

describe("server auth service", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("authenticates loopback token only for local connection context", async () => {
    tmpDir = makeTmpDir();
    const { createServerAuthService } = await import("../core/server-auth.js");
    const auth = createServerAuthService({
      gsapHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });

    expect(auth.authenticateRequest({
      authorization: "Bearer local-secret",
      connectionKind: "local",
    })).toMatchObject({
      kind: "local_user",
      credentialKind: "loopback_token",
      connectionKind: "local",
      trustState: "local",
      serverNodeId: "node_local",
      userId: "user_local",
      studioId: "studio_local",
    });

    expect(auth.authenticateRequest({
      authorization: "Bearer local-secret",
      connectionKind: "lan",
    })).toBeNull();
  });

  it("accepts query token only when explicitly allowed and local", async () => {
    tmpDir = makeTmpDir();
    const { createServerAuthService } = await import("../core/server-auth.js");
    const auth = createServerAuthService({
      gsapHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });

    expect(auth.authenticateRequest({
      queryToken: "local-secret",
      connectionKind: "local",
    })).toBeNull();

    expect(auth.authenticateRequest({
      queryToken: "local-secret",
      allowQueryToken: true,
      connectionKind: "local",
    })).toMatchObject({
      kind: "local_user",
      credentialKind: "loopback_token",
    });

    expect(auth.authenticateRequest({
      queryToken: "local-secret",
      allowQueryToken: true,
      connectionKind: "lan",
    })).toBeNull();

    expect(auth.authenticateRequestDetailed({
      queryToken: "local-secret",
      allowQueryToken: true,
      connectionKind: "lan",
    })).toMatchObject({
      principal: null,
      denied: {
        error: "forbidden",
        reason: "missing_credential",
        connectionKind: "lan",
      },
    });
  });

  it("authenticates paired device credentials with transport trust validation", async () => {
    tmpDir = makeTmpDir();
    const { createDeviceCredential } = await import("../core/device-registry.js");
    const { createServerAuthService } = await import("../core/server-auth.js");
    const lanIssued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_local",
      userId: "user_local",
      studioIds: ["studio_local"],
      displayName: "LAN Phone",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat", "resources.read"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const tunnelIssued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_local",
      userId: "user_local",
      studioIds: ["studio_local"],
      displayName: "Tunnel Phone",
      deviceKind: "mobile",
      trustState: "tunnel",
      scopes: ["chat"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const auth = createServerAuthService({
      gsapHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });

    expect(auth.authenticateRequest({
      authorization: `Bearer ${lanIssued.secret}`,
      connectionKind: "lan",
    })).toMatchObject({
      kind: "device",
      credentialKind: "device_credential",
      connectionKind: "lan",
      trustState: "lan",
      serverNodeId: "node_local",
      userId: "user_local",
      studioId: "studio_local",
      deviceId: lanIssued.device.deviceId,
      scopes: ["chat", "resources.read"],
    });

    expect(auth.authenticateRequest({
      authorization: `Bearer ${lanIssued.secret}`,
      connectionKind: "custom_remote",
    })).toBeNull();
    expect(auth.authenticateRequest({
      authorization: `Bearer ${tunnelIssued.secret}`,
      connectionKind: "lan",
    })).toBeNull();
    expect(auth.authenticateRequest({
      authorization: `Bearer ${tunnelIssued.secret}`,
      connectionKind: "custom_remote",
    })).toMatchObject({
      kind: "device",
      trustState: "tunnel",
      connectionKind: "custom_remote",
    });
  });

  it("authenticates HttpOnly web sessions but never accepts their secrets as URL tokens", async () => {
    tmpDir = makeTmpDir();
    const { createDeviceCredential } = await import("../core/device-registry.js");
    const { createWebSession } = await import("../core/web-session-store.js");
    const { createServerAuthService } = await import("../core/server-auth.js");
    const issued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_local",
      userId: "user_local",
      studioIds: ["studio_local"],
      displayName: "Phone Browser",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat", "resources.read", "files.read", "files.write"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const auth = createServerAuthService({
      gsapHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });
    const devicePrincipal = auth.authenticateRequest({
      authorization: `Bearer ${issued.secret}`,
      connectionKind: "lan",
      now: "2026-05-16T00:00:01.000Z",
    });
    const webSession = createWebSession(tmpDir, {
      principal: devicePrincipal,
      userAgent: "Mobile Safari",
      now: "2026-05-16T00:00:02.000Z",
      ttlMs: 60_000,
    });

    expect(webSession.cookieName).toBe("gsap_session");
    expect(webSession.secret).toMatch(/^gsap_web_/);
    expect(auth.authenticateRequest({
      cookieHeader: `gsap_session=${webSession.secret}`,
      connectionKind: "lan",
      now: "2026-05-16T00:00:03.000Z",
    })).toMatchObject({
      kind: "device",
      credentialKind: "device_credential",
      connectionKind: "lan",
      trustState: "lan",
      userId: "user_local",
      studioId: "studio_local",
      scopes: ["chat", "resources.read", "files.read", "files.write"],
    });

    expect(auth.authenticateRequest({
      queryToken: webSession.secret,
      allowQueryToken: true,
      connectionKind: "lan",
      now: "2026-05-16T00:00:03.000Z",
    })).toBeNull();
  });
});
