import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { describe, expect, it } from "vitest";
import { LATEST_DATA_VERSION, runMigrations } from "../core/migrations.js";

describe("migration #33 beautify defaults", () => {
  it("adds beautify to existing explicit disabled tool lists during upgrade", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-migrate-beautify-"));
    try {
      const agentsDir = path.join(root, "agents");
      const agentDir = path.join(agentsDir, "agent-a");
      fs.mkdirSync(agentDir, { recursive: true });
      const configPath = path.join(agentDir, "config.yaml");
      fs.writeFileSync(configPath, [
        "agent:",
        "  name: Agent A",
        "tools:",
        "  disabled:",
        "    - browser",
        "",
      ].join("\n"), "utf-8");

      let preferences = { _dataVersion: 32 };
      const prefs = {
        getPreferences: () => preferences,
        savePreferences: (next) => { preferences = next; },
      };

      runMigrations({
        gsapHome: root,
        agentsDir,
        prefs,
        providerRegistry: {},
        log: () => {},
      });

      const config = YAML.load(fs.readFileSync(configPath, "utf-8"));
      expect(config.tools.disabled).toEqual(["browser", "beautify", "workflow"]);
      expect(preferences._dataVersion).toBe(LATEST_DATA_VERSION);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds workflow to existing explicit disabled tool lists during upgrade", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-migrate-workflow-"));
    try {
      const agentsDir = path.join(root, "agents");
      const agentDir = path.join(agentsDir, "agent-a");
      fs.mkdirSync(agentDir, { recursive: true });
      const configPath = path.join(agentDir, "config.yaml");
      fs.writeFileSync(configPath, [
        "agent:",
        "  name: Agent A",
        "tools:",
        "  disabled:",
        "    - browser",
        "    - beautify",
        "",
      ].join("\n"), "utf-8");

      let preferences = { _dataVersion: 33 };
      const prefs = {
        getPreferences: () => preferences,
        savePreferences: (next) => { preferences = next; },
      };

      runMigrations({
        gsapHome: root,
        agentsDir,
        prefs,
        providerRegistry: {},
        log: () => {},
      });

      const config = YAML.load(fs.readFileSync(configPath, "utf-8"));
      expect(config.tools.disabled).toEqual(["browser", "beautify", "workflow"]);
      expect(preferences._dataVersion).toBe(LATEST_DATA_VERSION);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
