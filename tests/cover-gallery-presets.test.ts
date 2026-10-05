import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  COVER_GALLERY_PRESETS,
  getCoverGalleryPreset,
} from "../shared/cover-gallery-presets.ts";
import { resolveCoverGalleryPresetImagePath } from "../plugins/beautify/lib/cover-gallery-assets.js";

describe("cover gallery presets", () => {
  it("matches the full v0.282.5 built-in cover gallery set", () => {
    expect(COVER_GALLERY_PRESETS.map((preset) => preset.id)).toEqual([
      "scribble-black-cat",
      "blue-island-watercolor",
      "nature-plate-print",
      "pastel-spring-bookmark",
      "hidden-ragdoll-cat",
      "grass-horizon-dream",
      "bamboo-shadow-minimal",
      "green-plain-clouds",
      "four-seasons-storybook",
      "pink-flower-fisherman",
      "sunlit-window-leaves",
      "summer-sea-fantasy",
      "maximalist-four-seasons",
      "story-garden-objects",
      "blue-sky-screenprint",
      "indigo-window-silhouette",
      "spring-gauze-room",
      "felt-blue-storybook",
      "rainy-street-cafe",
      "dragon-pillar-palace",
      "wasteland-rider",
      "white-cat-blossom",
      "tree-lined-path",
      "ochre-silhouette",
      "misty-blossoms",
    ]);
  });

  it("keeps built-in cover presets as plain bundled asset file names", () => {
    expect(COVER_GALLERY_PRESETS.length).toBeGreaterThan(0);

    for (const preset of COVER_GALLERY_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9-]+$/);
      expect(preset.title).toBeTruthy();
      expect(preset.title).not.toMatch(/[\u9427\u699b\u9483\u9477\u7efb]/);
      expect(preset.fileName).toMatch(/^[a-z0-9-]+\.(png|jpg|jpeg|webp)$/);
      expect(preset.fileName).not.toContain("/");
      expect(preset.fileName).not.toContain("\\");
    }
  });

  it("uses readable Chinese titles for the cover gallery UI", () => {
    expect(COVER_GALLERY_PRESETS.map((preset) => preset.title)).toEqual([
      "黑猫涂鸦",
      "蓝岛水彩",
      "自然版画",
      "春日书签",
      "灌木小猫",
      "草地地平线",
      "竹影留白",
      "绿色平原",
      "四季绘本",
      "花雨小舟",
      "窗外晴叶",
      "夏海幻想",
      "繁花四季",
      "园中物语",
      "蓝天版画",
      "靛窗花影",
      "春纱小室",
      "蓝毡绘本",
      "雨街咖啡",
      "龙柱古殿",
      "废土骑士",
      "花间白猫",
      "林荫步道",
      "赭墨剪影",
      "薄雾繁花",
    ]);
  });

  it("keeps every built-in cover gallery image present on disk", () => {
    const assetDir = path.join(process.cwd(), "desktop", "src", "assets", "cover-gallery");

    for (const preset of COVER_GALLERY_PRESETS) {
      expect(
        fs.existsSync(path.join(assetDir, preset.fileName)),
        `missing bundled cover gallery image: ${preset.fileName}`,
      ).toBe(true);
    }
  });

  it("resolves a preset image under the cover gallery asset directory", () => {
    const preset = COVER_GALLERY_PRESETS[0];
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-cover-gallery-root-"));
    const assetDir = path.join(rootDir, "desktop", "src", "assets", "cover-gallery");
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(path.join(assetDir, preset.fileName), "image");

    try {
      expect(getCoverGalleryPreset(preset.id)).toEqual(preset);
      expect(resolveCoverGalleryPresetImagePath(preset.id, { rootDir }))
        .toBe(path.join(assetDir, preset.fileName));
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown preset ids instead of treating them as paths", () => {
    expect(getCoverGalleryPreset("../private")).toBeNull();
    expect(() => resolveCoverGalleryPresetImagePath("../private", { rootDir: "/tmp/gsap" }))
      .toThrow("unknown cover gallery preset");
  });
});
