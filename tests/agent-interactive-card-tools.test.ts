import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/memory/memory-ticker.js", () => ({
  createMemoryTicker: () => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    tick: vi.fn().mockResolvedValue(undefined),
    triggerNow: vi.fn(),
    notifyTurn: vi.fn(),
    notifySessionEnd: vi.fn().mockResolvedValue(undefined),
    notifyPromoted: vi.fn().mockResolvedValue(undefined),
    flushSession: vi.fn().mockResolvedValue(undefined),
    getHealthStatus: vi.fn().mockReturnValue({}),
  }),
}));

import { Agent } from "../core/agent.ts";

function bootstrapAgent(rootDir: string) {
  const agentsDir = path.join(rootDir, "agents");
  const agentDir = path.join(agentsDir, "gsap");
  const userDir = path.join(rootDir, "user");
  fs.mkdirSync(path.join(agentDir, "memory", "summaries"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });

  fs.writeFileSync(
    path.join(agentDir, "config.yaml"),
    [
      "agent:",
      "  name: G-SAP",
      "  yuan: gsap",
      "user:",
      "  name: Tester",
      "locale: en",
      "memory:",
      "  enabled: false",
      "models:",
      "  chat:",
      "    id: gpt-4",
      "    provider: openai",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(path.join(agentDir, "identity.md"), "identity\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "ishiki.md"), "ishiki\n", "utf-8");
  fs.writeFileSync(path.join(userDir, "user.md"), "user profile\n", "utf-8");

  const productDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
  return { agentsDir, productDir, userDir };
}

describe("Agent interactive card tools", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length) {
      fs.rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("registers interactive card guide and renderer tools in runtime snapshots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-card-tools-"));
    roots.push(root);
    const { agentsDir, productDir, userDir } = bootstrapAgent(root);
    const agent = new Agent({ id: "gsap", agentsDir, productDir, userDir } as any);
    agent.setCallbacks({
      getLearnSkills: () => ({}),
      isChannelsEnabled: () => false,
    });

    await agent.init(() => {});
    const toolNames = agent.getToolsSnapshot({ forceMemoryEnabled: false }).map((tool) => tool.name);

    expect(toolNames).toContain("hana_card_guide");
    expect(toolNames).toContain("show_card");

    await agent.dispose();
  });
});
