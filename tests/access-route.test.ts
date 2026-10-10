// @ts-nocheck
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codia-access-route-"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeIdentity(root) {
  const now = "2026-05-17T00:00:00.000Z";
  writeJson(path.join(root, "users.json"), {
    schemaVersion: 1,
    defaultUserId: "user_owner",
    users: [{
      userId: "user_owner",
      kind: "legacy_owner",
      displayName: "Owner",
      profileSource: "legacy_user_profile",
      createdAt: now,
      updatedAt: now,
    }],
    createdAt: now,
    updatedAt: now,
  });
}

function localOwner() {
  return {
    kind: "local_user",
    credentialKind: "loopback_token",
    connectionKind: "local",
    serverId: "server_access",
    serverNodeId: "server_access",
    userId: "user_owner",
    studioId: "space_home",
    scopes: ["chat", "resources", "tools"],
  };
}

async function makeApp(root, runtimeState = {}) {
  const { createAccessRoute } = await import("../server/routes/access.js");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authPrincipal", Object.freeze(localOwner()));
    await next();
  });
  app.route("/api", createAccessRoute({
    engine: {
      codiaHome: root,
      preferences: {
        getWebAccess: () => ({ external_enabled: false }),
        setWebAccess: () => {},
      },
      getRuntimeContext: () => ({
        serverId: "server_access",
        serverNodeId: "server_access",
        userId: "user_owner",
        studioId: "space_home",
      }),
    },
    runtimeState: {
      mode: "loopback",
      listenHost: "127.0.0.1",
      actualPort: 14500,
      ...runtimeState,
    },
    listLanAddresses: () => ["192.168.31.75"],
    now: () => "2026-05-17T02:00:00.000Z",
  }));
  return app;
}

describe("access route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("summarizes mobile and desktop LAN access without exposing secrets", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    const app = await makeApp(tmpDir);

    const res = await app.request("/api/access/summary");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      network: {
        mode: "loopback",
        configuredPort: 14500,
        actualPort: 14500,
        restartRequired: false,
        lanAddresses: ["192.168.31.75"],
        localServerUrl: "http://127.0.0.1:14500/",
        candidateLanServerUrl: "http://192.168.31.75:14500/",
        lanServerUrl: null,
        localMobileUrl: "http://127.0.0.1:14500/mobile/",
        candidateLanMobileUrl: "http://192.168.31.75:14500/mobile/",
        lanMobileUrl: null,
      },
      account: {
        userId: "user_owner",
        displayName: "Owner",
        passwordSet: false,
      },
      devices: [],
      credentials: [],
    });
    expect(JSON.stringify(data)).not.toContain("secretHash");
    expect(JSON.stringify(data)).not.toContain("loopback_token");
  });

  it("updates LAN mode and reports restart when configured port differs from runtime", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    const app = await makeApp(tmpDir, { mode: "loopback", listenHost: "127.0.0.1", actualPort: 14500 });

    const res = await app.request("/api/access/network", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "lan", listenPort: 14550 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      network: {
        mode: "lan",
        listenHost: "0.0.0.0",
        configuredPort: 14550,
        actualPort: 14500,
        restartRequired: true,
        candidateLanServerUrl: "http://192.168.31.75:14550/",
        lanServerUrl: "http://192.168.31.75:14500/",
        lanMobileUrl: "http://192.168.31.75:14500/mobile/",
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "server-network.json"), "utf-8")))
      .toMatchObject({ mode: "lan", listenHost: "0.0.0.0", listenPort: 14550 });
  });

  it("issues a one-time visible desktop access key without using the mobile PWA URL", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    writeJson(path.join(tmpDir, "server-network.json"), {
      schemaVersion: 1,
      mode: "lan",
      listenHost: "0.0.0.0",
      listenPort: 14500,
      customRemote: { enabled: false, baseUrl: null, wsUrl: null },
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    });
    const app = await makeApp(tmpDir, { mode: "lan", listenHost: "0.0.0.0", actualPort: 14500 });

    const res = await app.request("/api/access/desktop-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Studio Laptop",
        scopes: ["chat", "files.read", "files.write"],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.secret).toMatch(/^codia_dev_/);
    expect(data).toMatchObject({
      accessUrl: "http://192.168.31.75:14500/",
      device: {
        displayName: "Studio Laptop",
        deviceKind: "desktop",
        trustState: "lan",
      },
      credential: {
        scopes: [
          "chat",
          "resources.read",
          "files.read",
          "files.write",
          "studio.owner",
          "settings.read",
          "settings.write",
          "providers.manage",
          "secrets.write",
          "bridge.manage",
        ],
        status: "active",
      },
    });
    expect(data.accessUrl).not.toContain("/mobile/");
    expect(fs.readFileSync(path.join(tmpDir, "device-credentials.json"), "utf-8")).not.toContain(data.secret);
    expect(JSON.stringify(data)).not.toContain("secretHash");
  });

  it("issues a one-time visible mobile access key with a Codia prefix", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    const app = await makeApp(tmpDir, { mode: "lan", listenHost: "0.0.0.0", actualPort: 14500 });

    const res = await app.request("/api/access/mobile-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "User Phone",
        scopes: ["chat", "files.read", "files.write"],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.secret).toMatch(/^codia_dev_/);
    expect(data).toMatchObject({
      accessUrl: "http://192.168.31.75:14500/mobile/",
      device: {
        displayName: "User Phone",
        deviceKind: "mobile",
        trustState: "lan",
      },
      credential: {
        scopes: ["chat", "resources.read", "files.read", "files.write"],
        status: "active",
      },
    });
    expect(fs.readFileSync(path.join(tmpDir, "device-credentials.json"), "utf-8")).not.toContain(data.secret);
    expect(JSON.stringify(data)).not.toContain("secretHash");
  });

  it("updates the local account profile and password through owner-only routes", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    const app = await makeApp(tmpDir);

    const profile = await app.request("/api/access/account/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "codia-owner", displayName: "Codia Owner" }),
    });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      account: {
        username: "codia-owner",
        displayName: "Codia Owner",
        passwordSet: false,
      },
    });

    const password = await app.request("/api/access/account/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    expect(password.status).toBe(200);
    expect(await password.json()).toMatchObject({
      account: {
        username: "codia-owner",
        displayName: "Codia Owner",
        passwordSet: true,
      },
    });
    expect(fs.readFileSync(path.join(tmpDir, "local-user-auth.json"), "utf-8"))
      .not.toContain("correct horse battery staple");
  });
});
