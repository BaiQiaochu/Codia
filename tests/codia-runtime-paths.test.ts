// @ts-nocheck
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  configureProcessPiSdkEnv,
  ensureCodiaPiSdkDirs,
  resolveCodiaHome,
  resolveCodiaPiAgentDir,
  resolveCodiaPiProjectDir,
  resolveServerInfoPath,
  serverInfoFileNameForScope,
  withCodiaPiSdkEnv,
} from "../shared/codia-runtime-paths.ts";

describe("Codia runtime path contracts", () => {
  it("derives the Pi SDK agent directory from CODIA_HOME", () => {
    const codiaHome = path.join(os.tmpdir(), "codia-runtime-paths", ".codia-dev");

    expect(resolveCodiaPiAgentDir(codiaHome)).toBe(path.join(codiaHome, ".pi", "agent"));
    expect(resolveCodiaPiProjectDir(codiaHome)).toBe(path.join(codiaHome, ".pi", "project"));
  });

  it("normalizes configured home paths before deriving runtime paths", () => {
    const homeDir = path.join(os.tmpdir(), "codia-runtime-home");

    expect(resolveCodiaHome("~/.codia-dev", homeDir)).toBe(path.join(homeDir, ".codia-dev"));
    expect(resolveCodiaHome({ CODIA_HOME: "~/.codia-env" }, homeDir)).toBe(path.join(homeDir, ".codia-env"));
    expect(resolveCodiaHome({}, homeDir)).toBe(path.join(homeDir, ".codia"));
  });

  it("uses scoped server-info files for independent runtimes", () => {
    const codiaHome = path.join(os.tmpdir(), "codia-runtime-server-info", ".codia");

    expect(serverInfoFileNameForScope("desktop")).toBe("server-info.desktop.json");
    expect(serverInfoFileNameForScope("cli")).toBe("server-info.cli.json");
    expect(serverInfoFileNameForScope("")).toBe("server-info.json");
    expect(resolveServerInfoPath(codiaHome, {}, "pwa")).toBe(path.join(codiaHome, "server-info.pwa.json"));
    expect(resolveServerInfoPath(codiaHome, { CODIA_SERVER_INFO: "~/custom-info.json" }, "pwa"))
      .toBe(path.join(os.homedir(), "custom-info.json"));
  });

  it("adds PI_CODING_AGENT_DIR without dropping existing environment", () => {
    const codiaHome = path.join(os.tmpdir(), "codia-runtime-env", ".codia");
    const baseEnv = { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/old-pi" };

    expect(withCodiaPiSdkEnv(baseEnv, codiaHome)).toEqual({
      PATH: "/usr/bin",
      PI_CODING_AGENT_DIR: path.join(codiaHome, ".pi", "agent"),
    });
    expect(baseEnv.PI_CODING_AGENT_DIR).toBe("/old-pi");
  });

  it("can install the Pi SDK agent directory into a process env object", () => {
    const codiaHome = path.join(os.tmpdir(), "codia-runtime-process", ".codia");
    const env = {};

    expect(configureProcessPiSdkEnv(codiaHome, env)).toBe(path.join(codiaHome, ".pi", "agent"));
    expect(env.PI_CODING_AGENT_DIR).toBe(path.join(codiaHome, ".pi", "agent"));
  });

  it("creates Codia-owned Pi SDK directories explicitly", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-runtime-dirs-"));
    const codiaHome = path.join(root, ".codia");

    ensureCodiaPiSdkDirs(codiaHome);

    expect(fs.statSync(path.join(codiaHome, ".pi", "agent")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(codiaHome, ".pi", "project")).isDirectory()).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
