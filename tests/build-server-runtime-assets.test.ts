import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PWA_DISPLAY_NAME } from "../shared/product-branding.ts";
import { COVER_GALLERY_PRESETS } from "../shared/cover-gallery-presets.ts";

import {
  copyServerRuntimeAssets,
  SERVER_RUNTIME_ASSET_DIRS,
  SERVER_RUNTIME_ASSET_FILES,
  SERVER_RUNTIME_RENDERER_DIRS,
  SERVER_RUNTIME_RENDERER_REQUIRED_FILES,
} from "../scripts/build-server-runtime-assets.mjs";

describe("server runtime assets", () => {
  let tempDir;
  let rootDir;
  let outDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-server-assets-"));
    rootDir = path.join(tempDir, "root");
    outDir = path.join(tempDir, "dist-server", "win-x64");
    const assetsDir = path.join(rootDir, "desktop", "src", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    for (const fileName of SERVER_RUNTIME_ASSET_FILES) {
      fs.writeFileSync(path.join(assetsDir, fileName), `${fileName}\n`);
    }
    for (const dirName of SERVER_RUNTIME_ASSET_DIRS) {
      const dir = path.join(assetsDir, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "gsap-default-avatar.png"), "default-avatar\n");
      fs.writeFileSync(path.join(dir, "gsap-card-back.png"), "card-back\n");
      fs.writeFileSync(path.join(dir, "gsap-emblem.png"), "emblem\n");
      if (dirName === "cover-gallery") {
        for (const preset of COVER_GALLERY_PRESETS) {
          fs.writeFileSync(path.join(dir, preset.fileName), `${preset.fileName}\n`);
        }
      }
    }

    const rendererDir = path.join(rootDir, "desktop", "dist-renderer");
    fs.mkdirSync(path.join(rendererDir, "assets"), { recursive: true });
    for (const dirName of SERVER_RUNTIME_RENDERER_DIRS) {
      fs.mkdirSync(path.join(rendererDir, dirName), { recursive: true });
    }
    for (const fileName of SERVER_RUNTIME_RENDERER_REQUIRED_FILES) {
      fs.writeFileSync(path.join(rendererDir, fileName), `${fileName}\n`, "utf-8");
    }
    fs.writeFileSync(
      path.join(rendererDir, "index.html"),
      [
        "<!doctype html>",
        '<link rel="stylesheet" href="styles.css">',
        '<link rel="stylesheet" href="themes/studio-light.css">',
        '<script type="module" src="./assets/main.js"></script>',
        '<link rel="modulepreload" href="./assets/chunk.js">',
      ].join(""),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rendererDir, "mobile.html"),
      [
        "<!doctype html>",
        `<title>${PWA_DISPLAY_NAME}</title>`,
        '<link rel="manifest" href="./manifest.webmanifest">',
        '<link rel="stylesheet" href="styles.css">',
        '<link rel="stylesheet" href="themes/studio-light.css">',
        '<script type="module" src="./assets/mobile-app.js"></script>',
      ].join(""),
      "utf-8",
    );
    fs.writeFileSync(path.join(rendererDir, "manifest.webmanifest"), JSON.stringify({ name: PWA_DISPLAY_NAME }), "utf-8");
    fs.writeFileSync(path.join(rendererDir, "sw.js"), "self.addEventListener('fetch', () => {})", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "icon.png"), "png", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "styles.css"), ".root { background: url('./assets/paper.png'); }", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "assets", "main.js"), "import './chunk.js'; console.log('main')", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "assets", "chunk.js"), "console.log('chunk')", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "assets", "mobile-app.js"), "console.log('mobile')", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "assets", "paper.png"), "paper", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "assets", "main.js.map"), '{"sourcesContent":["map"]}', "utf-8");
    fs.writeFileSync(path.join(rendererDir, "assets", "desktop-only.js"), "console.log('desktop')", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "themes", "studio-light.css"), ":root{}", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "locales", "zh.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "lib", "i18n.js"), "window.t = () => {}", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "lib", "theme.js"), "window.GSAPTheme = {}", "utf-8");
    fs.writeFileSync(path.join(rendererDir, "settings.html"), "<!doctype html><title>Settings</title>", "utf-8");
    fs.mkdirSync(path.join(rendererDir, "modules"), { recursive: true });
    fs.writeFileSync(path.join(rendererDir, "modules", "legacy.js"), "console.log('legacy')", "utf-8");

  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("copies character-card fallback assets into the bundled server root", () => {
    const copied = copyServerRuntimeAssets({ rootDir, outDir });

    for (const fileName of SERVER_RUNTIME_ASSET_FILES) {
      expect(fs.readFileSync(path.join(outDir, "desktop", "src", "assets", fileName), "utf-8"))
        .toBe(`${fileName}\n`);
    }
    expect(fs.readFileSync(
      path.join(outDir, "desktop", "src", "assets", "character-cards", "gsap-default-avatar.png"),
      "utf-8",
    )).toBe("default-avatar\n");
    expect(fs.readFileSync(
      path.join(outDir, "desktop", "src", "assets", "character-cards", "gsap-card-back.png"),
      "utf-8",
    )).toBe("card-back\n");
    expect(fs.readFileSync(
      path.join(outDir, "desktop", "src", "assets", "character-cards", "gsap-emblem.png"),
      "utf-8",
    )).toBe("emblem\n");
    expect(fs.readFileSync(
      path.join(outDir, "desktop", "src", "assets", "cover-gallery", "gsap-default-avatar.png"),
      "utf-8",
    )).toBe("default-avatar\n");
    for (const preset of COVER_GALLERY_PRESETS) {
      expect(fs.readFileSync(
        path.join(outDir, "desktop", "src", "assets", "cover-gallery", preset.fileName),
        "utf-8",
      )).toBe(`${preset.fileName}\n`);
    }
    expect(copied).toEqual(expect.arrayContaining([
      path.join("desktop", "src", "assets", "G-SAP.png"),
      path.join("desktop", "src", "assets", "G-SAP-Rational.jpg"),
      path.join("desktop", "src", "assets", "character-cards") + path.sep,
      path.join("desktop", "src", "assets", "cover-gallery") + path.sep,
    ]));
  });

  it("fails the build when a required fallback asset is missing", () => {
    fs.unlinkSync(path.join(rootDir, "desktop", "src", "assets", "G-SAP-Rational.jpg"));

    expect(() => copyServerRuntimeAssets({ rootDir, outDir }))
      .toThrow(/required runtime asset missing: .*G-SAP-Rational\.jpg/);
  });

  it("copies the renderer PWA into the bundled server root", () => {
    const copied = copyServerRuntimeAssets({ rootDir, outDir });

    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "index.html"), "utf-8"))
      .toContain("assets/main.js");
    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "styles.css"), "utf-8"))
      .toContain("background");
    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "assets", "main.js"), "utf-8"))
      .toContain("console.log('main')");
    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "assets", "chunk.js"), "utf-8"))
      .toContain("console.log('chunk')");
    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "assets", "paper.png"), "utf-8"))
      .toBe("paper");
    expect(copied).toContain(path.join("desktop", "dist-renderer") + path.sep);
  });

  it("copies the mobile PWA entry into the bundled server root", () => {
    copyServerRuntimeAssets({ rootDir, outDir });

    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "mobile.html"), "utf-8"))
      .toContain("assets/mobile-app.js");
    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "mobile.html"), "utf-8"))
      .toContain('src="lib/i18n.js"');
    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "mobile.html"), "utf-8"))
      .toContain('src="lib/theme.js"');
    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "manifest.webmanifest"), "utf-8"))
      .toContain(PWA_DISPLAY_NAME);
    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "sw.js"), "utf-8"))
      .toContain("fetch");
    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "icon.png"), "utf-8"))
      .toBe("png");
    expect(fs.readFileSync(path.join(outDir, "desktop", "dist-renderer", "assets", "mobile-app.js"), "utf-8"))
      .toContain("console.log('mobile')");
  });

  it("excludes source maps and desktop-only renderer files from the server runtime", () => {
    copyServerRuntimeAssets({ rootDir, outDir });

    expect(fs.existsSync(path.join(outDir, "desktop", "dist-renderer", "assets", "main.js.map"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "desktop", "dist-renderer", "assets", "desktop-only.js"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "desktop", "dist-renderer", "settings.html"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "desktop", "dist-renderer", "modules", "legacy.js"))).toBe(false);
  });
});
