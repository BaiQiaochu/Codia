// @ts-nocheck
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGlobalArgs, resolveGsapHome } from "../lib/cli/args.ts";
import { normalizeApiPath, platformDirName, resolveServerLaunchConfig } from "../lib/cli/runtime-paths.ts";

describe("CLI argument parsing", () => {
  it("parses global flags and leaves command args intact", () => {
    const parsed = parseGlobalArgs([
      "--home", "~/gsap-home",
      "--api-base", "http://127.0.0.1:50150",
      "--token", "secret",
      "--json",
      "--timeout", "1234",
      "chat",
      "--stdin",
      "hello",
    ], {
      env: { HOME: "/home/test", USERPROFILE: "C:\\Users\\test" },
      cwd: "/repo",
      platform: "linux",
      stdoutIsTTY: false,
    });

    expect(parsed.opts.home).toBe(path.resolve("/home/test/gsap-home"));
    expect(parsed.opts.apiBase).toBe("http://127.0.0.1:50150");
    expect(parsed.opts.token).toBe("secret");
    expect(parsed.opts.json).toBe(true);
    expect(parsed.opts.timeoutMs).toBe(1234);
    expect(parsed.args).toEqual(["chat", "--stdin", "hello"]);
  });

  it("parses Codex-style runtime flags without consuming the command", () => {
    const parsed = parseGlobalArgs([
      "--approval-mode", "on-request",
      "--sandbox", "workspace-write",
      "exec",
      "hello",
    ], {
      env: { HOME: "/home/test", USERPROFILE: "C:\\Users\\test" },
      stdoutIsTTY: false,
    });

    expect(parsed.opts.approvalMode).toBe("on-request");
    expect(parsed.opts.sandboxMode).toBe("workspace-write");
    expect(parsed.args).toEqual(["exec", "hello"]);
  });

  it("accepts Codex bypass flag as an explicit operate request", () => {
    const parsed = parseGlobalArgs([
      "--yolo",
      "exec",
      "hello",
    ], {
      env: { HOME: "/home/test", USERPROFILE: "C:\\Users\\test" },
      stdoutIsTTY: false,
    });

    expect(parsed.opts.approvalMode).toBe("never");
    expect(parsed.opts.sandboxMode).toBe("danger-full-access");
    expect(parsed.args).toEqual(["exec", "hello"]);
  });

  it("accepts Codex short and compatibility flags", () => {
    const parsed = parseGlobalArgs([
      "-a", "never",
      "-s", "danger-full-access",
      "--full-auto",
      "exec",
      "hello",
    ], {
      env: { HOME: "/home/test", USERPROFILE: "C:\\Users\\test" },
      stdoutIsTTY: false,
    });

    expect(parsed.opts.approvalMode).toBe("never");
    expect(parsed.opts.sandboxMode).toBe("workspace-write");
    expect(parsed.args).toEqual(["exec", "hello"]);
  });

  it("uses GSAP_HOME before legacy home and default home", () => {
    const home = resolveGsapHome({
      GSAP_HOME: "~/custom-gsap",
      HOME: "/home/test",
      USERPROFILE: "C:\\Users\\test",
    }, { platform: "linux" });
    expect(home).toBe(path.resolve("/home/test/custom-gsap"));
  });

  it("normalizes API paths and platform directory names", () => {
    expect(normalizeApiPath("health")).toBe("/api/health");
    expect(normalizeApiPath("/api/health")).toBe("/api/health");
    expect(normalizeApiPath("/ws")).toBe("/ws");
    expect(platformDirName("darwin")).toBe("mac");
    expect(platformDirName("win32")).toBe("win");
    expect(platformDirName("linux")).toBe("linux");
  });

  it("resolves a bundled server from packaged CLI layouts", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-cli-runtime-"));
    try {
      const serverRoot = path.join(tempRoot, "dist-server", "win-x64");
      fs.mkdirSync(path.join(serverRoot, "bundle"), { recursive: true });
      fs.writeFileSync(path.join(serverRoot, "bootstrap.js"), "");
      fs.writeFileSync(path.join(serverRoot, "bundle", "index.js"), "");
      fs.writeFileSync(path.join(serverRoot, "gsap-server.exe"), "");

      const launch = resolveServerLaunchConfig({
        root: tempRoot,
        platform: "win32",
        arch: "x64",
        env: {},
      });

      expect(launch.kind).toBe("bundled");
      expect(launch.root).toBe(serverRoot);
      expect(launch.command).toBe(path.join(serverRoot, "gsap-server.exe"));
      expect(launch.args).toEqual([path.join(serverRoot, "bootstrap.js")]);
      expect(launch.env.GSAP_ROOT).toBe(serverRoot);
      expect(launch.env.GSAP_SERVER_ENTRY).toBe(path.join(serverRoot, "bundle", "index.js"));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
