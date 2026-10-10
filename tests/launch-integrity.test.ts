// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const root = process.cwd();
const helperPath = path.join(root, "desktop", "src", "shared", "launch-integrity.cjs");
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-launch-integrity-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(rootDir, relativePath, content = "") {
  const filePath = path.join(rootDir, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function loadHelper() {
  expect(fs.existsSync(helperPath)).toBe(true);
  if (!fs.existsSync(helperPath)) return null;
  return require(helperPath);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktop launch integrity helper", () => {
  it("covers the Windows install surface needed before desktop main loads", () => {
    const helper = loadHelper();
    if (!helper) return;

    const tmp = makeTempDir();
    const resourcesPath = path.join(tmp, "resources");
    const result = helper.checkWindowsInstallSurface({
      execPath: path.join(tmp, "Codia.exe"),
      resourcesPath,
    });

    expect(result.ok).toBe(false);
    expect(result.missing.map(item => item.id)).toEqual([
      "codia-exe",
      "desktop-app",
      "server-exe",
      "server-bootstrap",
      "server-bundle",
      "better-sqlite3-native",
      "portable-git",
    ]);
    expect(result.missing.map(item => item.relativePath)).toEqual([
      "desktop application executable",
      "resources/app.asar or resources/app",
      "resources/server/codia-server.exe or resources/server/codia-server.exe",
      "resources/server/bootstrap.js",
      "resources/server/bundle/index.js",
      "resources/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "resources/git",
    ]);
  });

  it("accepts a complete packaged Windows install surface", () => {
    const helper = loadHelper();
    if (!helper) return;

    const tmp = makeTempDir();
    const resourcesPath = path.join(tmp, "resources");
    writeFile(tmp, "Codia.exe");
    writeFile(resourcesPath, "app.asar");
    writeFile(resourcesPath, "server/codia-server.exe");
    writeFile(resourcesPath, "server/bootstrap.js");
    writeFile(resourcesPath, "server/bundle/index.js");
    writeFile(resourcesPath, "server/node_modules/better-sqlite3/build/Release/better_sqlite3.node");
    writeFile(resourcesPath, "git/cmd/git.exe");
    writeFile(resourcesPath, "git/mingw64/bin/busybox.exe");

    const result = helper.checkWindowsInstallSurface({
      execPath: path.join(tmp, "Codia.exe"),
      resourcesPath,
    });

    expect(result).toMatchObject({ ok: true, missing: [] });
  });

  it("accepts the legacy renamed bundled server binary during install migration", () => {
    const helper = loadHelper();
    if (!helper) return;

    const tmp = makeTempDir();
    const resourcesPath = path.join(tmp, "resources");
    writeFile(tmp, "Codia.exe");
    writeFile(resourcesPath, "app.asar");
    writeFile(resourcesPath, "server/codia-server.exe");
    writeFile(resourcesPath, "server/bootstrap.js");
    writeFile(resourcesPath, "server/bundle/index.js");
    writeFile(resourcesPath, "server/node_modules/better-sqlite3/build/Release/better_sqlite3.node");
    writeFile(resourcesPath, "git/cmd/git.exe");
    writeFile(resourcesPath, "git/usr/bin/bash.exe");

    const result = helper.checkWindowsInstallSurface({
      execPath: path.join(tmp, "Codia.exe"),
      resourcesPath,
    });

    expect(result).toMatchObject({ ok: true, missing: [] });
    expect(result.checked.find(item => item.id === "server-exe").exists).toBe(true);
  });

  it("accepts an unpacked packaged app payload when app.asar is absent", () => {
    const helper = loadHelper();
    if (!helper) return;

    const tmp = makeTempDir();
    const resourcesPath = path.join(tmp, "resources");
    const appPath = path.join(resourcesPath, "app");
    writeFile(tmp, "Codia.exe");
    writeFile(appPath, "package.json", JSON.stringify({ main: "desktop/bootstrap.cjs" }));
    writeFile(appPath, "desktop/bootstrap.cjs");
    writeFile(appPath, "desktop/main.bundle.cjs");
    writeFile(appPath, "desktop/preload.bundle.cjs");
    writeFile(appPath, "desktop/dist-renderer/index.html");
    writeFile(resourcesPath, "server/codia-server.exe");
    writeFile(resourcesPath, "server/bootstrap.js");
    writeFile(resourcesPath, "server/bundle/index.js");
    writeFile(resourcesPath, "server/node_modules/better-sqlite3/build/Release/better_sqlite3.node");
    writeFile(resourcesPath, "git/cmd/git.exe");
    writeFile(resourcesPath, "git/usr/bin/bash.exe");

    const result = helper.checkWindowsInstallSurface({
      execPath: path.join(tmp, "Codia.exe"),
      resourcesPath,
      appPath,
    });

    expect(result).toMatchObject({ ok: true, missing: [] });
    expect(result.checked.find(item => item.id === "desktop-app").exists).toBe(true);
  });

  it("writes a launch diagnostic file with the failed self-check payload", () => {
    const helper = loadHelper();
    if (!helper) return;

    const tmp = makeTempDir();
    const diagnosticsDir = path.join(tmp, "diagnostics");
    const result = helper.checkWindowsInstallSurface({
      execPath: path.join(tmp, "Codia.exe"),
      resourcesPath: path.join(tmp, "resources"),
    });

    const filePath = helper.writeLaunchDiagnostic({
      diagnosticsDir,
      fileName: "install-surface-check.json",
      event: "install-surface-check-failed",
      payload: result,
    });

    expect(filePath).toBe(path.join(diagnosticsDir, "install-surface-check.json"));
    const written = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(written.event).toBe("install-surface-check-failed");
    expect(written.payload.ok).toBe(false);
    expect(written.payload.missing[0].id).toBe("codia-exe");
  });
});

describe("launch integrity fs resolution", () => {
  it("prefers original-fs so Electron's asar-patched fs cannot mask app.asar", () => {
    const helper = loadHelper();
    if (!helper) return;

    const originalFs = { tag: "original-fs" };
    const nodeFs = { tag: "fs" };
    const fakeRequire = (id) => {
      if (id === "original-fs") return originalFs;
      if (id === "fs") return nodeFs;
      throw new Error(`unexpected require id: ${id}`);
    };

    expect(helper.resolveRealFs(fakeRequire)).toBe(originalFs);
  });

  it("falls back to fs outside Electron when original-fs is unavailable", () => {
    const helper = loadHelper();
    if (!helper) return;

    const nodeFs = { tag: "fs" };
    const fakeRequire = (id) => {
      if (id === "original-fs") {
        const err = new Error("Cannot find module 'original-fs'");
        err.code = "MODULE_NOT_FOUND";
        throw err;
      }
      if (id === "fs") return nodeFs;
      throw new Error(`unexpected require id: ${id}`);
    };

    expect(helper.resolveRealFs(fakeRequire)).toBe(nodeFs);
  });

  it("loads module fs through resolveRealFs rather than a bare fs require", () => {
    const source = fs.readFileSync(helperPath, "utf-8");

    expect(source).toContain("original-fs");
    expect(source).toMatch(/=\s*resolveRealFs\(\)/);
    expect(source).not.toMatch(/^const fs = require\("fs"\);/m);
  });
});
