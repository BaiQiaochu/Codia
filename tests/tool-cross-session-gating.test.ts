// @ts-nocheck
import { beforeEach, describe, expect, it } from "vitest";
import { loadLocale } from "../server/i18n.js";
import { createDmTool } from "../lib/tools/dm-tool.js";
import { createHermesAgentTool } from "../lib/tools/hermes-agent-tool.js";
import { createSubagentTool } from "../lib/tools/subagent-tool.js";

describe("cross-session tool gating", () => {
  beforeEach(() => {
    loadLocale("en");
  });

  it("marks subagent as explicit-request only in model-visible metadata", () => {
    const tool = createSubagentTool({
      executeIsolated: async () => ({ replyText: "ok", error: null }),
      currentAgentId: "main",
      agentDir: "/tmp/agents/main",
      listAgents: () => [{ id: "main", name: "Main" }],
    });

    expect(tool.description).toMatch(/user explicitly asks/i);
    expect(tool.description).toMatch(/do not use this tool by default/i);
    expect(tool.description).not.toMatch(/Good for:/i);
    expect(tool.description).not.toMatch(/Research tasks/i);
  });

  it("marks dm as explicit-request only in model-visible metadata", () => {
    const tool = createDmTool({
      agentId: "main",
      agentsDir: "/tmp/agents",
      listAgents: () => [{ id: "main", name: "Main" }],
    });

    expect(tool.description).toMatch(/user explicitly asks/i);
    expect(tool.description).toMatch(/do not use this tool by default/i);
  });

  it("marks hermes_agent as explicit-request only in model-visible metadata", () => {
    const tool = createHermesAgentTool();

    expect(tool.description).toMatch(/user explicitly asks/i);
    expect(tool.description).toMatch(/do not use this tool by default/i);
    expect(tool.description).toMatch(/do not use .* just because .*complex/i);
  });
});
