import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getYuanVisual } from "../shared/yuan-visuals.ts";

const root = process.cwd();
const defaultAssistantAvatar = "character-cards/gsap-default-avatar.png";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf-8");
}

function sha256(relativePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relativePath))).digest("hex");
}

describe("Codia branding contract", () => {
  it("uses the Codia flower as the source for generated product icons", () => {
    const generator = read("scripts/generate-professional-icon.cjs");
    expect(generator).toContain('"codia", "codia-flower.png"');
    expect(generator).not.toContain("byoung-logo-source.png");
    expect(generator).not.toContain("drawProfessionalMark");

    const iconHash = sha256(path.join("desktop", "src", "icon.png"));
    for (const relativePath of [
      path.join("desktop", "src", "assets", "G-SAP.png"),
      path.join("desktop", "src", "assets", "about-icon.png"),
      path.join("desktop", "src", "assets", defaultAssistantAvatar),
      path.join("desktop", "src", "assets", "character-cards", "gsap-emblem.png"),
      path.join("desktop", "src", "assets", "character-cards", "butter-emblem.png"),
      path.join("desktop", "src", "assets", "character-cards", "ming-emblem.png"),
      path.join("desktop", "src", "assets", "character-cards", "kong-emblem.png"),
    ]) {
      expect(sha256(relativePath)).toBe(iconHash);
    }
  });

  it("regenerates the Codia icon for every desktop packaging target", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["build:win-release-resources"]).toContain("npm run generate:professional-icon");
    expect(pkg.scripts.dist).toContain("npm run generate:professional-icon");
    expect(pkg.scripts["dist:linux"]).toContain("npm run generate:professional-icon");

    const windowsRelease = read("scripts/package-win-release.ps1");
    const buildStage = windowsRelease.slice(
      windowsRelease.indexOf('Write-Step "Building renderer, desktop bundles, and server bundle"'),
      windowsRelease.indexOf('Write-Step "Checking renderer titlebar drag region"'),
    );
    expect(buildStage).toContain('Invoke-Step "node" @("scripts/generate-professional-icon.cjs")');
  });

  it("uses Codia for new installs and keeps upgrade identifiers stable", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.description).toMatch(/^Codia\b/);
    expect(pkg.build.productName).toBe("Codia");
    expect(pkg.build.win.executableName).toBe("Codia");
    expect(pkg.build.nsis.shortcutName).toBe("Codia");
    expect(pkg.build.dmg.title).toBe("Codia");
    expect(pkg.build.linux.maintainer).toMatch(/^Codia\b/);
    expect(pkg.build.appId).toBe("cn.edu.njust.byoung");
    expect(pkg.build.nsis.guid).toBe("ed42e0a7-d7b7-59de-b48f-420bf3932f92");

    const installer = read("build/installer.nsh");
    expect(installer).toContain('"Codia.exe"');
    expect(installer).toContain('"BYOUNG.exe"');
    expect(installer).toContain('"G-SAP星河智域专业版0.001.0.exe"');
  });

  it("uses the Codia avatar for built-in assistant fallbacks", () => {
    for (const yuan of ["gsap", "hermes", "butter", "ming", "kong"]) {
      expect(getYuanVisual(yuan).avatar).toBe(defaultAssistantAvatar);
    }
  });

  it("shows Codia in About and all locale taglines", () => {
    const about = read("desktop/src/react/settings/tabs/AboutTab.tsx");
    expect(about).toContain("Codia · 小豆蔻");
    expect(about).not.toContain("百扬智域·南理工智能体场景化协作平台");

    for (const locale of ["zh", "zh-TW", "en", "ja", "ko"]) {
      const messages = JSON.parse(read(path.join("desktop", "src", "locales", `${locale}.json`)));
      expect(messages.settings.about.tagline).toBe("Codia");
    }
  });
});
