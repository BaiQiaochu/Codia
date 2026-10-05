// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveServerSpawnSpec } from "../cli/server-runner.ts";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-cli-runner-"));
}

describe("CLI server runner", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("runs the source server entry in development", () => {
    tmpDir = makeTmpDir();
    const spec = resolveServerSpawnSpec({
      projectRoot: tmpDir,
      env: {},
      extraArgs: ["--chat"],
    });

    expect(spec).toMatchObject({
      mode: "source",
      command: process.execPath,
    });
    expect(spec.args).toEqual([path.join(tmpDir, "server", "index.ts"), "--chat"]);
  });

  it("runs the packaged bootstrap entry when GSAP_ROOT is available", () => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, "bundle"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "bootstrap.js"), "", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "bundle", "index.js"), "", "utf-8");

    const spec = resolveServerSpawnSpec({
      projectRoot: "/source/project",
      env: { GSAP_ROOT: tmpDir },
      extraArgs: [],
    });

    expect(spec.mode).toBe("packaged");
    expect(spec.args).toEqual([path.join(tmpDir, "bootstrap.js")]);
    expect(spec.env.GSAP_ROOT).toBe(tmpDir);
    expect(spec.env.GSAP_SERVER_ENTRY).toBe(path.join(tmpDir, "bundle", "index.js"));
  });
});
