// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const spawnAndStream = vi.fn(async () => ({ exitCode: 0 }));
const classifyWin32Command = vi.fn();
const existsSync = vi.fn(() => false);
const spawnSync = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }));
const buildWin32SandboxGrants = vi.fn(() => ({ readPaths: [], writePaths: [], denyWritePaths: [] }));
const resolveWin32SandboxHelper = vi.fn(() => null);
const assertExecutionCwd = vi.fn((cwd) => cwd);

vi.mock("../lib/sandbox/exec-helper.js", () => ({
  spawnAndStream,
}));

vi.mock("../lib/sandbox/win32-command-router.js", () => ({
  classifyWin32Command,
}));

vi.mock("../lib/sandbox/win32-policy.js", () => ({
  buildWin32SandboxGrants,
}));

vi.mock("../lib/sandbox/win32-sandbox-helper.js", () => ({
  buildWin32SandboxHelperArgs: ({ cwd, grants, executable, args }) => [
    "--cwd", cwd,
    ...((grants.writePaths || []).flatMap((p) => ["--writable-root", p])),
    ...((grants.optionalWritePaths || []).flatMap((p) => ["--writable-root-optional", p])),
    ...((grants.denyWritePaths || []).flatMap((p) => ["--deny-write", p])),
    "--", executable, ...args,
  ],
  resolveWin32SandboxHelper,
  resourceSiblingDir: () => null,
}));

vi.mock("../lib/shell/execution-cwd.js", () => ({
  assertExecutionCwd,
}));

vi.mock("fs", () => ({
  existsSync,
}));

vi.mock("child_process", () => ({
  spawnSync,
}));

async function loadExecFactory() {
  const mod = await import("../lib/sandbox/win32-exec.js");
  return mod.createWin32Exec;
}

describe("createWin32Exec", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    existsSync.mockReturnValue(false);
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
    buildWin32SandboxGrants.mockReturnValue({ readPaths: [], writePaths: [], denyWritePaths: [] });
    resolveWin32SandboxHelper.mockReturnValue(null);
    assertExecutionCwd.mockImplementation((cwd) => cwd);
  });

  it("routes Windows native commands through cmd.exe", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ipconfig /all", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      expect.stringMatching(/cmd\.exe$/i),
      ["/d", "/s", "/c", "chcp 65001 >NUL & ipconfig /all"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("rejects invalid cwd before command routing or spawn", async () => {
    const error = Object.assign(new Error("Working directory does not exist: C:\\gone"), {
      code: "GSAP_EXEC_CWD_MISSING",
      cwd: "C:\\gone",
    });
    assertExecutionCwd.mockImplementation(() => {
      throw error;
    });
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await expect(exec("ipconfig /all", "C:\\gone", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toMatchObject({ code: "GSAP_EXEC_CWD_MISSING", cwd: "C:\\gone" });

    expect(classifyWin32Command).not.toHaveBeenCalled();
    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("adds Windows UTF-8 defaults while preserving explicit Python settings", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("type sample.txt", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        PYTHONUTF8: "0",
      },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      expect.stringMatching(/cmd\.exe$/i),
      ["/d", "/s", "/c", "chcp 65001 >NUL & type sample.txt"],
      expect.objectContaining({
        env: expect.objectContaining({
          PYTHONUTF8: "0",
          PYTHONIOENCODING: "utf-8",
          LANG: "C.UTF-8",
        }),
      }),
    );
  });

  it("routes explicit PowerShell commands directly without cmd wrapping", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell", reason: "explicit-powershell-shell" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec('powershell -Command "Write-Output \\"name\\""', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      expect.stringMatching(/powershell\.exe$/i),
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        'Write-Output "name"',
      ],
      expect.objectContaining({ cwd: "C:\\work" }),
    );
  });

  it("routes PowerShell script files through -File with argv", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-file", reason: "powershell-script-file" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec('"C:\\work\\run tests.ps1" -Name Gsap', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      expect.stringMatching(/powershell\.exe$/i),
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\work\\run tests.ps1",
        "-Name",
        "Gsap",
      ],
      expect.objectContaining({ cwd: "C:\\work" }),
    );
  });

  it("routes batch scripts through cmd call without bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd-script", reason: "cmd-script-file" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("C:\\work\\run-tests.bat --fast", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      expect.stringMatching(/cmd\.exe$/i),
      ["/d", "/s", "/c", 'chcp 65001 >NUL & call "C:\\work\\run-tests.bat" --fast'],
      expect.objectContaining({ cwd: "C:\\work" }),
    );
  });

  it("keeps bash-routed commands on the bash fallback path", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === "C:\\mock\\bash.exe");
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "bash.exe") {
        return { status: 0, stdout: "C:\\mock\\bash.exe\r\n", stderr: "" };
      }
      if (cmd === "C:\\mock\\bash.exe" && args?.[0] === "-c") {
        return { status: 0, stdout: "__gsap_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ls && pwd", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "C:\\mock\\bash.exe",
      ["-c", "ls && pwd"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("prefers bundled MinGit ash over system shell lookup", async () => {
    const bundledAsh = path.join(process.cwd(), "vendor", "git-portable", "mingw64", "bin", "ash.exe");
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === bundledAsh);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledAsh && args?.[0] === "-c") {
        return { status: 0, stdout: "__gsap_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("git status", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      bundledAsh,
      ["-c", "git status"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
    expect(spawnSync).not.toHaveBeenCalledWith("where", expect.anything(), expect.anything());
  });

  it("routes git commands through bundled git.exe when available", async () => {
    const bundledGit = path.join(process.cwd(), "vendor", "git-portable", "cmd", "git.exe");
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    existsSync.mockImplementation((p) => p === bundledGit);

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("git status --short", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      bundledGit,
      ["status", "--short"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes cmd commands through the restricted-token helper when sandbox is enabled", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    resolveWin32SandboxHelper.mockReturnValue("C:\\app\\sandbox\\windows\\gsap-win-sandbox.exe");
    buildWin32SandboxGrants.mockReturnValue({ readPaths: ["C:\\work"], writePaths: ["C:\\work"], denyWritePaths: [] });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({ sandbox: { policy: { mode: "standard" } } });

    await exec("ipconfig /all", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "C:\\app\\sandbox\\windows\\gsap-win-sandbox.exe",
      expect.arrayContaining(["--cwd", "C:\\work", "--writable-root", "C:\\work", "--", expect.stringMatching(/cmd\.exe$/i), "/d", "/s", "/c", "chcp 65001 >NUL & ipconfig /all"]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("does not pass network capability flags to the restricted-token helper", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    resolveWin32SandboxHelper.mockReturnValue("C:\\app\\sandbox\\windows\\gsap-win-sandbox.exe");
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        policy: { mode: "standard" },
        getSandboxNetworkEnabled: () => true,
      },
    });

    await exec("ipconfig /all", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).not.toContain("--network");
    expect(spawnAndStream).toHaveBeenCalledWith(
      "C:\\app\\sandbox\\windows\\gsap-win-sandbox.exe",
      helperArgs,
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("rejects sandboxed commands when Windows sandbox networking is explicitly disabled", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    resolveWin32SandboxHelper.mockReturnValue("C:\\app\\sandbox\\windows\\gsap-win-sandbox.exe");
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        policy: { mode: "standard" },
        getSandboxNetworkEnabled: () => false,
      },
    });

    await expect(exec("ipconfig /all", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toThrow("does not support network-off mode");

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("runs bash commands through the restricted-token helper with write roots only", async () => {
    const bundledAsh = path.join(process.cwd(), "vendor", "git-portable", "mingw64", "bin", "ash.exe");
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === bundledAsh);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledAsh && args?.[0] === "-c") {
        return { status: 0, stdout: "__gsap_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    resolveWin32SandboxHelper.mockReturnValue("C:\\app\\sandbox\\windows\\gsap-win-sandbox.exe");
    buildWin32SandboxGrants.mockImplementation(() => ({
      readPaths: [],
      writePaths: ["C:\\work"],
      denyWritePaths: [],
    }));
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({ sandbox: { policy: { mode: "standard" } } });

    await exec("git status", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "C:\\app\\sandbox\\windows\\gsap-win-sandbox.exe",
      expect.arrayContaining(["--writable-root", "C:\\work", "--", bundledAsh, "-c", "git status"]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(buildWin32SandboxGrants).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "C:\\work",
    }));
  });

  it("does not project sandboxed Python runtime paths as helper grants", async () => {
    classifyWin32Command.mockReturnValue({ runner: "python", reason: "python-command" });
    const pythonExe = "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311\\python.exe";
    const pythonRoot = "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311";
    resolveWin32SandboxHelper.mockReturnValue("C:\\app\\sandbox\\windows\\gsap-win-sandbox.exe");
    existsSync.mockImplementation((p) => p === pythonExe || p === pythonRoot);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "python") {
        return { status: 0, stdout: `${pythonExe}\r\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({ sandbox: { policy: { mode: "standard" } } });

    await exec("python tools\\make_doc.py", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: `${pythonRoot};C:\\Windows\\System32` },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "C:\\app\\sandbox\\windows\\gsap-win-sandbox.exe",
      expect.arrayContaining(["--", pythonExe, "tools\\make_doc.py"]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).not.toContain("--grant-write-optional");
    expect(helperArgs).not.toContain(pythonRoot);
  });
});
