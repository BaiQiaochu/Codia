// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { readLocalServerInfo, resolveConnection } from "../cli/local-server.ts";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codia-cli-server-"));
}

describe("CLI local server discovery", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("reports a missing server-info file explicitly", () => {
    tmpDir = makeTmpDir();
    const result = readLocalServerInfo({ codiaHome: tmpDir });

    expect(result).toMatchObject({
      ok: false,
      reason: "missing_server_info",
    });
  });

  it("builds a loopback connection from server-info", () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, "server-info.json"), JSON.stringify({
      pid: process.pid,
      port: 14500,
      token: "codia_token",
      version: "1.2.3",
    }), "utf-8");

    expect(resolveConnection({ codiaHome: tmpDir })).toMatchObject({
      ok: true,
      baseUrl: "http://127.0.0.1:14500",
      token: "codia_token",
      source: "server-info",
      queryTokenAllowed: true,
    });
  });

  it("keeps the legacy codiaHome option as a compatibility alias", () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, "server-info.json"), JSON.stringify({
      pid: process.pid,
      port: 14501,
      token: "legacy_token",
    }), "utf-8");

    expect(resolveConnection({ codiaHome: tmpDir })).toMatchObject({
      ok: true,
      baseUrl: "http://127.0.0.1:14501",
      token: "legacy_token",
    });
  });

  it("uses explicit URL without allowing query-token transport by default", () => {
    expect(resolveConnection({ url: "http://example.com/", token: "device" })).toMatchObject({
      ok: true,
      baseUrl: "http://example.com",
      token: "device",
      source: "explicit",
      queryTokenAllowed: false,
    });
  });
});
