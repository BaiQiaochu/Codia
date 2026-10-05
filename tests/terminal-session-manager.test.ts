// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { TerminalSessionManager } from "../lib/terminal/terminal-session-manager.js";

function makeFakeBackend() {
  const handles = [];
  return {
    handles,
    spawn: vi.fn((opts) => {
      const handle = {
        writes: [],
        killed: false,
        write(data) {
          this.writes.push(data);
          opts.onData(`echo:${data}`);
        },
        kill() {
          this.killed = true;
          opts.onExit({ exitCode: null, signal: "SIGTERM" });
        },
        emit(data) {
          opts.onData(data);
        },
      };
      handles.push(handle);
      return handle;
    }),
  };
}

describe("TerminalSessionManager", () => {
  let tmpDir;
  let backend;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-terminal-"));
    backend = makeFakeBackend();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps terminal ownership scoped to the creating session", async () => {
    const manager = new TerminalSessionManager({
      gsapHome: tmpDir,
      createBackend: () => backend,
      now: () => 1770000000000,
    });
    const sessionPath = path.join(tmpDir, "agents", "gsap", "sessions", "s1.jsonl");
    const otherSessionPath = path.join(tmpDir, "agents", "gsap", "sessions", "s2.jsonl");

    const started = await manager.start({
      sessionPath,
      agentId: "gsap",
      cwd: tmpDir,
      command: "npm run dev",
      label: "dev server",
    });
    backend.handles[0].emit("ready\n");

    expect(started).toMatchObject({
      sessionPath,
      agentId: "gsap",
      cwd: tmpDir,
      command: "npm run dev",
      label: "dev server",
      status: "running",
      seq: 0,
    });
    expect(started.terminalId).toMatch(/^term_/);

    expect(manager.list(sessionPath).terminals).toHaveLength(1);
    expect(manager.list(otherSessionPath).terminals).toEqual([]);

    const read = manager.read({
      sessionPath,
      terminalId: started.terminalId,
      sinceSeq: 0,
    });
    expect(read).toMatchObject({
      terminalId: started.terminalId,
      status: "running",
      seq: 1,
      output: "ready\n",
    });

    expect(() => manager.read({
      sessionPath: otherSessionPath,
      terminalId: started.terminalId,
    })).toThrow(/belongs to another session/);
  });

  it("writes only to a running terminal owned by the same session", async () => {
    const manager = new TerminalSessionManager({
      gsapHome: tmpDir,
      createBackend: () => backend,
    });
    const sessionPath = path.join(tmpDir, "agents", "gsap", "sessions", "s1.jsonl");
    const started = await manager.start({ sessionPath, agentId: "gsap", cwd: tmpDir });

    const written = manager.write({
      sessionPath,
      terminalId: started.terminalId,
      chars: "pwd\n",
    });

    expect(backend.handles[0].writes).toEqual(["pwd\n"]);
    expect(written.output).toBe("echo:pwd\n");
    expect(written.seq).toBe(1);

    manager.close({ sessionPath, terminalId: started.terminalId });

    expect(() => manager.write({
      sessionPath,
      terminalId: started.terminalId,
      chars: "date\n",
    })).toThrow(/is not running/);
  });
});
