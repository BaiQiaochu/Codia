import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("first run default workspace", () => {
  let tmpDir;
  let homeDir;
  let productDir;
  let codiaHome;
  let homedirSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-first-run-workspace-"));
    homeDir = path.join(tmpDir, "home");
    productDir = path.join(tmpDir, "product");
    codiaHome = path.join(tmpDir, ".codia");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(productDir, { recursive: true });
    fs.writeFileSync(
      path.join(productDir, "config.example.yaml"),
      [
        "agent:",
        "  name: Codia",
        "  yuan: codia",
        "user:",
        '  name: ""',
        "models:",
        '  chat: ""',
      ].join("\n"),
      "utf-8",
    );
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  });

  afterEach(() => {
    homedirSpy?.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("seeds the default assistant with the CODIA workspace and safe runtime defaults", async () => {
    const { ensureFirstRun } = await import("../core/first-run.ts");

    ensureFirstRun(codiaHome, productDir);

    const workspace = path.join(homeDir, "Desktop", "Codia-Workspace");
    const cfgPath = path.join(codiaHome, "agents", "codia", "config.yaml");
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));

    expect(fs.statSync(workspace).isDirectory()).toBe(true);
    expect(cfg.desk.home_folder).toBe(workspace);
    expect(cfg.desk.heartbeat_enabled).toBe(false);
    expect(cfg.desk.heartbeat_interval).toBe(31);
    expect(cfg.memory.enabled).toBe(true);
  });
});
