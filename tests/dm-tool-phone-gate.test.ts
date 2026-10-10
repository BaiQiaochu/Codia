import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDmTool } from "../lib/tools/dm-tool.js";

describe("dm tool phone gate", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-dm-tool-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("refuses to send or notify when the phone feature is disabled", async () => {
    const agentsDir = path.join(tempRoot, "agents");
    fs.mkdirSync(path.join(agentsDir, "alice"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "bob"), { recursive: true });
    const onDmSent = vi.fn();
    const tool = createDmTool({
      agentId: "alice",
      agentsDir,
      listAgents: () => [
        { id: "alice", name: "Alice" },
        { id: "bob", name: "Bob" },
      ],
      onDmSent,
      isEnabled: () => false,
    });

    const result = await tool.execute("call-1", { to: "bob", message: "hello" });

    expect(result.details).toMatchObject({ action: "dm", error: "phone disabled" });
    expect(onDmSent).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(agentsDir, "alice", "dm", "bob.md"))).toBe(false);
  });
});
