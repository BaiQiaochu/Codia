// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHeartbeat } from "../lib/desk/heartbeat.js";

let tempRoot;

describe("heartbeat workspace output directories", () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-heartbeat-output-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("tells the agent to use visible BYOUNG-Works patrol and activity folders", async () => {
    const onBeat = vi.fn().mockResolvedValue(undefined);
    const heartbeat = createHeartbeat({
      getDeskFiles: async () => [],
      getWorkspacePath: () => tempRoot,
      getAgentName: () => "小花*?",
      registryPath: path.join(tempRoot, ".registry", "jian-registry.json"),
      onBeat,
      intervalMinutes: 31,
      locale: "zh-CN",
    });

    await heartbeat.beat();

    expect(onBeat).toHaveBeenCalledOnce();
    const prompt = onBeat.mock.calls[0][0];
    expect(prompt).toContain("BYOUNG-Works/小花的巡检/patrol-log.md");
    expect(prompt).toContain("BYOUNG-Works/小花-activity/");
    expect(prompt).not.toContain("HeartBeat");
  });
});
