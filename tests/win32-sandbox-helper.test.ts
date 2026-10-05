// @ts-nocheck
import path from "path";
import { describe, expect, it } from "vitest";
import {
  WIN32_SANDBOX_HELPER_NAME,
  buildWin32GsapWriteAclCleanupArgs,
  buildWin32LegacyAclDiagnosticArgs,
  buildWin32LegacyProfileCleanupArgs,
  buildWin32SandboxTokenDiagnosticArgs,
  buildWin32SandboxHelperArgs,
  resolveWin32SandboxHelper,
  resourceSiblingDir,
} from "../lib/sandbox/win32-sandbox-helper.js";

describe("win32 sandbox helper wiring", () => {
  it("uses the G-SAP helper executable name", () => {
    expect(WIN32_SANDBOX_HELPER_NAME).toBe("gsap-win-sandbox.exe");
  });

  it("prefers explicit GSAP helper path while keeping legacy env compatibility", () => {
    const found = new Set([
      "C:\\custom\\gsap-win-sandbox.exe",
      "C:\\legacy\\gsap-win-sandbox.exe",
    ]);
    const existsSync = (p) => found.has(p);

    expect(resolveWin32SandboxHelper({
      env: {
        GSAP_WIN32_SANDBOX_HELPER: "C:\\custom\\gsap-win-sandbox.exe",
        HANA_WIN32_SANDBOX_HELPER: "C:\\legacy\\gsap-win-sandbox.exe",
      },
      existsSync,
    })).toBe("C:\\custom\\gsap-win-sandbox.exe");
  });

  it("resolves packaged helper next to the bundled server root", () => {
    const helper = path.join("C:\\app", "resources", "sandbox", "windows", "gsap-win-sandbox.exe");
    expect(resolveWin32SandboxHelper({
      env: {},
      resourcesPath: path.join("C:\\app", "resources"),
      existsSync: (p) => p === helper,
    })).toBe(helper);
  });

  it("finds resource sibling directories from GSAP_ROOT before legacy HANA_ROOT", () => {
    const dir = resourceSiblingDir("git", {
      resourcesPath: "",
      env: {
        GSAP_ROOT: "C:\\app\\resources\\server",
        HANA_ROOT: "D:\\legacy\\server",
      },
    });

    expect(dir).toBe(path.resolve("C:\\app\\resources\\server", "..", "git"));
  });

  it("serializes restricted-token write roots before the executable separator", () => {
    expect(buildWin32SandboxHelperArgs({
      cwd: "C:\\work",
      grants: {
        writePaths: ["C:\\work\\out"],
        optionalWritePaths: ["C:\\cache"],
        denyWritePaths: ["C:\\work\\.git"],
      },
      executable: "C:\\git\\bin\\bash.exe",
      args: ["-c", "pwd"],
    })).toEqual([
      "--cwd", "C:\\work",
      "--writable-root", "C:\\work\\out",
      "--writable-root-optional", "C:\\cache",
      "--deny-write", "C:\\work\\.git",
      "--", "C:\\git\\bin\\bash.exe", "-c", "pwd",
    ]);
  });

  it("builds a legacy AppContainer ACL diagnostic command without executable passthrough", () => {
    expect(buildWin32LegacyAclDiagnosticArgs({
      paths: ["C:\\work", "C:\\data"],
      cleanup: true,
    })).toEqual([
      "--cleanup-legacy-acl",
      "--diagnose-legacy-acl", "C:\\work",
      "--diagnose-legacy-acl", "C:\\data",
    ]);
  });

  it("builds stale G-SAP write ACL cleanup commands without executable passthrough", () => {
    expect(buildWin32GsapWriteAclCleanupArgs({ paths: ["C:\\work", "C:\\work", "C:\\data"] }))
      .toEqual([
        "--cleanup-gsap-write-acl", "C:\\work",
        "--cleanup-gsap-write-acl", "C:\\data",
      ]);
  });

  it("builds token diagnostic args without changing the executable contract", () => {
    expect(buildWin32SandboxTokenDiagnosticArgs({
      cwd: "C:\\work",
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo", "-Command", "Write-Output ok"],
      grants: {
        writePaths: ["C:\\work"],
        optionalWritePaths: ["C:\\Users\\Me\\.gsap\\.ephemeral"],
        denyWritePaths: ["C:\\work\\protected-cache"],
      },
    })).toEqual([
      "--diagnose-token",
      "--cwd", "C:\\work",
      "--writable-root", "C:\\work",
      "--writable-root-optional", "C:\\Users\\Me\\.gsap\\.ephemeral",
      "--deny-write", "C:\\work\\protected-cache",
      "--",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoLogo",
      "-Command",
      "Write-Output ok",
    ]);
  });

  it("builds legacy profile cleanup commands", () => {
    expect(buildWin32LegacyProfileCleanupArgs({
      profileNames: ["com.gsap.sandbox.1288.475900", "com.hanako.sandbox.5104.475988"],
    })).toEqual([
      "--cleanup-legacy-profile", "com.gsap.sandbox.1288.475900",
      "--cleanup-legacy-profile", "com.hanako.sandbox.5104.475988",
    ]);
  });
});
