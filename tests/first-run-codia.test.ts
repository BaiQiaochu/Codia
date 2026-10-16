import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "js-yaml";
import { ensureFirstRun } from "../core/first-run.js";
import { DEFAULT_WORKSPACE_DIRNAME } from "../shared/default-workspace-constants.ts";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

describe("ensureFirstRun codia defaults", () => {
  const tempRoots = [];

  afterEach(() => {
    while (tempRoots.length) {
      fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
    }
  });

  function createTempRoot(prefix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  function createProductDir(root) {
    const productDir = path.join(root, "lib");
    writeFile(path.join(productDir, "config.example.yaml"), [
      "agent:",
      "  name: Codia",
      "  yuan: codia",
      "user:",
      "  name: \"\"",
      "",
    ].join("\n"));
    writeFile(path.join(productDir, "identity.example.md"), "# {{agentName}}\n");
    writeFile(path.join(productDir, "ishiki.example.md"), "# Ishiki\n");
    writeFile(path.join(productDir, "public-ishiki-templates", "codia.md"), "# Public Ishiki\n");
    writeFile(path.join(root, "skills2set", "codia-plugin-creator", "SKILL.md"), "---\nname: codia-plugin-creator\n---\n");
    writeFile(path.join(root, "skills2set", "codex-cli-multiturn-tools", "SKILL.md"), "---\nname: codex-cli-multiturn-tools\n---\n");
    writeFile(path.join(root, "skills2set", "office-documents", "SKILL.md"), "---\nname: office-documents\n---\n");
    writeFile(path.join(root, "skills2set", "quiet-musing", "SKILL.md"), "---\nname: quiet-musing\n---\n");
    writeFile(path.join(root, "skills2set", "skill-creator", "SKILL.md"), "---\nname: skill-creator\n---\n");
    writeFile(path.join(root, "skills2set", "user-guide", "SKILL.md"), "---\nname: user-guide\n---\n");
    return productDir;
  }

  it("seeds codia as the default agent id and primary agent", () => {
    const root = createTempRoot("codia-first-run-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    ensureFirstRun(homeDir, productDir, { defaultWorkspaceHome: homeDir });

    expect(fs.existsSync(path.join(homeDir, "agents", "codia", "config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, "agents", "codia"))).toBe(true);

    const prefs = JSON.parse(fs.readFileSync(path.join(homeDir, "user", "preferences.json"), "utf-8"));
    expect(prefs.primaryAgent).toBe("codia");

    const cfg = YAML.load(fs.readFileSync(path.join(homeDir, "agents", "codia", "config.yaml"), "utf-8"));
    expect(cfg.agent.yuan).toBe("codia");
  });

  it("imports every bundled skill under the debranded namespace on first run", () => {
    const root = createTempRoot("codia-first-run-skills-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    ensureFirstRun(homeDir, productDir, { defaultWorkspaceHome: homeDir });

    for (const skillName of [
      "codex-cli-multiturn-tools",
      "codia-plugin-creator",
      "office-documents",
      "quiet-musing",
      "skill-creator",
      "user-guide",
    ]) {
      expect(fs.existsSync(path.join(homeDir, "skills", skillName, "SKILL.md")), skillName).toBe(true);
    }
    expect(fs.existsSync(path.join(homeDir, "skills", "codia-plugin-creator"))).toBe(true);
  });

  it("repairs a partial codia agent directory that is missing config.yaml", () => {
    const root = createTempRoot("codia-first-run-partial-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    fs.mkdirSync(path.join(homeDir, "agents", "codia", "memory"), { recursive: true });
    writeFile(path.join(homeDir, "agents", "codia", "pinned.md"), "keep me");
    writeFile(path.join(homeDir, "user", "preferences.json"), JSON.stringify({ primaryAgent: "codia" }, null, 2));

    ensureFirstRun(homeDir, productDir, { defaultWorkspaceHome: homeDir });

    const configPath = path.join(homeDir, "agents", "codia", "config.yaml");
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(path.join(homeDir, "agents", "codia", "pinned.md"), "utf-8")).toBe("keep me");

    const cfg = YAML.load(fs.readFileSync(configPath, "utf-8"));
    expect(cfg.agent.name).toBe("小豆蔻");
    expect(cfg.desk.home_folder).toBe(path.join(homeDir, "Desktop", DEFAULT_WORKSPACE_DIRNAME));
    expect(fs.existsSync(cfg.desk.home_folder)).toBe(true);
    expect(cfg.agent.yuan).toBe("codia");
  });

  it("repairs primaryAgent when it points at an agent without config.yaml", () => {
    const root = createTempRoot("codia-first-run-primary-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    fs.mkdirSync(path.join(homeDir, "agents", "broken-agent"), { recursive: true });
    writeFile(path.join(homeDir, "user", "preferences.json"), JSON.stringify({ primaryAgent: "broken-agent" }, null, 2));

    ensureFirstRun(homeDir, productDir, { defaultWorkspaceHome: homeDir });

    const prefs = JSON.parse(fs.readFileSync(path.join(homeDir, "user", "preferences.json"), "utf-8"));
    expect(prefs.primaryAgent).toBe("codia");
  });

  it("prunes legacy Hermes imported skills that are no longer bundled", () => {
    const root = createTempRoot("codia-skill-prune-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    writeFile(path.join(homeDir, "skills", "quiet-musing", "SKILL.md"), "---\nname: quiet-musing\n---\n");
    writeFile(path.join(homeDir, "skills", "fastmcp", "SKILL.md"), "---\nname: fastmcp\n---\n");
    writeFile(
      path.join(homeDir, "skills", "fastmcp", ".hermes-import.json"),
      JSON.stringify({ importedFrom: "legacy" }),
    );

    ensureFirstRun(homeDir, productDir, { defaultWorkspaceHome: homeDir });

    expect(fs.existsSync(path.join(homeDir, "skills", "quiet-musing"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, "skills", "fastmcp"))).toBe(false);
  });
});
