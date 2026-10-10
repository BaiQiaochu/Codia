import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRouter } from "../hub/channel-router.js";

describe("ChannelRouter background model filtering", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips agents without runnable background models", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-router-no-model-"));
    const agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(path.join(agentsDir, "codia"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "mika"), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "codia", "channels.md"), "", "utf8");
    fs.writeFileSync(path.join(agentsDir, "mika", "channels.md"), "", "utf8");

    const router = new ChannelRouter({
      hub: {
        engine: {
          agentsDir,
          canRunBackgroundTask: vi.fn((agentId) => agentId === "codia"),
        },
      },
    });

    expect(router.getAgentOrder()).toEqual(["codia"]);
  });
});
