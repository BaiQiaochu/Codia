import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codia-server-network-"));
}

describe("server network config", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("resolves missing config to loopback defaults with a stable mobile port", async () => {
    tmpDir = makeTmpDir();
    const {
      loadServerNetworkConfig,
      resolveServerListenOptions,
    } = await import("../core/server-network-config.js");

    expect(loadServerNetworkConfig(tmpDir)).toMatchObject({
      schemaVersion: 1,
      mode: "loopback",
      listenHost: "127.0.0.1",
      listenPort: 14500,
    });
    expect(resolveServerListenOptions(tmpDir)).toMatchObject({
      mode: "loopback",
      host: "127.0.0.1",
      port: 14500,
    });
  });

  it("rejects unsafe loopback and invalid port configurations", async () => {
    tmpDir = makeTmpDir();
    const { saveServerNetworkConfig } = await import("../core/server-network-config.js");

    expect(() => saveServerNetworkConfig(tmpDir, {
      schemaVersion: 1,
      mode: "loopback",
      listenHost: "0.0.0.0",
    })).toThrow("loopback mode must listen on a loopback host");

    expect(() => saveServerNetworkConfig(tmpDir, {
      schemaVersion: 1,
      mode: "lan",
      listenHost: "0.0.0.0",
      listenPort: 80,
    })).toThrow("listenPort must be between 1024 and 65535");
  });
});
