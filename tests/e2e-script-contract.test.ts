import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("desktop E2E smoke script contracts", () => {
  it("exposes runnable smoke scripts for media settings defaults without the removed renderer smoke", () => {
    const removedSmokeScript = "scripts/e2e-" + "hyper" + "frames-video.mjs";
    const removedSmokeCommand = "e2e:" + "hyper" + "frames-video";

    expect(exists(removedSmokeScript)).toBe(false);
    expect(exists("scripts/e2e-media-settings-defaults.mjs")).toBe(true);

    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts).not.toHaveProperty(removedSmokeCommand);
    expect(pkg.scripts["e2e:media-settings"]).toBe("node scripts/e2e-media-settings-defaults.mjs");
  });
});
