// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFirstRun } from "../core/first-run.js";
import { GsapEngine } from "../core/engine.js";

describe("GsapEngine.dispose", () => {
  let tempRoot = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it("passes the live SessionCoordinator to AgentManager disposal and flushes active session memory ticks", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-engine-dispose-"));
    ensureFirstRun(tempRoot, path.join(process.cwd(), "lib"));
    const engine = new GsapEngine({ gsapHome: tempRoot, productDir: path.join(process.cwd(), "lib") });

    const notifySessionEnd = vi.fn(async () => {});
    const disposeAgent = vi.fn(async () => {});
    const agent = {
      id: "gsap",
      _memoryTicker: { notifySessionEnd },
      dispose: disposeAgent,
    };
    const sessionPath = path.join(tempRoot, "agents", "gsap", "sessions", "dispose-smoke.jsonl");

    engine._agentMgr._agents.set("gsap", agent);
    engine._agentMgr._activeAgentId = "gsap";
    engine._sessionCoord._sessions.set(sessionPath, {
      agentId: "gsap",
      session: {
        isStreaming: false,
        dispose: vi.fn(async () => {}),
      },
      listeners: new Set(),
    });

    await engine.dispose();

    expect(notifySessionEnd).toHaveBeenCalledWith(sessionPath);
    expect(disposeAgent).toHaveBeenCalledTimes(1);
    expect(engine._agentMgr.agents.size).toBe(0);
  });

  it("initializes subagent controller storage before delegated tasks register abort handlers", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-engine-subagent-controllers-"));
    ensureFirstRun(tempRoot, path.join(process.cwd(), "lib"));
    const engine = new GsapEngine({ gsapHome: tempRoot, productDir: path.join(process.cwd(), "lib") });

    try {
      const controller = { abort: vi.fn() };

      engine.setSubagentController("subagent-test", controller);
      engine.taskRegistry.register("subagent-test", {
        type: "subagent",
        parentSessionPath: path.join(tempRoot, "agents", "gsap", "sessions", "parent.jsonl"),
        persist: false,
      });

      expect(engine.taskRegistry.abort("subagent-test", "stop test child")).toBe("aborted");
      expect(controller.abort).toHaveBeenCalledOnce();
    } finally {
      await engine.dispose();
    }
  });

  it("self-heals subagent controller storage when an older runtime instance lacks it", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-engine-subagent-controllers-legacy-"));
    ensureFirstRun(tempRoot, path.join(process.cwd(), "lib"));
    const engine = new GsapEngine({ gsapHome: tempRoot, productDir: path.join(process.cwd(), "lib") });

    try {
      const controller = { abort: vi.fn() };
      engine._subagentControllers = undefined;

      expect(() => engine.setSubagentController("subagent-legacy", controller)).not.toThrow();
      engine.taskRegistry.register("subagent-legacy", {
        type: "subagent",
        parentSessionPath: path.join(tempRoot, "agents", "gsap", "sessions", "parent.jsonl"),
        persist: false,
      });

      expect(engine.taskRegistry.abort("subagent-legacy", "stop legacy child")).toBe("aborted");
      expect(controller.abort).toHaveBeenCalledOnce();
      expect(() => engine.removeSubagentController("subagent-legacy")).not.toThrow();
    } finally {
      await engine.dispose();
    }
  });
});
