import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CRITICAL_BUNDLED_FILES,
  CRITICAL_BUNDLED_EXTERNALS,
  ensureServerFilesReady,
  extractRootServerStartupError,
  isModuleResolutionError,
  parsePortInUseStartupError,
  SERVER_INFO_FIRST_WAIT_MS,
  SERVER_INFO_MAX_WAIT_MS,
  SERVER_INFO_PROGRESS_GRACE_MS,
  shouldKeepWaitingForServerInfo,
} from "../desktop/src/shared/server-readiness.cjs";

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codia-server-readiness-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writePkg(pkgName) {
  const dir = path.join(tmp, "node_modules", pkgName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkgName }));
}

function writeCriticalFile(fileName) {
  const filePath = path.join(tmp, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
}

function writeAllCriticalFiles() {
  for (const fileName of CRITICAL_BUNDLED_FILES) writeCriticalFile(fileName);
}

describe("ensureServerFilesReady", () => {
  it("returns ok immediately when all critical externals exist", async () => {
    for (const pkg of CRITICAL_BUNDLED_EXTERNALS) writePkg(pkg);
    writeAllCriticalFiles();
    await expect(ensureServerFilesReady(tmp)).resolves.toEqual({ ok: true });
  });

  it("reports all missing packages after retries are exhausted", async () => {
    let sleeps = 0;
    const result = await ensureServerFilesReady(tmp, {
      backoffMs: [1, 1, 1],
      sleep: async () => { sleeps++; },
    });

    expect(result.ok).toBe(false);
    expect(result.missing.sort()).toEqual([
      ...CRITICAL_BUNDLED_FILES,
      ...CRITICAL_BUNDLED_EXTERNALS.map((name) => `node_modules/${name}/package.json`),
    ].sort());
    expect(sleeps).toBe(3);
    expect(typeof result.waitedMs).toBe("number");
  });

  it("returns ok if files land during the backoff window", async () => {
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount++;
      if (sleepCount === 1) {
        for (const pkg of CRITICAL_BUNDLED_EXTERNALS) writePkg(pkg);
        writeAllCriticalFiles();
      }
    };

    const result = await ensureServerFilesReady(tmp, {
      backoffMs: [1, 1, 1],
      sleep,
    });

    expect(result).toEqual({ ok: true });
    expect(sleepCount).toBe(1);
  });

  it("reports only the package that is still missing", async () => {
    for (const pkg of CRITICAL_BUNDLED_EXTERNALS.filter((name) => name !== "ws")) writePkg(pkg);
    writeAllCriticalFiles();

    const result = await ensureServerFilesReady(tmp, {
      backoffMs: [1],
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["node_modules/ws/package.json"]);
  });

  it("reports a missing bootstrap before spawning the bundled server", async () => {
    for (const pkg of CRITICAL_BUNDLED_EXTERNALS) writePkg(pkg);
    for (const fileName of CRITICAL_BUNDLED_FILES.filter((fileName) => fileName !== "bootstrap.js")) {
      writeCriticalFile(fileName);
    }

    const result = await ensureServerFilesReady(tmp, {
      backoffMs: [1],
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["bootstrap.js"]);
  });
});

describe("isModuleResolutionError", () => {
  it("detects ESM package resolution errors", () => {
    expect(isModuleResolutionError([
      "[stderr] Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ws' imported from .../bundle/index.js\n",
    ])).toBe("ws");
  });

  it("detects CJS module resolution errors", () => {
    expect(isModuleResolutionError([
      "[stderr] Error: Cannot find module 'better-sqlite3'\n",
      "[stderr]     at Function.Module._resolveFilename ...\n",
    ])).toBe("better-sqlite3");
  });

  it("falls back to unknown-module when only the Node error code is available", () => {
    expect(isModuleResolutionError(["[stderr] code: 'ERR_MODULE_NOT_FOUND'\n"])).toBe("unknown-module");
  });

  it("ignores unrelated errors", () => {
    expect(isModuleResolutionError(["[stderr] TypeError: foo is not a function\n"])).toBeNull();
    expect(isModuleResolutionError([])).toBeNull();
    expect(isModuleResolutionError(null)).toBeNull();
  });
});

describe("server listen startup diagnostics", () => {
  it("parses structured PORT_IN_USE startup errors from server stderr", () => {
    const parsed = parsePortInUseStartupError([
      '[stderr] [server] startup-error {"code":"PORT_IN_USE","host":"0.0.0.0","port":14500,"networkMode":"lan","listenHost":"0.0.0.0","suggestions":["Close the process using this port."]}\n',
    ]);

    expect(parsed).toMatchObject({
      code: "PORT_IN_USE",
      host: "0.0.0.0",
      port: 14500,
      networkMode: "lan",
      listenHost: "0.0.0.0",
      suggestions: ["Close the process using this port."],
    });
  });

  it("extracts EACCES listen failures as the root server startup error", () => {
    const root = extractRootServerStartupError([
      "[stderr] Error: listen EACCES: permission denied 0.0.0.0:14500\n",
    ]);

    expect(root).toContain("LISTEN_PERMISSION_DENIED");
    expect(root).toContain("0.0.0.0:14500");
  });
});

describe("shouldKeepWaitingForServerInfo", () => {
  it("keeps waiting past the first deadline while a live server still emits progress", () => {
    expect(shouldKeepWaitingForServerInfo({
      nowMs: 100_000,
      startedAtMs: 0,
      firstDeadlineMs: 90_000,
      lastProgressAtMs: 99_000,
      childAlive: true,
    })).toBe(true);
  });

  it("bounds slow startup when the child is gone or progress is stale", () => {
    expect(shouldKeepWaitingForServerInfo({
      nowMs: 100_000,
      startedAtMs: 0,
      firstDeadlineMs: 90_000,
      lastProgressAtMs: 99_000,
      childAlive: false,
    })).toBe(false);
    expect(shouldKeepWaitingForServerInfo({
      nowMs: 300_000,
      startedAtMs: 0,
      firstDeadlineMs: 90_000,
      lastProgressAtMs: 100_000,
      childAlive: true,
      progressGraceMs: 10_000,
    })).toBe(false);
  });

  it("uses the 0.233 server readiness timing floor", () => {
    expect(SERVER_INFO_FIRST_WAIT_MS).toBeGreaterThanOrEqual(90_000);
    expect(SERVER_INFO_PROGRESS_GRACE_MS).toBeGreaterThanOrEqual(180_000);
    expect(SERVER_INFO_MAX_WAIT_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
