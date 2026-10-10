import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../plugins/beautify/tools/create-cover.js";

describe("beautify create-cover tool", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-beautify-tool-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("only applies an existing image and never calls language or image generation services", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "generated.png");
    fs.writeFileSync(notePath, "# Note\n\nBody\n", "utf-8");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const request = vi.fn(async () => {
      throw new Error("unexpected bus request");
    });
    const result = await execute({
      targetFilePath: notePath,
      generatedFilePath: imagePath,
      pixelWidth: 1536,
      pixelHeight: 1024,
    }, {
      bus: { request },
      sessionPath: path.join(tmpDir, "session.jsonl"),
    });

    expect(request).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("已把图片应用为 Markdown cover");
    expect(result.details.beautifyCover.cover).toMatchObject({
      image: expect.stringMatching(/^文本附件\/note-cover-/),
      actualRatio: "3:2",
      pixelWidth: 1536,
      pixelHeight: 1024,
    });

    const raw = fs.readFileSync(notePath, "utf-8");
    expect(raw).toContain("cover:");
    expect(raw).not.toContain("prompt:");
    expect(raw).not.toContain("provider:");
    expect(raw).not.toContain("model:");
  });
});
