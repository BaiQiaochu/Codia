import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const packageScript = fs.readFileSync(path.join(root, "scripts", "package-surface-artifacts.mjs"), "utf8");
const chatCss = fs.readFileSync(path.join(root, "desktop", "src", "react", "components", "chat", "Chat.module.css"), "utf8");
const appSource = fs.readFileSync(path.join(root, "desktop", "src", "react", "App.tsx"), "utf8");
const settingsCss = fs.readFileSync(path.join(root, "desktop", "src", "react", "settings", "Settings.module.css"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

describe("PWA surface UI parity smoke contract", () => {
  it("packages PWA surfaces from the shared renderer and server artifacts", () => {
    expect(packageJson.scripts["package:surfaces"])
      .toBe("node scripts/package-surface-artifacts.mjs");
    expect(packageScript).toContain('const args = new Set(process.argv.slice(2))');
    expect(packageScript).toContain('"desktop/dist-renderer"');
    expect(packageScript).toContain('"dist-server-bundle/index.js"');
    expect(packageScript).toContain('"lib/cli"');
  });

  it("keeps PWA model lock coverage in route tests", () => {
    const routeTest = fs.readFileSync(path.join(root, "tests", "model-sync-routes.test.ts"), "utf8");
    const agentLockTest = fs.readFileSync(path.join(root, "tests", "pwa-agent-config-lock.test.ts"), "utf8");

    expect(routeTest).toContain("pwa_model_locked");
    expect(agentLockTest).toContain("pwa_model_locked");
  });

  it("asserts the shared renderer sources contain the PWA layout fixes", () => {
    expect(appSource).toContain("parent.style.setProperty('--input-card-h'");
    expect(appSource).toContain("parent.style.setProperty('--input-card-bottom-inset'");
    expect(chatCss).toContain("--chat-scrollbar-bottom-inset");
    expect(chatCss).toContain("bottom: calc(var(--chat-scrollbar-bottom-inset) + var(--space-lg))");
    expect(settingsCss).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(settingsCss).toContain("media-provider-defaults-grid");
  });
});
