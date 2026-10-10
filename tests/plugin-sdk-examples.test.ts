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

    expect(guide).toContain("@codia/plugin-protocol");
    expect(guide).toContain("@codia/plugin-sdk");
    expect(guide).toContain("@codia/plugin-runtime");
    expect(guide).toContain("@codia/plugin-components");
    expect(guide).toContain("codia.assets.url");
    expect(guide).toContain("codia.api.fetch");
    expect(guide).toContain("ctx.network.fetch");
    expect(guide).toContain("network.fetch");
    expect(guide).toContain("npm run build:packages");
  });

  it("documents network/API helpers in package READMEs and the plugin creator skill", () => {
    const sdkReadme = fs.readFileSync(path.join(root, "packages", "plugin-sdk", "README.md"), "utf-8");
    const runtimeReadme = fs.readFileSync(path.join(root, "packages", "plugin-runtime", "README.md"), "utf-8");
    const creatorSkill = fs.readFileSync(path.join(root, "skills2set", "codia-plugin-creator", "SKILL.md"), "utf-8");

    expect(sdkReadme).toContain("codia.api.fetch");
    expect(runtimeReadme).toContain("ctx.network.fetch");
    expect(creatorSkill).toContain("network.fetch");
    expect(creatorSkill).toContain("codia.api.fetch");
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
    expect(index).toContain("CODIA_BUS_SKIP");
    expect(tool).toContain("defineTool");
    expect(tool).toContain("createMediaDetails");
    expect(panel).toContain("@codia/plugin-sdk");
    expect(panel).toContain("@codia/plugin-components");
    expect(panel).toContain("CodiaThemeProvider");
    expect(readme).toContain("bundle the UI");
    expect(readme).toContain("codia.assets.url");
  });

  it("scaffolds provider contribution plugins with explicit media capabilities", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-provider-scaffold-"));
    try {
      const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
      execFileSync(python, [
        path.join(root, "skills2set", "codia-plugin-creator", "scripts", "create_codia_plugin.py"),
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
