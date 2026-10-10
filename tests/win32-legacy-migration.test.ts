// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectWin32LegacySandboxMigrationTargets,
  runWin32LegacySandboxMigration,
} from "../lib/sandbox/win32-legacy-migration.js";

function dirent(name, directory = true) {
  return {
    name,
    isDirectory: () => directory,
  };
}

function fakeSpawnFactory({ code = 0, stdout = "", stderr = "" } = {}) {
  return vi.fn((_file, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  });
}

function fakeSpawnSequence(results) {
  const queue = [...results];
  return vi.fn((_file, _args, _opts) => {
    const next = queue.shift() || { code: 0, stdout: "", stderr: "" };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (next.stdout) child.stdout.emit("data", Buffer.from(next.stdout));
      if (next.stderr) child.stderr.emit("data", Buffer.from(next.stderr));
      child.emit("close", next.code ?? 0);
    });
    return child;
  });
}

describe("Windows legacy sandbox migration", () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-win32-migration-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("collects stale Codia and legacy Codia AppContainer profile names", () => {
    const existing = new Set([
      "C:\\Users\\Codia",
      "C:\\Users\\Codia\\.codia",
      "C:\\Users\\Codia\\.codia\\.ephemeral",
      "C:\\Users\\Codia\\.codia\\agents",
      "C:\\Users\\Codia\\.codia\\session-files",
      "C:\\Users\\Codia\\.codia\\uploads",
      "C:\\Program Files\\Codia\\resources",
      "C:\\Program Files\\Codia\\resources\\git",
      "D:\\workspace",
      "C:\\Users\\Codia\\AppData\\Local\\Packages",
    ]);
    const readdirSync = vi.fn((target) => {
      if (target === "C:\\Users\\Codia\\AppData\\Local\\Packages") {
        return [
          dirent("com.codia.sandbox.1288.475900"),
          dirent("com.codia.sandbox.5104.475988"),
          dirent("Microsoft.WindowsCalculator_8wekyb3d8bbwe"),
          dirent("com.codia.sandbox.file", false),
        ];
      }
      return [];
    });

    const targets = collectWin32LegacySandboxMigrationTargets({
      platform: "win32",
      codiaHome: "C:\\Users\\Codia\\.codia",
      workspaceRoots: ["D:\\workspace"],
      env: {
        USERPROFILE: "C:\\Users\\Codia",
        LOCALAPPDATA: "C:\\Users\\Codia\\AppData\\Local",
      },
      resourcesPath: "C:\\Program Files\\Codia\\resources",
      existsSync: (target) => existing.has(target),
      readdirSync,
      homedir: () => "C:\\Users\\Codia",
    });

    expect(targets.aclPaths).toEqual([
      "C:\\Users\\Codia\\.codia",
      "C:\\Users\\Codia\\.codia\\.ephemeral",
      "C:\\Users\\Codia\\.codia\\agents",
      "C:\\Users\\Codia\\.codia\\session-files",
      "C:\\Users\\Codia\\.codia\\uploads",
      "D:\\workspace",
      "C:\\Program Files\\Codia\\resources",
      "C:\\Program Files\\Codia\\resources\\git",
      "C:\\Users\\Codia",
    ]);
    expect(targets.profileNames).toEqual([
      "com.codia.sandbox.1288.475900",
      "com.codia.sandbox.5104.475988",
    ]);
  });

  it("runs cleanup through the Codia helper and writes a completion marker", async () => {
    const markerPath = path.join(makeTempDir(), "marker.json");
    const spawn = fakeSpawnSequence([
      {
        code: 3,
        stderr: "codia-win-sandbox: legacy-appcontainer-acl path=\"C:\\\\\" sid=\"S-1-15-2-1\"",
      },
      { code: 0 },
    ]);

    const result = await runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Codia\\codia-win-sandbox.exe",
      markerPath,
      targets: {
        aclPaths: ["C:\\"],
        profileNames: ["com.codia.sandbox.1288.475900"],
      },
      spawn,
    });

    expect(result.status).toBe("findings");
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "C:\\Codia\\codia-win-sandbox.exe",
      [
        "--cleanup-codia-write-acl",
        "C:\\",
        "--legacy-appcontainer-profile",
        "com.codia.sandbox.1288.475900",
        "--cleanup-legacy-acl",
        "--diagnose-legacy-acl",
        "C:\\",
      ],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "C:\\Codia\\codia-win-sandbox.exe",
      [
        "--cleanup-legacy-profile",
        "com.codia.sandbox.1288.475900",
      ],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it("does not delete legacy profiles when ACL cleanup fails", async () => {
    const spawn = fakeSpawnFactory({
      code: 1,
      stderr: "codia-win-sandbox: cannot clean legacy ACL",
    });

    const result = await runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Codia\\codia-win-sandbox.exe",
      markerPath: path.join(makeTempDir(), "marker.json"),
      targets: {
        aclPaths: ["C:\\work"],
        profileNames: ["com.codia.sandbox.1288.475900"],
      },
      spawn,
    });

    expect(result.status).toBe("failed");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).not.toContain("--cleanup-legacy-profile");
  });

  it("skips once the cleanup marker has been written", async () => {
    const markerPath = path.join(makeTempDir(), "marker.json");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 2,
      status: "completed",
      completedAt: "2026-05-21T00:00:00.000Z",
    }));
    const spawn = vi.fn();

    const result = await runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Codia\\codia-win-sandbox.exe",
      markerPath,
      targets: {
        aclPaths: ["C:\\work"],
        profileNames: ["com.codia.sandbox.1288.475900"],
      },
      spawn,
    });

    expect(result).toMatchObject({ status: "skipped", reason: "already-completed" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("maps helper exit codes and startup failures to stable statuses", async () => {
    const base = {
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Codia\\codia-win-sandbox.exe",
      targets: { aclPaths: ["C:\\work"], profileNames: [] },
    };

    await expect(runWin32LegacySandboxMigration({
      ...base,
      markerPath: path.join(makeTempDir(), "clean.json"),
      spawn: fakeSpawnFactory({ code: 0 }),
    })).resolves.toMatchObject({ status: "clean", exitCode: 0 });

    await expect(runWin32LegacySandboxMigration({
      ...base,
      markerPath: path.join(makeTempDir(), "failed.json"),
      spawn: fakeSpawnFactory({ code: 1, stderr: "failed" }),
    })).resolves.toMatchObject({ status: "failed", exitCode: 1 });

    await expect(runWin32LegacySandboxMigration({
      ...base,
      markerPath: path.join(makeTempDir(), "empty.json"),
      targets: { aclPaths: [], profileNames: [] },
      spawn: vi.fn(),
    })).resolves.toMatchObject({ status: "clean", exitCode: 0 });
  });

  it("reports timed out and spawn-error helpers as failed", async () => {
    const timeoutSpawn = vi.fn((_file, _args, _opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      return child;
    });

    await expect(runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Codia\\codia-win-sandbox.exe",
      markerPath: path.join(makeTempDir(), "timeout.json"),
      timeoutMs: 1,
      targets: { aclPaths: ["C:\\work"], profileNames: [] },
      spawn: timeoutSpawn,
    })).resolves.toMatchObject({ status: "failed", timedOut: true, error: "timeout" });

    await expect(runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Codia\\codia-win-sandbox.exe",
      markerPath: path.join(makeTempDir(), "spawn-error.json"),
      targets: { aclPaths: ["C:\\work"], profileNames: [] },
      spawn: vi.fn(() => { throw new Error("spawn boom"); }),
    })).resolves.toMatchObject({ status: "failed", error: "spawn boom" });
  });

  it("skips cleanly on non-Windows and when the packaged helper is absent", async () => {
    await expect(runWin32LegacySandboxMigration({ platform: "darwin" }))
      .resolves.toMatchObject({ status: "skipped", reason: "platform" });

    await expect(runWin32LegacySandboxMigration({
      platform: "win32",
      resolveHelper: () => null,
    })).resolves.toMatchObject({ status: "skipped", reason: "helper-unavailable" });
  });
});
