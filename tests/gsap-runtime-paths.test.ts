// @ts-nocheck
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  configureProcessPiSdkEnv,
  ensureGsapPiSdkDirs,
  resolveGsapHome,
  resolveGsapPiAgentDir,
  resolveGsapPiProjectDir,
  resolveServerInfoPath,
  serverInfoFileNameForScope,
  withGsapPiSdkEnv,
} from "../shared/gsap-runtime-paths.ts";

describe("G-SAP runtime path contracts", () => {
  it("derives the Pi SDK agent directory from GSAP_HOME", () => {
    const gsapHome = path.join(os.tmpdir(), "gsap-runtime-paths", ".gsap-dev");

    expect(resolveGsapPiAgentDir(gsapHome)).toBe(path.join(gsapHome, ".pi", "agent"));
    expect(resolveGsapPiProjectDir(gsapHome)).toBe(path.join(gsapHome, ".pi", "project"));
  });

  it("normalizes configured home paths before deriving runtime paths", () => {
    const homeDir = path.join(os.tmpdir(), "gsap-runtime-home");

    expect(resolveGsapHome("~/.gsap-dev", homeDir)).toBe(path.join(homeDir, ".gsap-dev"));
    expect(resolveGsapHome({ GSAP_HOME: "~/.gsap-env" }, homeDir)).toBe(path.join(homeDir, ".gsap-env"));
    expect(resolveGsapHome({}, homeDir)).toBe(path.join(homeDir, ".gsap"));
  });

  it("uses scoped server-info files for independent runtimes", () => {
    const gsapHome = path.join(os.tmpdir(), "gsap-runtime-server-info", ".gsap");

    expect(serverInfoFileNameForScope("desktop")).toBe("server-info.desktop.json");
    expect(serverInfoFileNameForScope("cli")).toBe("server-info.cli.json");
    expect(serverInfoFileNameForScope("")).toBe("server-info.json");
    expect(resolveServerInfoPath(gsapHome, {}, "pwa")).toBe(path.join(gsapHome, "server-info.pwa.json"));
    expect(resolveServerInfoPath(gsapHome, { GSAP_SERVER_INFO: "~/custom-info.json" }, "pwa"))
      .toBe(path.join(os.homedir(), "custom-info.json"));
  });

  it("adds PI_CODING_AGENT_DIR without dropping existing environment", () => {
    const gsapHome = path.join(os.tmpdir(), "gsap-runtime-env", ".gsap");
    const baseEnv = { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/old-pi" };

    expect(withGsapPiSdkEnv(baseEnv, gsapHome)).toEqual({
      PATH: "/usr/bin",
      PI_CODING_AGENT_DIR: path.join(gsapHome, ".pi", "agent"),
    });
    expect(baseEnv.PI_CODING_AGENT_DIR).toBe("/old-pi");
  });

  it("can install the Pi SDK agent directory into a process env object", () => {
    const gsapHome = path.join(os.tmpdir(), "gsap-runtime-process", ".gsap");
    const env = {};

    expect(configureProcessPiSdkEnv(gsapHome, env)).toBe(path.join(gsapHome, ".pi", "agent"));
    expect(env.PI_CODING_AGENT_DIR).toBe(path.join(gsapHome, ".pi", "agent"));
  });

  it("creates G-SAP-owned Pi SDK directories explicitly", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-runtime-dirs-"));
    const gsapHome = path.join(root, ".gsap");

    ensureGsapPiSdkDirs(gsapHome);

    expect(fs.statSync(path.join(gsapHome, ".pi", "agent")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(gsapHome, ".pi", "project")).isDirectory()).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
