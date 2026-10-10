import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { DmRouter } from "../hub/dm-router.js";

const { runAgentPhoneSessionMock } = vi.hoisted(() => ({
  runAgentPhoneSessionMock: vi.fn(async () => "received <done/>"),
}));

vi.mock("../hub/agent-executor.js", () => ({
  runAgentPhoneSession: runAgentPhoneSessionMock,
  runAgentSession: runAgentPhoneSessionMock,
}));

function writeDmFile(filePath, sender, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    "---",
    "type: dm",
    "---",
    "",
    `### ${sender} | 2026-05-12 20:00:00`,
    "",
    body,
    "",
    "---",
    "",
  ].join("\n"), "utf-8");
}

describe("DmRouter phone gate", () => {
  it("does not start DM phone processing when the phone feature is disabled", async () => {
    runAgentPhoneSessionMock.mockClear();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-dm-phone-disabled-"));
    try {
      const agentsDir = path.join(root, "agents");
      const aliceDir = path.join(agentsDir, "alice");
      const bobDir = path.join(agentsDir, "bob");
      writeDmFile(path.join(aliceDir, "dm", "bob.md"), "bob", "ping");
      writeDmFile(path.join(bobDir, "dm", "alice.md"), "bob", "ping");

      const router = new DmRouter({
        hub: {
          engine: {
            agentsDir,
            isChannelsEnabled: () => false,
            getAgent: (id) => ({
              id,
              agentDir: id === "alice" ? aliceDir : bobDir,
              agentName: id === "alice" ? "Alice" : "Bob",
            }),
          },
          eventBus: { emit: vi.fn() },
        },
      });

      await router.handleNewDm("bob", "alice");

      expect(runAgentPhoneSessionMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
