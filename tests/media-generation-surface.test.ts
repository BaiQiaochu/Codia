import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Hub } from "../hub/index.ts";

function readText(filePath: string): string {
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

describe("media generation agent surface", () => {
  it("keeps the native media bridge on the Hub so media tools route to media-gen runtime", async () => {
    const engine = {
      setHubCallbacks: () => {},
      setEventBus: () => {},
    };
    const hub = new Hub({ engine } as any);

    expect(hub.eventBus.hasHandler("media:generate-image")).toBe(true);
    hub.eventBus.handle("media-gen:submit-image", async (payload: unknown) => ({ ok: true, payload }));

    await expect(hub.eventBus.request("media:generate-image", {
      sessionPath: "/tmp/session.jsonl",
      prompt: "city",
    })).resolves.toMatchObject({
      ok: true,
      payload: {
        sessionPath: "/tmp/session.jsonl",
        input: { prompt: "city" },
      },
    });
  });

  it("ships media plugin tools that instruct agents to use media tool aliases", () => {
    expect(fs.existsSync(path.resolve("plugins/media/manifest.json"))).toBe(true);
    expect(fs.existsSync(path.resolve("plugins/media/tools/generate-image.ts"))).toBe(true);
    expect(fs.existsSync(path.resolve("plugins/media/tools/generate-video.ts"))).toBe(true);

    const imageTool = readText("plugins/media/tools/generate-image.ts");
    const videoTool = readText("plugins/media/tools/generate-video.ts");
    const guide = readText("plugins/media/skills/media-generation-guide/SKILL.md");

    expect(imageTool).toContain("media:generate-image");
    expect(videoTool).toContain("media:generate-video");
    expect(`${imageTool}\n${guide}`).toContain("media_generate-image");
    expect(`${videoTool}\n${guide}`).toContain("media_generate-video");
  });
});
