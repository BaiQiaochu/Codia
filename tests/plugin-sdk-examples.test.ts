import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const exampleDir = path.join(root, "examples", "plugins", "sdk-showcase");

describe("plugin SDK examples and docs", () => {
  it("documents the SDK package map in a top-level guide", () => {
    const guide = fs.readFileSync(path.join(root, "PLUGIN_SDK.md"), "utf-8");

    expect(guide).toContain("@g-sap/plugin-protocol");
    expect(guide).toContain("@g-sap/plugin-sdk");
    expect(guide).toContain("@g-sap/plugin-runtime");
    expect(guide).toContain("@g-sap/plugin-components");
    expect(guide).toContain("gsap.assets.url");
    expect(guide).toContain("gsap.api.fetch");
    expect(guide).toContain("ctx.network.fetch");
    expect(guide).toContain("network.fetch");
    expect(guide).toContain("npm run build:packages");
  });

  it("documents network/API helpers in package READMEs and the plugin creator skill", () => {
    const sdkReadme = fs.readFileSync(path.join(root, "packages", "plugin-sdk", "README.md"), "utf-8");
    const runtimeReadme = fs.readFileSync(path.join(root, "packages", "plugin-runtime", "README.md"), "utf-8");
    const creatorSkill = fs.readFileSync(path.join(root, "skills2set", "gsap-plugin-creator", "SKILL.md"), "utf-8");

    expect(sdkReadme).toContain("gsap.api.fetch");
    expect(runtimeReadme).toContain("ctx.network.fetch");
    expect(creatorSkill).toContain("network.fetch");
    expect(creatorSkill).toContain("gsap.api.fetch");
  });

  it("ships a showcase plugin manifest that exercises iframe grants and UI contributions", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(exampleDir, "manifest.json"), "utf-8"));

    expect(manifest).toMatchObject({
      manifestVersion: 1,
      id: "sdk-showcase",
      trust: "full-access",
      ui: {
        hostCapabilities: ["external.open", "clipboard.writeText"],
      },
      contributes: {
        page: { route: "/page" },
        widget: { route: "/widget" },
      },
    });
  });

  it("covers runtime tools, EventBus, iframe SDK, and shared components in example source", () => {
    const index = fs.readFileSync(path.join(exampleDir, "index.js"), "utf-8");
    const tool = fs.readFileSync(path.join(exampleDir, "tools", "create-note.js"), "utf-8");
    const panel = fs.readFileSync(path.join(exampleDir, "ui", "Panel.tsx"), "utf-8");
    const readme = fs.readFileSync(path.join(exampleDir, "README.md"), "utf-8");

    expect(index).toContain("definePlugin");
    expect(index).toContain("defineBusHandler");
    expect(index).toContain("GSAP_BUS_SKIP");
    expect(tool).toContain("defineTool");
    expect(tool).toContain("createMediaDetails");
    expect(panel).toContain("@g-sap/plugin-sdk");
    expect(panel).toContain("@g-sap/plugin-components");
    expect(panel).toContain("GsapThemeProvider");
    expect(readme).toContain("bundle the UI");
    expect(readme).toContain("gsap.assets.url");
  });

  it("scaffolds provider contribution plugins with explicit media capabilities", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-provider-scaffold-"));
    try {
      const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
      execFileSync(python, [
        path.join(root, "skills2set", "gsap-plugin-creator", "scripts", "create_gsap_plugin.py"),
        "Jimeng Provider",
        "--path",
        tmpDir,
        "--kind",
        "provider",
        "--audience",
        "developer",
      ], { cwd: root, stdio: "pipe" });

      const pluginDir = path.join(tmpDir, "jimeng-provider");
      const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf-8"));
      const provider = fs.readFileSync(path.join(pluginDir, "providers", "jimeng-provider-provider.js"), "utf-8");
      const readme = fs.readFileSync(path.join(pluginDir, "README.md"), "utf-8");

      expect(manifest).toMatchObject({
        id: "jimeng-provider",
        trust: "full-access",
      });
      expect(provider).toContain('export const id = "jimeng-provider"');
      expect(provider).toContain('kind: "local-cli"');
      expect(provider).toContain('chat: { projection: "none" }');
      expect(provider).toContain("imageGeneration");
      expect(provider).toContain("file_glob");
      expect(readme).toContain("provider contribution");
      expect(readme).toContain("structured argument bindings");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
