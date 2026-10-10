// @ts-nocheck
import path from "path";
import { describe, expect, it } from "vitest";
import {
  WIN32_SANDBOX_HELPER_NAME,
  buildWin32CodiaWriteAclCleanupArgs,
  buildWin32LegacyAclDiagnosticArgs,
  buildWin32LegacyProfileCleanupArgs,
  buildWin32SandboxTokenDiagnosticArgs,
  buildWin32SandboxHelperArgs,
  resolveWin32SandboxHelper,
  resourceSiblingDir,
} from "../lib/sandbox/win32-sandbox-helper.js";

describe("win32 sandbox helper wiring", () => {
  it("uses the Codia helper executable name", () => {
    expect(WIN32_SANDBOX_HELPER_NAME).toBe("codia-win-sandbox.exe");
  });

  it("prefers the explicit CODIA helper path", () => {
    const found = new Set([
      "C:\\custom\\codia-win-sandbox.exe",
    ]);
    const existsSync = (p) => found.has(p);

    expect(resolveWin32SandboxHelper({
      env: {
        CODIA_WIN32_SANDBOX_HELPER: "C:\\custom\\codia-win-sandbox.exe",
      },
      existsSync,
    })).toBe("C:\\custom\\codia-win-sandbox.exe");
  });

  it("resolves packaged helper next to the bundled server root", () => {
    const helper = path.join("C:\\app", "resources", "sandbox", "windows", "codia-win-sandbox.exe");
    expect(resolveWin32SandboxHelper({
      env: {},
      resourcesPath: path.join("C:\\app", "resources"),
      existsSync: (p) => p === helper,
    })).toBe(helper);
  });

  it("finds resource sibling directories from CODIA_ROOT", () => {
    const dir = resourceSiblingDir("git", {
      resourcesPath: "",
      env: {
        CODIA_ROOT: "C:\\app\\resources\\server",
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

  it("builds stale Codia write ACL cleanup commands without executable passthrough", () => {
    expect(buildWin32CodiaWriteAclCleanupArgs({ paths: ["C:\\work", "C:\\work", "C:\\data"] }))
      .toEqual([
        "--cleanup-codia-write-acl", "C:\\work",
        "--cleanup-codia-write-acl", "C:\\data",
      ]);
  });

  it("builds token diagnostic args without changing the executable contract", () => {
    expect(buildWin32SandboxTokenDiagnosticArgs({
      cwd: "C:\\work",
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo", "-Command", "Write-Output ok"],
      grants: {
        writePaths: ["C:\\work"],
        optionalWritePaths: ["C:\\Users\\Me\\.codia\\.ephemeral"],
        denyWritePaths: ["C:\\work\\protected-cache"],
      },
    })).toEqual([
      "--diagnose-token",
      "--cwd", "C:\\work",
      "--writable-root", "C:\\work",
      "--writable-root-optional", "C:\\Users\\Me\\.codia\\.ephemeral",
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
      profileNames: ["com.codia.sandbox.1288.475900", "com.codia.sandbox.5104.475988"],
    })).toEqual([
      "--cleanup-legacy-profile", "com.codia.sandbox.1288.475900",
      "--cleanup-legacy-profile", "com.codia.sandbox.5104.475988",
    ]);
  });
});
