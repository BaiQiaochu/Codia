import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(ROOT, relativePath));
}

describe("Codia professional edition contract", () => {
  it("uses an isolated professional product identity", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("g-sap-professional");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(pkg.build.appId).toBe("cn.edu.njust.byoung");
    expect(pkg.build.productName).toBe("Codia");
    expect(pkg.build.win.executableName).toBe("Codia");
    expect(pkg.build.nsis.shortcutName).toBe("Codia");
  });

  it("does not ship the commercial license activation system", () => {
    const pkg = JSON.parse(read("package.json"));
    const serverIndex = read("server/index.ts");
    const engine = read("core/engine.ts");

    expect(pkg.scripts["license:server"]).toBeUndefined();
    expect(pkg.scripts["package:license-server"]).toBeUndefined();
    expect(exists("license-server")).toBe(false);
    expect(exists("server/routes/license.ts")).toBe(false);
    expect(exists("core/license-service.ts")).toBe(false);
    expect(serverIndex).not.toContain("createLicenseRoute");
    expect(serverIndex).not.toContain("checkLicenseRouteAccess");
    expect(engine).not.toContain("LicenseService");
    expect(engine).not.toContain("licenseRouteAccess");
    expect(engine).not.toContain("disabledToolNamesForLicense");
  });

  it("does not ship desktop pet or Live2D entertainment surfaces", () => {
    const pkg = JSON.parse(read("package.json"));
    const agent = read("core/agent.ts");
    const main = read("desktop/main.cjs");
    const preload = read("desktop/preload.cjs");

    expect(pkg.dependencies["oh-my-live2d"]).toBeUndefined();
    expect(exists("desktop/src/desktop-pet.html")).toBe(false);
    expect(exists("desktop/src/desktop-pet-main.tsx")).toBe(false);
    expect(exists("desktop/src/react/desktop-pet")).toBe(false);
    expect(exists("desktop/src/react/settings/tabs/DesktopPetTab.tsx")).toBe(false);
    expect(exists("lib/tools/desktop-pet-tool.ts")).toBe(false);
    expect(agent).not.toContain("createDesktopPetTool");
    expect(agent).not.toContain("desktop_pet");
    expect(main).not.toContain("desktop-pet.html");
    expect(main).not.toContain("DESKTOP_PET_MODEL_PROTOCOL");
    expect(main).not.toContain("registerSchemesAsPrivileged");
    expect(main).not.toContain("com.gsap.app");
    expect(main).toContain('const APP_USER_MODEL_ID = "cn.edu.njust.byoung"');
    expect(preload).not.toContain("desktop-pet");
  });

  it("removes license and pet entries from settings navigation", () => {
    const nav = read("desktop/src/react/settings/SettingsNav.tsx");
    const content = read("desktop/src/react/settings/SettingsContent.tsx");
    const experiments = read("desktop/src/react/settings/tabs/ExperimentsTab.tsx");

    expect(exists("desktop/src/react/settings/tabs/LicenseTab.tsx")).toBe(false);
    expect(nav).not.toContain("settings.tabs.license");
    expect(nav).not.toContain("settings.tabs.desktopPet");
    expect(nav).not.toContain("isSettingsTabAllowedByLicense");
    expect(content).not.toContain("LicenseTab");
    expect(content).not.toContain("loadLicenseStatus");
    expect(content).not.toContain("firstAllowedSettingsTab");
    expect(experiments).not.toContain("DesktopPetTab");
  });

  it("does not expose role-card import/export in professional agent settings", () => {
    const createOverlay = read("desktop/src/react/settings/overlays/AgentCreateOverlay.tsx");
    const agentTab = read("desktop/src/react/settings/tabs/AgentTab.tsx");
    const cardStack = read("desktop/src/react/settings/tabs/agent/AgentCardStack.tsx");

    expect(exists("desktop/src/react/settings/overlays/CharacterCardPreviewOverlay.tsx")).toBe(false);
    expect(createOverlay).not.toContain("character-cards");
    expect(createOverlay).not.toContain("角色卡");
    expect(agentTab).not.toContain("character-cards");
    expect(agentTab).not.toContain("CharacterCardPreviewOverlay");
    expect(cardStack).not.toContain("settings.agent.exportAgent");
  });
});
