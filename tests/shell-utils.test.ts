import { describe, expect, it } from "vitest";
import {
  baseNameForShellPath,
  envValue,
  resolveWin32DefaultPowerShellExecutable,
  isWin32PathLike,
  quoteCmdArg,
  splitShellLikeArgs,
} from "../lib/shell/shell-utils.js";

describe("shell-utils", () => {
  it("reads env values case-insensitively", () => {
    expect(envValue({ Path: "C:\\bin" }, "PATH")).toBe("C:\\bin");
    expect(envValue({ PATH: "C:\\bin" }, "PATH")).toBe("C:\\bin");
  });

  it("handles Windows and POSIX basenames", () => {
    expect(isWin32PathLike("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(true);
    expect(baseNameForShellPath("C:\\Program Files\\Git\\bin\\bash.exe", { stripExe: true })).toBe("bash");
    expect(baseNameForShellPath("/bin/zsh")).toBe("zsh");
  });

  it("splits simple shell-like argv while preserving quoted spaces", () => {
    expect(splitShellLikeArgs('powershell -Command "Write-Output \\"name\\""')).toEqual([
      "powershell",
      "-Command",
      'Write-Output "name"',
    ]);
  });

  it("quotes cmd argv only when needed", () => {
    expect(quoteCmdArg("hello")).toBe("hello");
    expect(quoteCmdArg("hello world")).toBe('"hello world"');
    expect(quoteCmdArg("C:\\work\\run.bat", { always: true })).toBe('"C:\\work\\run.bat"');
  });

  it("prefers a probed PowerShell 7 executable for the Windows default", () => {
    const spawn = (command, args) => {
      if (command === "where.exe" && args[0] === "pwsh.exe") {
        return { status: 0, stdout: "D:\\PowerShell\\7\\pwsh.exe\r\n", stderr: "" };
      }
      if (command === "D:\\PowerShell\\7\\pwsh.exe") {
        return { status: 0, stdout: "7\r\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    };
    expect(resolveWin32DefaultPowerShellExecutable({ SystemRoot: "C:\\Windows" }, {
      spawn,
      exists: () => false,
      cache: false,
    })).toBe("D:\\PowerShell\\7\\pwsh.exe");
  });

  it("falls back to Windows PowerShell 5.1 when pwsh is missing or too old", () => {
    const spawn = (command) => {
      if (command === "where.exe") return { status: 0, stdout: "D:\\PowerShell\\6\\pwsh.exe\r\n", stderr: "" };
      if (command === "D:\\PowerShell\\6\\pwsh.exe") return { status: 0, stdout: "6\r\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    };
    expect(resolveWin32DefaultPowerShellExecutable({ SystemRoot: "C:\\Windows" }, {
      spawn,
      exists: () => false,
      cache: false,
    })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("keeps CODIA_POWERSHELL above automatic pwsh detection", () => {
    expect(resolveWin32DefaultPowerShellExecutable({
      CODIA_POWERSHELL: "E:\\Tools\\pwsh-custom.exe",
      SystemRoot: "C:\\Windows",
    }, {
      spawn: () => { throw new Error("automatic detection should not run"); },
      exists: () => false,
      cache: false,
    })).toBe("E:\\Tools\\pwsh-custom.exe");
  });
});
