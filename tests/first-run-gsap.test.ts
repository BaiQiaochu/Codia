import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "js-yaml";
import { ensureFirstRun } from "../core/first-run.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

describe("ensureFirstRun gsap defaults", () => {
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
      "  name: G-SAP",
      "  yuan: gsap",
      "user:",
      "  name: \"\"",
      "",
    ].join("\n"));
    writeFile(path.join(productDir, "identity.example.md"), "# {{agentName}}\n");
    writeFile(path.join(productDir, "ishiki.example.md"), "# Ishiki\n");
    writeFile(path.join(productDir, "public-ishiki-templates", "gsap.md"), "# Public Ishiki\n");
    writeFile(path.join(root, "skills2set", "gsap-plugin-creator", "SKILL.md"), "---\nname: gsap-plugin-creator\n---\n");
    writeFile(path.join(root, "skills2set", "codex-cli-multiturn-tools", "SKILL.md"), "---\nname: codex-cli-multiturn-tools\n---\n");
    writeFile(path.join(root, "skills2set", "office-documents", "SKILL.md"), "---\nname: office-documents\n---\n");
    writeFile(path.join(root, "skills2set", "quiet-musing", "SKILL.md"), "---\nname: quiet-musing\n---\n");
    writeFile(path.join(root, "skills2set", "skill-creator", "SKILL.md"), "---\nname: skill-creator\n---\n");
    writeFile(path.join(root, "skills2set", "user-guide", "SKILL.md"), "---\nname: user-guide\n---\n");
    return productDir;
  }

  it("seeds gsap as the default agent id and primary agent", () => {
    const root = createTempRoot("gsap-first-run-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    ensureFirstRun(homeDir, productDir);

    expect(fs.existsSync(path.join(homeDir, "agents", "gsap", "config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, "agents", "hanako"))).toBe(false);

    const prefs = JSON.parse(fs.readFileSync(path.join(homeDir, "user", "preferences.json"), "utf-8"));
    expect(prefs.primaryAgent).toBe("gsap");

    const cfg = YAML.load(fs.readFileSync(path.join(homeDir, "agents", "gsap", "config.yaml"), "utf-8"));
    expect(cfg.agent.yuan).toBe("gsap");
  });

  it("imports every bundled skill under the debranded namespace on first run", () => {
    const root = createTempRoot("gsap-first-run-skills-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    ensureFirstRun(homeDir, productDir);

    for (const skillName of [
      "codex-cli-multiturn-tools",
      "gsap-plugin-creator",
      "office-documents",
      "quiet-musing",
      "skill-creator",
      "user-guide",
    ]) {
      expect(fs.existsSync(path.join(homeDir, "skills", skillName, "SKILL.md")), skillName).toBe(true);
    }
    expect(fs.existsSync(path.join(homeDir, "skills", "hana-plugin-creator"))).toBe(false);
  });

  it("repairs a partial gsap agent directory that is missing config.yaml", () => {
    const root = createTempRoot("gsap-first-run-partial-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    fs.mkdirSync(path.join(homeDir, "agents", "gsap", "memory"), { recursive: true });
    writeFile(path.join(homeDir, "agents", "gsap", "pinned.md"), "keep me");
    writeFile(path.join(homeDir, "user", "preferences.json"), JSON.stringify({ primaryAgent: "gsap" }, null, 2));

    ensureFirstRun(homeDir, productDir);

    const configPath = path.join(homeDir, "agents", "gsap", "config.yaml");
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(path.join(homeDir, "agents", "gsap", "pinned.md"), "utf-8")).toBe("keep me");

    const cfg = YAML.load(fs.readFileSync(configPath, "utf-8"));
    expect(cfg.agent.name).toBe("G-SAP");
    expect(cfg.agent.yuan).toBe("gsap");
  });

  it("repairs primaryAgent when it points at an agent without config.yaml", () => {
    const root = createTempRoot("gsap-first-run-primary-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    fs.mkdirSync(path.join(homeDir, "agents", "broken-agent"), { recursive: true });
    writeFile(path.join(homeDir, "user", "preferences.json"), JSON.stringify({ primaryAgent: "broken-agent" }, null, 2));

    ensureFirstRun(homeDir, productDir);

    const prefs = JSON.parse(fs.readFileSync(path.join(homeDir, "user", "preferences.json"), "utf-8"));
    expect(prefs.primaryAgent).toBe("gsap");
  });

  it("migrates the legacy default agent identity to the neutral assistant name", () => {
    const root = createTempRoot("gsap-first-run-legacy-name-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    writeFile(path.join(homeDir, "agents", "hanako", "config.yaml"), [
      "agent:",
      "  name: Hanako",
      "  yuan: hanako",
      "user:",
      "  name: \"\"",
      "",
    ].join("\n"));
    writeFile(path.join(homeDir, "user", "preferences.json"), JSON.stringify({ primaryAgent: "hanako" }, null, 2));

    ensureFirstRun(homeDir, productDir);
    ensureFirstRun(homeDir, productDir);

    expect(fs.existsSync(path.join(homeDir, "agents", "hanako"))).toBe(false);
    const prefs = JSON.parse(fs.readFileSync(path.join(homeDir, "user", "preferences.json"), "utf-8"));
    expect(prefs.primaryAgent).toBe("gsap");

    const cfg = YAML.load(fs.readFileSync(path.join(homeDir, "agents", "gsap", "config.yaml"), "utf-8"));
    expect(cfg.agent.name).toBe("小豆蔻");
    expect(cfg.agent.yuan).toBe("gsap");
  });

  it("repairs an already-renamed default agent that still has the legacy name", () => {
    const root = createTempRoot("gsap-first-run-renamed-legacy-name-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    writeFile(path.join(homeDir, "agents", "gsap", "config.yaml"), [
      "agent:",
      "  name: Hanako",
      "  yuan: gsap",
      "user:",
      "  name: \"\"",
      "",
    ].join("\n"));
    writeFile(path.join(homeDir, "user", "preferences.json"), JSON.stringify({ primaryAgent: "gsap" }, null, 2));

    ensureFirstRun(homeDir, productDir);

    const cfg = YAML.load(fs.readFileSync(path.join(homeDir, "agents", "gsap", "config.yaml"), "utf-8"));
    expect(cfg.agent.name).toBe("小豆蔻");
    expect(cfg.agent.yuan).toBe("gsap");
  });

  it("neutralizes the retired G-SAP default display name without changing the agent id", () => {
    const root = createTempRoot("gsap-first-run-retired-display-name-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    writeFile(path.join(homeDir, "agents", "gsap", "config.yaml"), [
      "agent:",
      "  name: G-SAP",
      "  yuan: gsap",
      "",
    ].join("\n"));
    writeFile(
      path.join(homeDir, "agents", "gsap", "identity.md"),
      "# G-SAP\n\nDefault assistant identity.\n",
    );

    ensureFirstRun(homeDir, productDir);

    const cfg = YAML.load(fs.readFileSync(path.join(homeDir, "agents", "gsap", "config.yaml"), "utf-8"));
    expect(cfg.agent.name).toBe("小豆蔻");
    expect(cfg.agent.yuan).toBe("gsap");
    expect(fs.readFileSync(path.join(homeDir, "agents", "gsap", "identity.md"), "utf-8"))
      .toBe("# 小豆蔻\n\nDefault assistant identity.\n");
  });

  it("prunes legacy Hermes imported skills that are no longer bundled", () => {
    const root = createTempRoot("gsap-skill-prune-");
    const homeDir = path.join(root, "home");
    const productDir = createProductDir(root);

    writeFile(path.join(homeDir, "skills", "quiet-musing", "SKILL.md"), "---\nname: quiet-musing\n---\n");
    writeFile(path.join(homeDir, "skills", "fastmcp", "SKILL.md"), "---\nname: fastmcp\n---\n");
    writeFile(
      path.join(homeDir, "skills", "fastmcp", ".hermes-import.json"),
      JSON.stringify({ importedFrom: "legacy" }),
    );

    ensureFirstRun(homeDir, productDir);

    expect(fs.existsSync(path.join(homeDir, "skills", "quiet-musing"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, "skills", "fastmcp"))).toBe(false);
  });
});
