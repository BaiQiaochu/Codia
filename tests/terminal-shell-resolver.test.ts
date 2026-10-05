import { describe, expect, it, vi } from "vitest";

import { resolveTerminalShell } from "../lib/terminal/shell-resolver.js";
import { resolveWin32DefaultPowerShellExecutable } from "../lib/shell/shell-utils.js";

describe("resolveTerminalShell", () => {
  it("uses the user shell for macOS one-shot terminal commands", () => {
    expect(resolveTerminalShell("npm run dev", {
      platform: "darwin",
      env: { SHELL: "/bin/zsh" },
    })).toEqual({
      file: "/bin/zsh",
      args: ["-lc", "npm run dev"],
      env: undefined,
    });
  });

  it("uses PowerShell for Windows interactive terminals", () => {
    const resolveWin32ShellRuntime = vi.fn();
    const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe" };

    const resolved = resolveTerminalShell("", {
      platform: "win32",
      env,
      resolveWin32ShellRuntime,
    });

    expect(resolved).toEqual({
      file: resolveWin32DefaultPowerShellExecutable(env),
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"],
      env,
    });
    expect(resolveWin32ShellRuntime).not.toHaveBeenCalled();
  });

  it("does not wrap explicit PowerShell one-shots in cmd.exe", () => {
    const resolveWin32ShellRuntime = vi.fn();

    const resolved = resolveTerminalShell('powershell -Command "Write-Output \\"name\\""', {
      platform: "win32",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      resolveWin32ShellRuntime,
    });

    expect(resolved.file).toBe("powershell.exe");
    expect(resolved.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      'Write-Output "name"',
    ]);
    expect(resolved.args.join(" ")).not.toContain("cmd.exe");
    expect(resolveWin32ShellRuntime).not.toHaveBeenCalled();
  });

  it("routes Windows batch scripts through cmd.exe", () => {
    const resolved = resolveTerminalShell("C:\\work\\run-tests.bat --fast", {
      platform: "win32",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    });

    expect(resolved).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", 'call "C:\\work\\run-tests.bat" --fast'],
      env: undefined,
    });
  });

  it("uses an explicit Git Bash profile when requested", () => {
    const shellInfo = {
      shell: "C:\\G-SAP\\resources\\git\\bin\\bash.exe",
      args: ["-lc"],
      bundledRoot: "C:\\G-SAP\\resources\\git",
    };
    const shellEnv = { Path: "C:\\G-SAP\\resources\\git\\bin;C:\\Windows\\System32" };
    const resolveWin32ShellRuntime = vi.fn(() => shellInfo);
    const getWin32ShellEnvForRuntime = vi.fn(() => shellEnv);

    const resolved = resolveTerminalShell('codex exec "hello world from gsap"', {
      platform: "win32",
      profile: "git-bash",
      env: { Path: "C:\\Windows\\System32" },
      resolveWin32ShellRuntime,
      getWin32ShellEnvForRuntime,
    });

    expect(resolved).toEqual({
      file: shellInfo.shell,
      args: ["-lc", 'codex exec "hello world from gsap"'],
      env: shellEnv,
    });
    expect(resolveWin32ShellRuntime).toHaveBeenCalledWith({
      preferBundled: true,
      env: { Path: "C:\\Windows\\System32" },
    });
    expect(getWin32ShellEnvForRuntime).toHaveBeenCalledWith(
      { Path: "C:\\Windows\\System32" },
      shellInfo,
    );
  });

  it("keeps Linux interactive terminal behavior on the user shell", () => {
    expect(resolveTerminalShell("", {
      platform: "linux",
      env: { SHELL: "/bin/bash" },
    })).toEqual({
      file: "/bin/bash",
      args: ["-i"],
      env: undefined,
    });
  });
});
