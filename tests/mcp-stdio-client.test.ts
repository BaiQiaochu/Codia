// @ts-nocheck
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  McpStdioClient,
  resolveMcpStdioSpawnSpec,
} from "../plugins/mcp/lib/mcp-stdio-client.js";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = {
      // A well-behaved MCP server exits when its stdin reaches EOF.
      end: vi.fn(() => {
        if (this.exitCode == null) {
          this.exitCode = 0;
          queueMicrotask(() => this.emit("exit", 0, null));
        }
      }),
      write: vi.fn((line) => {
        const message = JSON.parse(String(line));
        if (message.id == null) return true;
        queueMicrotask(() => {
          this.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-11-25", capabilities: {} },
          })}\n`);
        });
        return true;
      }),
    };
    this.kill = vi.fn(() => {
      this.exitCode = 0;
      this.emit("exit", 0);
    });
  }
}

describe("MCP stdio client", () => {
  it("passes connector env and registry settings to spawned stdio servers", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);

    const client = new McpStdioClient({
      id: "local",
      command: "npx",
      args: ["-y", "mcp-server-example"],
      env: { API_KEY: "secret" },
      registryUrl: "https://registry.npmmirror.com",
      resolveWindowsShims: false,
    }, { log: console });

    await client.start();

    expect(spawnMock).toHaveBeenCalledWith(
      "npx",
      ["-y", "mcp-server-example"],
      expect.objectContaining({
        env: expect.objectContaining({
          API_KEY: "secret",
          NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com",
        }),
        windowsHide: true,
      }),
    );

    await client.stop();
  });

  it("resolves Windows command shims by default when starting stdio clients", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const proc = new FakeProcess();
      spawnMock.mockReturnValueOnce(proc);
      const client = new McpStdioClient({
        id: "local-win",
        command: "C:\\Program Files\\nodejs\\npx.cmd",
        args: ["-y", "mcp-server-example"],
      }, { log: console });

      await client.start();

      expect(spawnMock).toHaveBeenCalledWith(
        String(process.env.ComSpec || process.env.COMSPEC || "cmd.exe"),
        [
          "/d",
          "/s",
          "/c",
          "\"C:\\Program Files\\nodejs\\npx.cmd\" -y mcp-server-example",
        ],
        expect.objectContaining({
          shell: false,
          windowsHide: true,
        }),
      );

      await client.stop();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("fires onClose with expected=false when the child exits unexpectedly", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);
    const onClose = vi.fn();

    const client = new McpStdioClient({
      id: "local",
      command: "npx",
      args: ["-y", "mcp-server-example"],
    }, { log: console, onClose });

    await client.start();
    expect(client.running).toBe(true);

    // Child dies on its own (crash / killed by OS), not via stop().
    proc.exitCode = 1;
    proc.emit("exit", 1, null);

    expect(client.running).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: false }));
  });

  it("reports an unexpected stdio process shutdown only once when error and exit both fire", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);
    const onClose = vi.fn();

    const client = new McpStdioClient({
      id: "double-close",
      command: "npx",
      args: ["-y", "mcp-server-example"],
    }, { log: console, onClose });

    await client.start();
    proc.emit("error", new Error("spawn failed"));
    proc.exitCode = 1;
    proc.emit("exit", 1, null);

    expect(client.running).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({
      id: "double-close",
      expected: false,
      reason: "spawn failed",
    }));
  });

  it("does not report an unexpected close when stop() terminates the child", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);
    const onClose = vi.fn();

    const client = new McpStdioClient({
      id: "local",
      command: "npx",
      args: ["-y", "mcp-server-example"],
    }, { log: console, onClose });

    await client.start();
    await client.stop();

    // A deliberate stop must never be reported as an unexpected disconnect.
    const unexpectedCalls = onClose.mock.calls.filter(([info]) => info && info.expected === false);
    expect(unexpectedCalls).toHaveLength(0);
  });

  it("settles stop when stdin EOF makes the child exit synchronously", async () => {
    const proc = new FakeProcess();
    proc.stdin.end = vi.fn(() => {
      if (proc.exitCode == null) {
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
      }
    });
    spawnMock.mockReturnValueOnce(proc);

    const client = new McpStdioClient({
      id: "sync-exit",
      command: "node.exe",
      args: [],
    }, { log: console });

    await client.start();
    await client.stop();

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("escalates SIGTERM to SIGKILL when a child ignores graceful shutdown", async () => {
    vi.useFakeTimers();
    try {
      const proc = new FakeProcess();
      // A stubborn child ignores stdin EOF, forcing the kill escalation path.
      proc.stdin.end = vi.fn();
      // Override kill so SIGTERM is ignored; only SIGKILL actually exits.
      proc.kill = vi.fn((signal) => {
        if (signal === "SIGKILL") {
          proc.exitCode = 0;
          proc.emit("exit", null, "SIGKILL");
        }
        return true;
      });
      spawnMock.mockReturnValueOnce(proc);

      const client = new McpStdioClient({
        id: "stubborn",
        command: "npx",
        args: [],
      }, { log: console });

      await client.start();
      const stopPromise = client.stop();

      // After the graceful window, SIGTERM is sent; child still alive.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      // After the force window, SIGKILL is sent and the child finally exits.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      await stopPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps Windows .cmd shims with cmd.exe while preserving registry env", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "pdf",
      command: "npx.cmd",
      args: ["-y", "@sylphx/pdf-reader-mcp"],
      registryUrl: "https://registry.npmmirror.com",
    }, {
      platform: "win32",
      baseEnv: {
        PATH: "C:\\nodejs",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      existsSync: (candidate) => candidate === "C:\\nodejs\\npx.cmd",
    });

    expect(spec.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(spec.args).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\nodejs\\npx.cmd -y @sylphx/pdf-reader-mcp",
    ]);
    expect(spec.env.NPM_CONFIG_REGISTRY).toBe("https://registry.npmmirror.com");
  });

  it("wraps bare Windows commands so PATHEXT shims can be resolved by cmd.exe", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "local",
      command: "pdf-reader-mcp",
      args: ["--stdio"],
    }, {
      platform: "win32",
      baseEnv: { PATH: "C:\\tools", ComSpec: "cmd.exe" },
      existsSync: () => false,
    });

    expect(spec.command).toBe("cmd.exe");
    expect(spec.args).toEqual(["/d", "/s", "/c", "pdf-reader-mcp --stdio"]);
  });

  it("keeps Windows .exe commands on direct spawn", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "node",
      command: "node.exe",
      args: ["server.js"],
    }, {
      platform: "win32",
      baseEnv: { PATH: "C:\\nodejs", PATHEXT: ".EXE;.CMD" },
      existsSync: (candidate) => candidate === "C:\\nodejs\\node.exe",
    });

    expect(spec.command).toBe("C:\\nodejs\\node.exe");
    expect(spec.args).toEqual(["server.js"]);
  });

  it("quotes spaced Windows shim paths in the cmd.exe command line", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "spaced",
      command: "C:\\Program Files\\nodejs\\npx.cmd",
      args: ["-y", "package with spaces"],
    }, {
      platform: "win32",
      baseEnv: { ComSpec: "cmd.exe" },
      existsSync: () => true,
    });

    expect(spec.args).toEqual([
      "/d",
      "/s",
      "/c",
      "\"C:\\Program Files\\nodejs\\npx.cmd\" -y \"package with spaces\"",
    ]);
  });
});
