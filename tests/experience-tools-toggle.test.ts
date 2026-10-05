// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExperienceTools, recordEntry } from "../lib/tools/experience.js";

let tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-exp-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("experience tools toggle", () => {
  it("returns paused responses without reading or writing when disabled", async () => {
    const dir = tempDir();
    const tools = createExperienceTools(dir, { isEnabled: () => false });
    const recall = tools.find((tool) => tool.name === "recall_experience");
    const record = tools.find((tool) => tool.name === "record_experience");

    const recallResult = await recall.execute("call-1", {});
    const recordResult = await record.execute("call-2", { category: "workflow", content: "Use small patches." });

    expect(recallResult.details.paused).toBe(true);
    expect(recordResult.details.paused).toBe(true);
    expect(fs.existsSync(path.join(dir, "experience"))).toBe(false);
  });

  it("works normally when enabled", async () => {
    const dir = tempDir();
    recordEntry(path.join(dir, "experience"), path.join(dir, "experience.md"), "workflow", "Use small patches.");
    const tools = createExperienceTools(dir, { isEnabled: () => true });
    const recall = tools.find((tool) => tool.name === "recall_experience");

    const result = await recall.execute("call-1", { category: "workflow" });

    expect(result.content[0].text).toContain("Use small patches.");
  });
});
