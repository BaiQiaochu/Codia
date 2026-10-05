import { describe, expect, it } from "vitest";
import { getAutomationExecutor } from "../lib/desk/automation-executors.js";

describe("automation executor read model", () => {
  it("returns an explicit agent_session executor", () => {
    const executor = {
      kind: "agent_session",
      agentId: "agent-a",
      prompt: "Summarize today's notes.",
      model: { provider: "openai", id: "gpt-5.5" },
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace",
        workspaceFolders: ["/workspace/ref"],
        sourceSessionPath: "/sessions/source.jsonl",
        createdByAgentId: "agent-a",
      },
    };

    expect(getAutomationExecutor({ executor })).toBe(executor);
  });

  it("projects legacy prompt jobs to agent_session executors", () => {
    expect(getAutomationExecutor({
      actorAgentId: "agent-a",
      prompt: "Run the daily review.",
      model: "default-model",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/source.jsonl",
        createdByAgentId: "agent-a",
      },
    })).toEqual({
      kind: "agent_session",
      agentId: "agent-a",
      prompt: "Run the daily review.",
      model: "default-model",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/source.jsonl",
        createdByAgentId: "agent-a",
      },
    });
  });

  it("does not expose removed direct or plugin executor runners", async () => {
    const mod = await import("../lib/desk/automation-executors.js");
    expect("executeDirectAutomationAction" in mod).toBe(false);
    expect("executePluginAutomationAction" in mod).toBe(false);
  });
});
