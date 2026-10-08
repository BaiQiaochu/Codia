import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readTool(fileName) {
  const parsed = path.parse(fileName);
  const candidates = [
    path.resolve("plugins/image-gen/tools", `${parsed.name}.ts`),
    path.resolve("plugins/image-gen/tools", `${parsed.name}.js`),
  ];
  const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!sourcePath) throw new Error(`tool source not found: ${fileName}`);
  return fs.readFileSync(sourcePath, "utf8");
}

describe("image-gen tool card routing", () => {
  it("keeps image, video, and audio cards on separate routes", () => {
    expect(readTool("generate-image.js")).toContain("route: `/card?batch=${batchId}`");
    expect(readTool("generate-video.js")).toContain("route: `/video-card?batch=${batchId}`");
    expect(readTool("generate-audio.js")).toContain("route: `/audio-card?batch=${batchId}`");
    expect(readTool("generate-music.js")).toContain("route: `/audio-card?batch=${batchId}`");
  });
});
