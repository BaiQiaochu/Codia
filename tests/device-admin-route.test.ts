import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codia-device-admin-route-"));
}

function localOwner() {
  return {
    kind: "local_user",
    credentialKind: "loopback_token",
    connectionKind: "local",
    serverNodeId: "node_home_mac",
    userId: "user_owner",
    studioId: "studio_home",
    scopes: ["chat", "resources", "tools"],
  };
}

function withPrincipal(app, principal) {
  app.use("*", async (c, next) => {
    c.set("authPrincipal", Object.freeze(principal));
    await next();
  });
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf-8"));
}

describe("device admin route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("creates and approves a pairing session without exposing persisted credential hashes", async () => {
    const { createDevicesRoute } = await import("../server/routes/devices.ts");
    tmpDir = makeTmpDir();
    const engine = {
      codiaHome: tmpDir,
      getRuntimeContext: () => ({
        serverNodeId: "node_home_mac",
        userId: "user_owner",
        studioId: "studio_home",
      }),
    };
    const app = new Hono();
    withPrincipal(app, localOwner());
    app.route("/api", createDevicesRoute(engine));

    const createdRes = await app.request("/api/devices/pairing-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestedDevice: {
          displayName: "Owner iPhone",
          deviceKind: "mobile",
        },
      }),
    });
    const created = await createdRes.json();

    expect(createdRes.status).toBe(200);
    expect(created).toMatchObject({
      pairingSessionId: expect.stringMatching(/^pair_/),
      userCode: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
      requestedDevice: {
        displayName: "Owner iPhone",
        deviceKind: "mobile",
      },
    });

    const approvedRes = await app.request(`/api/devices/pairing-sessions/${created.pairingSessionId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userCode: created.userCode,
        scopes: ["chat", "resources.read", "settings.read", "settings.write", "providers.manage", "secrets.write"],
        trustState: "lan",
      }),
    });
    const approved = await approvedRes.json();

    expect(approvedRes.status).toBe(200);
    expect(approved.secret).toMatch(/^codia_dev_/);
    expect(approved.device).toMatchObject({
      displayName: "Owner iPhone",
      deviceKind: "mobile",
      studioIds: ["studio_home"],
      status: "active",
    });
    expect(approved.credential).toMatchObject({
      scopes: ["chat", "resources.read", "settings.read", "settings.write", "providers.manage", "secrets.write"],
      status: "active",
    });
    expect(JSON.stringify(approved)).not.toContain("secretHash");
    expect(JSON.stringify(approved)).not.toContain("secretSalt");

    const storedCredentials = readJson(tmpDir, "device-credentials.json");
    expect(JSON.stringify(storedCredentials)).not.toContain(approved.secret);
    expect(storedCredentials.credentials[0]).toMatchObject({
      secretHash: expect.any(String),
      secretSalt: expect.any(String),
      secretPrefix: approved.secret.slice(0, 18),
    });
  });
});
