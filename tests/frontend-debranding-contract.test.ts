import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf-8");
}

describe("frontend debranding contract", () => {
  it("uses Codia on browser and installable mobile surfaces", () => {
    expect(read("desktop/src/index.html")).toContain("<title>Codia · 小豆蔻</title>");
    expect(read("desktop/src/mobile.html")).toContain("<title>Codia · 小豆蔻</title>");
    expect(read("desktop/src/quick-chat.html")).toContain("<title>Codia Quick Chat</title>");
    expect(read("desktop/src/splash.html")).toContain("<title>Codia · 小豆蔻</title>");

    const manifest = JSON.parse(read("desktop/src/mobile-manifest.webmanifest"));
    expect(manifest.name).toBe("Codia · 小豆蔻");
    expect(manifest.short_name).toBe("Codia");
  });

  it("uses Codia branding in the renderer watermark", () => {
    const watermark = read("shared/dark-watermark.cjs");
    expect(watermark).toContain('const PRODUCT = "Codia";');
  });

  it("uses the fixed Codia lilac theme without legacy decorative effects", () => {
    const registry = JSON.parse(read("desktop/src/shared/theme-registry-data.json"));
    expect(registry.defaultTheme).toBe("codia-lilac");
    expect(registry.themes["codia-lilac"].preview.accent).toBe("#A984E8");
    expect(registry.paperTextureBlockedThemeIds).toEqual(
      expect.arrayContaining(Object.keys(registry.themes)),
    );

    const theme = read("desktop/src/themes/codia-lilac.css");
    expect(theme).toContain("--accent:       #A984E8;");

    const app = read("desktop/src/react/App.tsx");
    expect(app).not.toContain("<LeavesOverlay");

    const interfaceTab = read("desktop/src/react/settings/tabs/InterfaceTab.tsx");
    expect(interfaceTab).not.toContain("settings.appearance.paperTexture");
    expect(interfaceTab).not.toContain("settings.appearance.leavesOverlay");

    const splash = read("desktop/src/splash.html");
    expect(splash).not.toContain("Songti SC");
    expect(splash).not.toContain("#F4F0E4");

    for (const screenshotTheme of [
      "desktop/src/screenshot-themes/codia-brand.css",
      "desktop/src/screenshot-themes/codia-brand-desktop.css",
    ]) {
      const content = read(screenshotTheme);
      expect(content).toContain('content: "Codia"');
      expect(content).toContain("--codia-accent: #8C68B8");
      expect(content).not.toContain("#D8292F");
      expect(content).not.toContain("Songti SC");
    }
  });

  it("uses the new product name on native visible surfaces", () => {
    const main = read("desktop/main.cjs");
    expect(main).toContain('const RUNTIME_DISPLAY_NAME = "Codia";');
    expect(main).toContain('title: "Codia Quick Chat"');

    const server = read("server/index.ts");
    expect(server).toContain("<title>本机 API 服务</title>");
    expect(server).toContain('appName: "Codia"');
    expect(server).not.toContain("<title>Codia");
    expect(server).not.toContain("<h1>Codia");

    const plugins = read("server/routes/plugins.ts");
    expect(plugins).not.toContain("Codia plugin compatibility");
    expect(plugins).not.toContain("generated Codia page");
    expect(plugins).not.toContain("installable by Codia");

    expect(read("shared/default-workspace-constants.ts"))
      .toContain('DEFAULT_WORKSPACE_DIRNAME = "Codia-Workspace"');
    expect(read("shared/workspace-output.cjs"))
      .toContain('WORKSPACE_OUTPUT_ROOT_DIRNAME = "Codia-Works"');
  });
});
