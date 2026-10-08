import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("removed local video renderer contract", () => {
  it("does not ship the removed plugin, UI entrypoint, script, or dependency", () => {
    const removedNamePattern = new RegExp("@hy" + "perframes|hy" + "perframes", "i");
    const removedUiPattern = new RegExp("Hy" + "perFrames|hy" + "perframes|hf" + "video", "i");
    const removedDependency = "@hy" + "perframes/producer";
    const removedSmokeCommand = "e2e:" + "hy" + "perframes-video";
    const removedPluginDir = "plugins/video-gen";
    const removedSmokeScript = "scripts/e2e-" + "hy" + "perframes-video.mjs";
    const removedSmokeResult = "tmp-e2e-" + "hy" + "perframes-video-result.json";

    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies || {}).not.toHaveProperty(removedDependency);
    expect(pkg.scripts || {}).not.toHaveProperty(removedSmokeCommand);

    expect(read("package-lock.json")).not.toMatch(removedNamePattern);
    expect(read("vite.config.server.js")).not.toMatch(removedNamePattern);

    expect(existsSync(join(ROOT, removedPluginDir))).toBe(false);
    expect(existsSync(join(ROOT, removedSmokeScript))).toBe(false);
    expect(existsSync(join(ROOT, removedSmokeResult))).toBe(false);

    expect(read("desktop/src/react/components/input/slash-commands.ts")).not.toMatch(removedUiPattern);
    expect(read("desktop/src/react/components/InputArea.tsx")).not.toMatch(removedUiPattern);
    expect(read("desktop/src/react/components/input/InputArea.module.css")).not.toMatch(removedUiPattern);
  });
});
