import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let runtime;
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-server-runtime-"));
  tempDirs.push(dir);
  return dir;
}

function ensureFile(filePath, contents = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

beforeAll(async () => {
  const mod = await import("../desktop/server-runtime.cjs");
  runtime = mod.default ?? mod;
});

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures in temp workspace.
    }
  }
});

describe("desktop server runtime", () => {
  it("prefers packaged server resources when available", () => {
    const projectRoot = makeTempDir();
    const resourcesPath = makeTempDir();
    ensureFile(path.join(projectRoot, "server", "index.js"), "console.log('source');");
    ensureFile(path.join(resourcesPath, "server", "codia-server.exe"));

    const config = runtime.resolveServerLaunchConfig({
      env: {},
      projectRoot,
      resourcesPath,
      platform: "win32",
      arch: "x64",
      electronExecPath: "C:\\Electron\\electron.exe",
    });

    expect(config.kind).toBe("bundled");
    expect(config.serverBin).toBe(path.join(resourcesPath, "server", "codia-server.exe"));
    expect(config.serverArgs).toEqual([path.join(resourcesPath, "server", "bootstrap.js")]);
    expect(config.serverEnv.CODIA_ROOT).toBe(path.join(resourcesPath, "server"));
    expect(config.serverEnv.CODIA_SERVER_ENTRY).toBe(path.join(resourcesPath, "server", "bundle", "index.js"));
  });

  it("falls back to the legacy packaged server binary during install migration", () => {
    const projectRoot = makeTempDir();
    const resourcesPath = makeTempDir();
    ensureFile(path.join(projectRoot, "server", "index.js"), "console.log('source');");
    ensureFile(path.join(resourcesPath, "server", "codia-server.exe"));

    const config = runtime.resolveServerLaunchConfig({
      env: {},
      projectRoot,
      resourcesPath,
      platform: "win32",
      arch: "x64",
      electronExecPath: "C:\\Electron\\electron.exe",
    });

    expect(config.kind).toBe("bundled");
    expect(config.serverBin).toBe(path.join(resourcesPath, "server", "codia-server.exe"));
    expect(config.serverArgs).toEqual([path.join(resourcesPath, "server", "bootstrap.js")]);
    expect(config.serverEnv.CODIA_ROOT).toBe(path.join(resourcesPath, "server"));
    expect(config.serverEnv.CODIA_SERVER_ENTRY).toBe(path.join(resourcesPath, "server", "bundle", "index.js"));
  });

  it("uses the launch Node runtime for source server in auto mode", () => {
    const projectRoot = makeTempDir();
    const fakeNode = path.join(projectRoot, "tools", "node.exe");
    ensureFile(path.join(projectRoot, "server", "index.js"), "console.log('source');");
    ensureFile(path.join(projectRoot, "dist-server", "win-x64", "codia-server.exe"));
    ensureFile(fakeNode);

    const config = runtime.resolveServerLaunchConfig({
      env: { CODIA_LAUNCH_NODE: fakeNode },
      projectRoot,
      resourcesPath: "",
      platform: "win32",
      arch: "x64",
      electronExecPath: "C:\\Electron\\electron.exe",
    });

    expect(config.kind).toBe("dev-source-node");
    expect(config.serverBin).toBe(fakeNode);
    expect(config.serverArgs).toEqual([path.join(projectRoot, "server", "bootstrap.js")]);
    expect(config.serverEnv.CODIA_ROOT).toBe(projectRoot);
    expect(config.serverEnv.CODIA_SERVER_ENTRY).toBe(path.join(projectRoot, "server", "index.js"));
  });

  it("can force the local dist server in dev mode", () => {
    const projectRoot = makeTempDir();
    const fakeNode = path.join(projectRoot, "tools", "node.exe");
    ensureFile(path.join(projectRoot, "server", "index.js"), "console.log('source');");
    ensureFile(path.join(projectRoot, "dist-server", "win-x64", "codia-server.exe"));
    ensureFile(fakeNode);

    const config = runtime.resolveServerLaunchConfig({
      env: {
        CODIA_LAUNCH_NODE: fakeNode,
        CODIA_DESKTOP_SERVER_MODE: "dist",
      },
      projectRoot,
      resourcesPath: "",
      platform: "win32",
      arch: "x64",
      electronExecPath: "C:\\Electron\\electron.exe",
    });

    expect(config.kind).toBe("dev-dist-server");
    expect(config.serverBin).toBe(path.join(projectRoot, "dist-server", "win-x64", "codia-server.exe"));
    expect(config.serverArgs).toEqual([path.join(projectRoot, "dist-server", "win-x64", "bootstrap.js")]);
    expect(config.serverEnv.CODIA_ROOT).toBe(path.join(projectRoot, "dist-server", "win-x64"));
    expect(config.serverEnv.CODIA_SERVER_ENTRY).toBe(path.join(projectRoot, "dist-server", "win-x64", "bundle", "index.js"));
  });

  it.each(["linux", "win32", "darwin"])("rejects missing forced dist builds on %s instead of falling back to Electron or source Node", (platform) => {
    const projectRoot = makeTempDir();
    const fakeNode = path.join(projectRoot, "tools", "node");
    ensureFile(path.join(projectRoot, "server", "index.ts"));
    ensureFile(path.join(projectRoot, "server", "bootstrap.ts"));
    ensureFile(fakeNode);
    const distRoot = runtime.getDistServerRoot({ projectRoot, platform, arch: "x64" });

    for (const launchNode of [undefined, fakeNode]) {
      expect(() => runtime.resolveServerLaunchConfig({
        env: {
          CODIA_DESKTOP_SERVER_MODE: "dist",
          CODIA_LAUNCH_NODE: launchNode,
          CODIA_LAUNCH_NODE_VERSION: "24.19.0",
        },
        projectRoot,
        resourcesPath: "",
        platform,
        arch: "x64",
        electronExecPath: "/fake/electron",
      })).toThrowError(expect.objectContaining({
        code: "CODIA_DIST_SERVER_MISSING",
        message: expect.stringContaining(distRoot),
      }));
    }
  });

  it("preserves the launch Node and offline controls when applying the source environment overlay", () => {
    const projectRoot = makeTempDir();
    const fakeNode = path.join(projectRoot, "tools", "node");
    ensureFile(path.join(projectRoot, "server", "index.ts"));
    ensureFile(path.join(projectRoot, "server", "bootstrap.ts"));
    ensureFile(fakeNode);
    const env = {
      CODIA_DESKTOP_SERVER_MODE: "source",
      CODIA_LAUNCH_NODE: fakeNode,
      CODIA_LAUNCH_NODE_VERSION: "24.19.0",
      CODIA_HOME: path.join(projectRoot, "isolated-home"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      ELECTRON_RUN_AS_NODE: "1",
    };
    const config = runtime.resolveServerLaunchConfig({
      env,
      projectRoot,
      resourcesPath: "",
      platform: "linux",
      arch: "x64",
      electronExecPath: "/fake/electron",
    });
    // desktop/main.cjs removes Electron mode before applying this overlay.
    const serverEnv = { ...env };
    delete serverEnv.ELECTRON_RUN_AS_NODE;
    Object.assign(serverEnv, config.serverEnv);

    expect(config.kind).toBe("dev-source-node");
    expect(config.serverBin).toBe(fakeNode);
    expect(config.serverArgs).toEqual([path.join(projectRoot, "server", "bootstrap.ts")]);
    expect(serverEnv).toMatchObject({
      CODIA_LAUNCH_NODE: fakeNode,
      CODIA_HOME: env.CODIA_HOME,
      CODIA_SERVER_ENTRY: path.join(projectRoot, "server", "index.ts"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
    expect(serverEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("prepends bundled ffmpeg to PATH for local dist server on Windows", () => {
    const projectRoot = makeTempDir();
    const distRoot = path.join(projectRoot, "dist-server", "win-x64");
    ensureFile(path.join(distRoot, "codia-server.exe"));
    ensureFile(path.join(distRoot, "ffmpeg", "ffmpeg.exe"));

    const config = runtime.resolveServerLaunchConfig({
      env: {
        CODIA_DESKTOP_SERVER_MODE: "dist",
        Path: "C:\\Windows\\System32",
      },
      projectRoot,
      resourcesPath: "",
      platform: "win32",
      arch: "x64",
      electronExecPath: "C:\\Electron\\electron.exe",
    });

    expect(config.kind).toBe("dev-dist-server");
    expect(config.serverEnv).not.toHaveProperty("Path");
    expect(config.serverEnv.PATH.split(";")[0]).toBe(path.join(distRoot, "ffmpeg"));
    expect(config.serverEnv.PATH).toContain("C:\\Windows\\System32");
  });

  it("falls back to Electron Node when no stable dev runtime is available", () => {
    const projectRoot = makeTempDir();
    ensureFile(path.join(projectRoot, "server", "index.js"), "console.log('source');");

    const config = runtime.resolveServerLaunchConfig({
      env: {},
      projectRoot,
      resourcesPath: "",
      platform: "win32",
      arch: "x64",
      electronExecPath: "C:\\Electron\\electron.exe",
    });

    expect(config.kind).toBe("dev-electron-node");
    expect(config.serverBin).toBe("C:\\Electron\\electron.exe");
    expect(config.serverArgs).toEqual([path.join(projectRoot, "server", "bootstrap.js")]);
    expect(config.serverEnv.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(config.serverEnv.CODIA_SERVER_ENTRY).toBe(path.join(projectRoot, "server", "index.js"));
  });
});
