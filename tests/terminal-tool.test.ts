// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import { createTerminalTool } from "../lib/tools/terminal-tool.js";

function makeCtx(sessionPath = "/tmp/agents/gsap/sessions/s1.jsonl") {
  return {
    sessionManager: {
      getSessionFile: () => sessionPath,
      getCwd: () => "/tmp/workspace",
    },
  };
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

describe("terminal tool", () => {
  it("exposes one action-based tool for terminal lifecycle operations", async () => {
    const manager = {
      start: vi.fn(async (input) => ({ ...input, terminalId: "term_1", status: "running", seq: 0, output: "" })),
      write: vi.fn((input) => ({ ...input, status: "running", seq: 1, output: "ok\n" })),
      read: vi.fn((input) => ({ ...input, status: "running", seq: 1, output: "ok\n" })),
      close: vi.fn((input) => ({ ...input, status: "killed", seq: 1, output: "" })),
      list: vi.fn((sessionPath) => ({ sessionPath, terminals: [{ terminalId: "term_1", status: "running" }] })),
    };
    const tool = createTerminalTool({
      getTerminalSessionManager: () => manager,
      getAgentId: () => "gsap",
      getCwd: () => "/tmp/workspace",
    });

    expect(tool.name).toBe("terminal");

    const started = parse(await tool.execute("call_1", {
      action: "start",
      command: "npm run dev",
      label: "dev",
    }, null, null, makeCtx()));

    expect(started).toMatchObject({ terminalId: "term_1", status: "running", seq: 0 });
    expect(manager.start).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/tmp/agents/gsap/sessions/s1.jsonl",
      agentId: "gsap",
      cwd: "/tmp/workspace",
      command: "npm run dev",
      label: "dev",
    }));

    const written = parse(await tool.execute("call_2", {
      action: "write",
      terminal_id: "term_1",
      chars: "rs\n",
    }, null, null, makeCtx()));
    expect(written.output).toBe("ok\n");
    expect(manager.write).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/tmp/agents/gsap/sessions/s1.jsonl",
      terminalId: "term_1",
      chars: "rs\n",
    }));

    const listed = parse(await tool.execute("call_3", { action: "list" }, null, null, makeCtx()));
    expect(listed.terminals).toEqual([{ terminalId: "term_1", status: "running" }]);
  });

  it("requires an active session before touching terminal state", async () => {
    const tool = createTerminalTool({
      getTerminalSessionManager: () => ({ list: vi.fn() }),
      getAgentId: () => "gsap",
      getCwd: () => "/tmp/workspace",
    });

    const result = await tool.execute("call_1", { action: "list" });

    expect(result.content[0].text).toContain("current session is required");
  });
});
