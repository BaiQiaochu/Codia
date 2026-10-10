import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codia-device-registry-"));
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf-8"));
}

describe("device registry", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("creates empty device access registries", async () => {
    tmpDir = makeTmpDir();
    const { ensureDeviceAccessRegistries } = await import("../core/device-registry.js");

    const result = ensureDeviceAccessRegistries(tmpDir, { now: "2026-05-17T00:00:00.000Z" });

    expect(result.created).toEqual([
      "devices.json",
      "device-credentials.json",
      "pairing-sessions.json",
    ]);
    expect(readJson(tmpDir, "devices.json")).toMatchObject({ schemaVersion: 1, devices: [] });
    expect(readJson(tmpDir, "device-credentials.json")).toMatchObject({ schemaVersion: 1, credentials: [] });
    expect(readJson(tmpDir, "pairing-sessions.json")).toMatchObject({ schemaVersion: 1, pairingSessions: [] });
  });

  it("issues Codia device credentials and stores only a hash", async () => {
    tmpDir = makeTmpDir();
    const {
      authenticateDeviceCredential,
      createDeviceCredential,
      revokeDeviceCredential,
    } = await import("../core/device-registry.js");

    const issued = createDeviceCredential(tmpDir, {
      serverNodeId: "server_codia",
      userId: "user_owner",
      studioIds: ["space_home"],
      displayName: "Owner Phone",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat", "resources.read"],
      now: "2026-05-17T00:00:00.000Z",
    });

    expect(issued.secret).toMatch(/^codia_dev_/);
    expect(JSON.stringify(readJson(tmpDir, "device-credentials.json"))).not.toContain(issued.secret);
    expect(readJson(tmpDir, "device-credentials.json").credentials[0]).toMatchObject({
      credentialId: issued.credential.credentialId,
      secretPrefix: issued.secret.slice(0, 18),
      secretHash: expect.any(String),
      secretSalt: expect.any(String),
      status: "active",
    });

    expect(authenticateDeviceCredential(tmpDir, issued.secret, {
      now: "2026-05-17T00:00:01.000Z",
    })).toMatchObject({
      kind: "device",
      credentialKind: "device_credential",
      connectionKind: "lan",
      serverNodeId: "server_codia",
      userId: "user_owner",
      studioId: "space_home",
      deviceId: issued.device.deviceId,
      credentialId: issued.credential.credentialId,
      scopes: ["chat", "resources.read"],
    });

    revokeDeviceCredential(tmpDir, issued.credential.credentialId, {
      now: "2026-05-17T00:00:02.000Z",
    });
    expect(authenticateDeviceCredential(tmpDir, issued.secret)).toBeNull();
  });
});
