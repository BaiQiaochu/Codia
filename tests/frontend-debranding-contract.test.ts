import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const legacyBrandPattern = /\bG-SAP\b|\bGSAP\b|星河智域/u;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf-8");
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output));
    return output;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectStrings(item, output));
  }
  return output;
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

  it("removes the legacy product names from every bundled locale value", () => {
    for (const locale of ["zh", "zh-TW", "en", "ja", "ko"]) {
      const messages = JSON.parse(read(`desktop/src/locales/${locale}.json`));
      const legacyValues = collectStrings(messages).filter((value) =>
        legacyBrandPattern.test(value)
      );
      expect(legacyValues, locale).toEqual([]);
    }
  });

  it("removes legacy branding from renderer-owned user-facing surfaces", () => {
    const userFacingSources = [
      "desktop/src/react/app-init.ts",
      "desktop/src/react/mobile/mobile-init.ts",
      "desktop/src/react/mobile/MobileApp.tsx",
      "desktop/src/mobile-main.tsx",
      "desktop/src/react/onboarding/OnboardingApp.tsx",
      "desktop/src/react/quick-chat/QuickChatApp.tsx",
      "desktop/src/react/components/automation/AutomationCard.tsx",
      "desktop/src/react/components/AutoUpdateStatus.tsx",
      "desktop/src/react/components/PwaLoginGate.tsx",
      "desktop/src/react/components/channels/ChannelWorkflowWindow.tsx",
      "desktop/src/react/components/channels/ChannelWorkspacePanel.tsx",
      "desktop/src/react/components/chat/AssistantMessage.tsx",
      "desktop/src/react/components/chat/ProcessFoldBlock.tsx",
      "desktop/src/react/components/chat/ToolGroupBlock.tsx",
      "desktop/src/react/components/chat/XingCard.tsx",
      "desktop/src/react/components/input/SessionConfirmationPrompt.tsx",
      "desktop/src/react/components/notices/SidebarNoticeSlot.tsx",
      "desktop/src/react/services/server-connection.ts",
      "desktop/src/react/settings/SettingsContent.tsx",
      "desktop/src/react/settings/store.ts",
      "desktop/src/react/settings/tabs/settings-copy.ts",
      "desktop/src/react/stores/agent-slice.ts",
      "desktop/src/react/stores/runtime-timeline-slice.ts",
      "desktop/src/react/utils/screenshot.ts",
      "desktop/src/lib/i18n.ts",
      "desktop/src/react/splash/SplashApp.tsx",
      "desktop/src/screenshot-themes/gsap-brand.css",
      "desktop/src/screenshot-themes/gsap-brand-desktop.css",
      "server/block-extractors.ts",
      "server/deferred-result-interlude.ts",
      "server/routes/chat.ts",
      "server/routes/mobile-workbench.ts",
      "server/routes/system-health.ts",
      "server/runtime-diagnostics-service.ts",
      "shared/professional-edition.ts",
      "shared/vscode-extension-compat.ts",
    ];

    for (const relativePath of userFacingSources) {
      expect(read(relativePath), relativePath).not.toMatch(legacyBrandPattern);
    }

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
      "desktop/src/screenshot-themes/gsap-brand.css",
      "desktop/src/screenshot-themes/gsap-brand-desktop.css",
    ]) {
      const content = read(screenshotTheme);
      expect(content).toContain('content: "Codia"');
      expect(content).toContain("--gsap-accent: #8C68B8");
      expect(content).not.toContain("#D8292F");
      expect(content).not.toContain("Songti SC");
    }
  });

  it("uses the new product name on native visible surfaces", () => {
    const main = read("desktop/main.cjs");
    expect(main).toContain('const RUNTIME_DISPLAY_NAME = "Codia";');
    expect(main).toContain('title: "Codia Quick Chat"');

    expect(read("desktop/bootstrap.cjs")).not.toMatch(legacyBrandPattern);

    const server = read("server/index.ts");
    expect(server).toContain("<title>本机 API 服务</title>");
    expect(server).toContain('appName: "Codia"');
    expect(server).not.toContain("<title>G-SAP");
    expect(server).not.toContain("<h1>G-SAP");

    const plugins = read("server/routes/plugins.ts");
    expect(plugins).not.toContain("G-SAP plugin compatibility");
    expect(plugins).not.toContain("generated G-SAP page");
    expect(plugins).not.toContain("installable by G-SAP");

    expect(read("shared/default-workspace-constants.ts"))
      .toContain('DEFAULT_WORKSPACE_DIRNAME = "BYOUNG-Workspace"');
    expect(read("shared/workspace-output.cjs"))
      .toContain('WORKSPACE_OUTPUT_ROOT_DIRNAME = "BYOUNG-Works"');
  });
});
