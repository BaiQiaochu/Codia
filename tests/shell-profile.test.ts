// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { profileLabel, resolveShellProfile } from "../lib/shell/shell-profile.js";
import { resolveWin32DefaultPowerShellExecutable } from "../lib/shell/shell-utils.js";

describe("resolveShellProfile", () => {
  it("uses the user shell for POSIX command profiles", () => {
    const profile = resolveShellProfile({
      platform: "darwin",
      env: { SHELL: "/opt/homebrew/bin/fish" },
    });

    expect(profile.executable).toBe("/opt/homebrew/bin/fish");
    expect(profile.argsForCommand("npm test")).toEqual(["-lc", "npm test"]);
    expect(profile.argsForInteractive()).toEqual(["-i"]);
    expect(profileLabel(profile)).toBe("fish");
  });

  it("defaults Windows profiles to PowerShell", () => {
    const env = { SystemRoot: "C:\\Windows" };
    const profile = resolveShellProfile({
      platform: "win32",
      env,
    });

    expect(profile.family).toBe("powershell");
    expect(profile.executable).toBe(resolveWin32DefaultPowerShellExecutable(env));
    expect(profile.argsForCommand("Write-Output ok")).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Write-Output ok",
    ]);
    expect(["powershell", "pwsh"]).toContain(profileLabel(profile));
  });

  it("keeps an explicit pwsh profile separate from the Windows PowerShell profile", () => {
    const profile = resolveShellProfile({
      platform: "win32",
      profile: "pwsh",
      env: { SystemRoot: "C:\\Windows" },
    });
    expect(profile.id).toBe("windows-powershell");
    expect(profile.family).toBe("powershell");
    expect(profile.executable).toBe("pwsh.exe");
    expect(profileLabel(profile)).toBe("pwsh");
  });

  it("resolves explicit Git Bash through the Windows runtime resolver", () => {
    const shellInfo = {
      shell: "C:\\G-SAP\\resources\\git\\bin\\bash.exe",
      args: ["-lc"],
      bundledRoot: "C:\\G-SAP\\resources\\git",
    };
    const shellEnv = { Path: "C:\\G-SAP\\resources\\git\\bin;C:\\Windows\\System32" };
    const resolveWin32ShellRuntime = vi.fn(() => shellInfo);
    const getWin32ShellEnvForRuntime = vi.fn(() => shellEnv);

    const profile = resolveShellProfile({
      platform: "win32",
      profile: "git-bash",
      env: { Path: "C:\\Windows\\System32" },
      resolveWin32ShellRuntime,
      getWin32ShellEnvForRuntime,
    });

    expect(profile.family).toBe("posix");
    expect(profile.executable).toBe(shellInfo.shell);
    expect(profile.argsForCommand("pwd")).toEqual(["-lc", "pwd"]);
    expect(profile.env).toBe(shellEnv);
    expect(resolveWin32ShellRuntime).toHaveBeenCalledWith({
      preferBundled: true,
      env: { Path: "C:\\Windows\\System32" },
    });
  });
});
