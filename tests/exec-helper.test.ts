// @ts-nocheck
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { spawnAndStream } from "../lib/sandbox/exec-helper.js";

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("child_process");
  vi.resetModules();
});

describe("spawnAndStream", () => {
  it("settles after direct child exit when stdio pipes remain open", async () => {
    vi.useFakeTimers();

    let child;
    vi.doMock("child_process", () => ({
      spawn: vi.fn(() => {
        child = new EventEmitter();
        child.pid = 12345;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout.destroy = vi.fn();
        child.stderr.destroy = vi.fn();
        return child;
      }),
    }));

    const { spawnAndStream: mockedSpawnAndStream } = await import("../lib/sandbox/exec-helper.js?mocked-exit");
    const resultPromise = mockedSpawnAndStream("node", ["fixture"], {
      cwd: process.cwd(),
      env: process.env,
      onData: vi.fn(),
      timeout: 5,
    });

    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(99);

    let settled = false;
    resultPromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toEqual({ exitCode: 0 });
    expect(child.stdout.destroy).toHaveBeenCalled();
    expect(child.stderr.destroy).toHaveBeenCalled();
  });

  it("returns when the direct child exits even if a background descendant still holds stdio", async () => {
    const holdInheritedStdioMs = 1800;
    const fixture = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, [
        "-e",
        "setTimeout(() => {}, ${holdInheritedStdioMs})",
      ], {
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      });
      child.unref();
      process.stdout.write("parent-exit\\\\n");
    `;

    const chunks = [];
    const startedAt = performance.now();
    const result = await spawnAndStream(process.execPath, ["-e", fixture], {
      cwd: process.cwd(),
      env: process.env,
      onData: (data) => chunks.push(Buffer.from(data).toString("utf8")),
      timeout: 5,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("parent-exit");
    expect(elapsedMs).toBeLessThan(900);
  }, 7000);
});
