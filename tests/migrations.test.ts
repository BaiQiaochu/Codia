/**
 * core/migrations.js 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { LATEST_DATA_VERSION, runMigrations } from "../core/migrations.js";

// ── 测试工具 ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-migrations-"));
}

/** 最小化 PreferencesManager stub */
function makePrefs(userDir) {
  const p = path.join(userDir, "preferences.json");
  fs.mkdirSync(userDir, { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, "{}", "utf-8");
  return {
    getPreferences() { return JSON.parse(fs.readFileSync(p, "utf-8")); },
    savePreferences(data) {
      fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
    },
  };
}

/** */
function makeRegistry(existingProviders) {
  const set = new Set(existingProviders);
  return { get(id) { return set.has(id) ? { id } : null; } };
}

function writeAgentConfig(agentsDir, agentId, config) {
  const dir = path.join(agentsDir, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }),
    "utf-8",
  );
}

function readAgentConfig(agentsDir, agentId) {
  return YAML.load(fs.readFileSync(path.join(agentsDir, agentId, "config.yaml"), "utf-8"));
}

function writeSessionJsonl(filePath, messages) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = messages.map((message, index) => JSON.stringify({
    type: "message",
    id: `m-${index + 1}`,
    timestamp: "2026-04-15T00:00:00.000Z",
    message,
  }));
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

function readSessionJsonl(filePath) {
  return fs.readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ── runner 行为 ──────────────────────────────────────────────────────────────

describe("runMigrations runner", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("upgrades dataVersion from 0 to latest on first run", () => {
    const prefs = makePrefs(userDir);
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });

    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    expect(prefs.getPreferences()._dataVersion).toBeGreaterThan(0);
  });

  it("skips already migrated versions", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 9999 });

    writeAgentConfig(agentsDir, "hana", { api: { provider: "ghost-provider" } });

    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    //
    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("ghost-provider");
  });
});

//

describe("migration #12: backfill legacy session files into sidecars", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration12() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 11 });
    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  it("registers legacy stage_files, present_files, and artifacts without rewriting the session jsonl", () => {
    writeAgentConfig(agentsDir, "gsap", { agent: { name: "G-SAP" }, api: { provider: "" } });
    const sessionPath = path.join(agentsDir, "gsap", "sessions", "legacy.jsonl");
    const stagePath = path.join(tmpDir, "legacy-image.png");
    const presentPath = path.join(tmpDir, "legacy-present.txt");
    const artifactPath = path.join(tmpDir, "legacy-artifact.md");
    fs.writeFileSync(stagePath, "png-bytes");
    fs.writeFileSync(presentPath, "present");
    fs.writeFileSync(artifactPath, "# Artifact\n");
    writeSessionJsonl(sessionPath, [
      {
        role: "toolResult",
        toolName: "stage_files",
        details: { files: [{ filePath: stagePath, label: "Legacy Image" }] },
      },
      {
        role: "toolResult",
        toolName: "present_files",
        details: { filePath: presentPath, label: "Legacy Present" },
      },
      {
        role: "toolResult",
        toolName: "create_artifact",
        details: {
          artifactId: "art-old",
          type: "markdown",
          title: "Legacy Artifact",
          content: "# Artifact",
          artifactFile: { filePath: artifactPath, label: "Legacy Artifact.md" },
        },
      },
    ]);

    const before = fs.readFileSync(sessionPath, "utf-8");
    const prefs = runMigration12();

    const sidecar = JSON.parse(fs.readFileSync(`${sessionPath}.files.json`, "utf-8"));
    const files = Object.values(sidecar.files);
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: stagePath, origin: "stage_files", status: "available" }),
      expect.objectContaining({ filePath: presentPath, origin: "stage_files", status: "available" }),
      expect.objectContaining({ filePath: artifactPath, origin: "agent_artifact", status: "available" }),
    ]));
    expect(fs.readFileSync(sessionPath, "utf-8")).toBe(before);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

//

describe("migration #1: cleanDanglingProviderRefs", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("clears api.provider when it points to a missing provider", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "dead-provider" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      gsapHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("");
  });

  it("keeps references to existing providers", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "openai" },
      models: { chat: "openai/gpt-4o" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      gsapHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("openai");
    expect(config.models.chat).toEqual({ id: "gpt-4o", provider: "openai" });
  });

  it("clears dangling provider/model chat references", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: "minimax-token_plan/minimax-large", utility: "openai/gpt-4o-mini" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      gsapHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.models.chat).toBe("");
    expect(config.models.utility).toEqual({ id: "gpt-4o-mini", provider: "openai" });
  });

  it("clears dangling object chat model references", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: { id: "some-model", provider: "dead-provider" } },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      gsapHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.models.chat).toBe("");
  });

  it("clears dangling embedding provider references", () => {
    writeAgentConfig(agentsDir, "hana", {
      embedding_api: { provider: "dead" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      gsapHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.embedding_api.provider).toBe("");
  });

  it("clears dangling shared model references in preferences", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      utility_large_model: { id: "some-model", provider: "dead" },
      utility_api_provider: "also-dead",
    });
    fs.mkdirSync(agentsDir, { recursive: true });

    runMigrations({
      gsapHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const p = prefs.getPreferences();
    expect(p.utility_large_model).toBeNull();
    expect(p.utility_api_provider).toBeNull();
  });

  it("clears dangling string shared model references in preferences", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      summarizer_model: "dead-provider/fast-model",
    });
    fs.mkdirSync(agentsDir, { recursive: true });

    runMigrations({
      gsapHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const p = prefs.getPreferences();
    expect(p.summarizer_model).toBeUndefined();
  });

  it("repairs multiple agents at the same time", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "dead" } });
    writeAgentConfig(agentsDir, "butter", { api: { provider: "openai" } });
    writeAgentConfig(agentsDir, "xiaohua", {
      api: { provider: "dead" },
      models: { chat: "dead/model" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      gsapHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    expect(readAgentConfig(agentsDir, "hana").api.provider).toBe("");
    expect(readAgentConfig(agentsDir, "butter").api.provider).toBe("openai");
    expect(readAgentConfig(agentsDir, "xiaohua").api.provider).toBe("");
    expect(readAgentConfig(agentsDir, "xiaohua").models.chat).toBe("");
  });
});

//

describe("migration #2: migrateBridgeToPerAgent", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /** */
  function runMigration2(prefs) {
    const p = prefs.getPreferences();
    p._dataVersion = 1;
    prefs.savePreferences(p);

    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  it("migrates a single-agent telegram bridge owner into config.yaml", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      bridge: {
        telegram: { token: "tok123", webhook: true },
        owner: { telegram: "user-001" },
        readOnly: false,
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge.telegram.token).toBe("tok123");
    expect(config.bridge.telegram.webhook).toBe(true);
    expect(config.bridge.telegram.owner).toBe("user-001");

    // prefs.bridge should be deleted
    const p = prefs.getPreferences();
    expect(p.bridge).toBeUndefined();
  });

  it("migrates grouped bridge config to each target agent", () => {
    writeAgentConfig(agentsDir, "agent-a", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "agent-b", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "agent-a",
      bridge: {
        telegram: { token: "tg-tok", agentId: "agent-a" },
        feishu: { appId: "fs-app", agentId: "agent-b" },
        owner: {},
        readOnly: false,
      },
    });

    runMigration2(prefs);

    const cfgA = readAgentConfig(agentsDir, "agent-a");
    const cfgB = readAgentConfig(agentsDir, "agent-b");

    expect(cfgA.bridge.telegram.token).toBe("tg-tok");
    expect(cfgA.bridge.telegram.agentId).toBeUndefined(); // agentId stripped
    expect(cfgA.bridge.feishu).toBeUndefined();

    expect(cfgB.bridge.feishu.appId).toBe("fs-app");
    expect(cfgB.bridge.feishu.agentId).toBeUndefined();
    expect(cfgB.bridge.telegram).toBeUndefined();
  });

  it("migrates legacy owner key into primary agent", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      bridge: {
        telegram: { token: "tok" },
        owner: { telegram: "legacy-owner" },
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge.telegram.owner).toBe("legacy-owner");
  });

  it("migrates composite owner key into the matching agent", () => {
    writeAgentConfig(agentsDir, "agent-a", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "agent-a",
      bridge: {
        telegram: { token: "tok", agentId: "agent-a" },
        owner: {
          telegram: "legacy-owner",
          "telegram:agent-a": "composite-owner",
        },
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "agent-a");
    // composite key takes priority over legacy key
    expect(config.bridge.telegram.owner).toBe("composite-owner");
  });

  it("no-ops when bridge config is missing", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ primaryAgent: "hana" });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge).toBeUndefined();

    const p = prefs.getPreferences();
    expect(p.bridge).toBeUndefined();
  });

  it("falls back to primaryAgent when agentId points to a deleted agent", () => {
    // agent-a does NOT exist, only hana exists
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      bridge: {
        telegram: { token: "tok", agentId: "deleted-agent" },
        owner: {},
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge.telegram.token).toBe("tok");
    expect(config.bridge.telegram.agentId).toBeUndefined();
  });

  it("keeps bridge.readOnly as a global preference", () => {
    writeAgentConfig(agentsDir, "primary", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "secondary", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "primary",
      bridge: {
        telegram: { token: "tg", agentId: "primary" },
        feishu: { appId: "fs", agentId: "secondary" },
        owner: {},
        readOnly: true,
      },
    });

    runMigration2(prefs);

    const cfgPrimary = readAgentConfig(agentsDir, "primary");
    const cfgSecondary = readAgentConfig(agentsDir, "secondary");

    expect(cfgPrimary.bridge.readOnly).toBeUndefined();
    expect(cfgSecondary.bridge.readOnly).toBeUndefined();
    expect(prefs.getPreferences().bridge?.readOnly).toBe(true);
  });
});

//

describe("migration #3: migrateWorkspaceToPerAgent", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration3(prefs) {
    const p = prefs.getPreferences();
    p._dataVersion = 2;
    prefs.savePreferences(p);
    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  it("migrates home_folder to primary agent config.yaml", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/Users/test/Desktop",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk.home_folder).toBe("/Users/test/Desktop");

    const p = prefs.getPreferences();
    expect(p.home_folder).toBeUndefined();
    expect(p._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("skips when home_folder is empty", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ primaryAgent: "hana", _dataVersion: 2 });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk).toBeUndefined();
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("falls back to first agent when primaryAgent not found", () => {
    writeAgentConfig(agentsDir, "alpha", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "deleted-agent",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "alpha");
    expect(config.desk.home_folder).toBe("/workspace");
    expect(prefs.getPreferences().home_folder).toBeUndefined();
  });

  it("does not write home_folder to non-primary agents, but disables their heartbeat", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "assistant", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const gsapConfig = readAgentConfig(agentsDir, "hana");
    const assistantConfig = readAgentConfig(agentsDir, "assistant");
    expect(gsapConfig.desk.home_folder).toBe("/workspace");
    expect(assistantConfig.desk.home_folder).toBeUndefined();
    expect(assistantConfig.desk.heartbeat_enabled).toBe(false);
  });

  it("preserves data when no agent config.yaml exists (version stays at 2)", () => {
    fs.mkdirSync(path.join(agentsDir, "hana"), { recursive: true });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    // migration #3 throws internally; runner catches it and breaks without bumping version
    runMigration3(prefs);

    const p = prefs.getPreferences();
    expect(p.home_folder).toBe("/workspace");
    expect(p._dataVersion).toBe(2);
  });

  it("is idempotent: rerun after success is a no-op", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);

    // Manually reset _dataVersion to 2 to simulate forced rerun
    const p2 = prefs.getPreferences();
    p2._dataVersion = 2;
    prefs.savePreferences(p2);
    runMigration3(prefs);

    // home_folder is gone from prefs, so migration skips cleanly
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk.home_folder).toBe("/workspace");
  });

  it("preserves existing desk fields when merging home_folder", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "" },
      desk: { heartbeat_enabled: false, heartbeat_interval: 30 },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk.home_folder).toBe("/workspace");
    expect(config.desk.heartbeat_enabled).toBe(false);
    expect(config.desk.heartbeat_interval).toBe(30);
  });

  it("disables heartbeat for non-primary agents", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "assistant", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "research", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    // Primary agent keeps heartbeat on (default)
    const gsapConfig = readAgentConfig(agentsDir, "hana");
    expect(gsapConfig.desk.heartbeat_enabled).toBeUndefined();

    // Non-primary agents get heartbeat disabled
    const assistantConfig = readAgentConfig(agentsDir, "assistant");
    expect(assistantConfig.desk.heartbeat_enabled).toBe(false);

    const researchConfig = readAgentConfig(agentsDir, "research");
    expect(researchConfig.desk.heartbeat_enabled).toBe(false);
  });

  it("respects existing heartbeat_enabled on non-primary agents", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "assistant", {
      api: { provider: "" },
      desk: { heartbeat_enabled: true },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    //
    const assistantConfig = readAgentConfig(agentsDir, "assistant");
    expect(assistantConfig.desk.heartbeat_enabled).toBe(true);
  });
});

describe("migration #4: migrateSubagentExecutorMetadata", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration4(prefs) {
    const p = prefs.getPreferences();
    p._dataVersion = 3;
    prefs.savePreferences(p);
    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  it("migrates explicit delegated executor metadata into parent session history and child sidecar", () => {
    writeAgentConfig(agentsDir, "hanako", { agent: { name: "Hanako" }, api: { provider: "" } });
    writeAgentConfig(agentsDir, "butter", { agent: { name: "butter" }, api: { provider: "" } });
    const prefs = makePrefs(userDir);
    const parentSessionPath = path.join(agentsDir, "hanako", "sessions", "parent.jsonl");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");

    writeSessionJsonl(parentSessionPath, [
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "delegate to butter",
          agentId: "butter",
          agentName: "butter",
          sessionPath: childSessionPath,
          streamStatus: "done",
        },
      },
    ]);
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");

    runMigration4(prefs);

    const entries = readSessionJsonl(parentSessionPath);
    const details = entries[1].message.details;
    expect(details.executorAgentId).toBe("butter");
    expect(details.executorAgentNameSnapshot).toBe("butter");
    expect(details.executorMetaVersion).toBe(1);

    const sidecar = JSON.parse(fs.readFileSync(path.join(path.dirname(childSessionPath), "session-meta.json"), "utf-8"));
    expect(sidecar["child.jsonl"]).toMatchObject({
      executorAgentId: "butter",
      executorAgentNameSnapshot: "butter",
      executorMetaVersion: 1,
    });
  });

  it("backfills legacy self-dispatch records from the owning agent directory when executor metadata is missing", () => {
    writeAgentConfig(agentsDir, "hanako", { agent: { name: "Hanako" }, api: { provider: "" } });
    const prefs = makePrefs(userDir);
    const parentSessionPath = path.join(agentsDir, "hanako", "sessions", "parent.jsonl");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");

    writeSessionJsonl(parentSessionPath, [
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "self-dispatch legacy task",
          sessionPath: childSessionPath,
          streamStatus: "done",
        },
      },
    ]);
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");

    runMigration4(prefs);

    const entries = readSessionJsonl(parentSessionPath);
    const details = entries[1].message.details;
    expect(details.executorAgentId).toBe("hanako");
    expect(details.executorAgentNameSnapshot).toBe("Hanako");
    expect(details.agentId).toBe("hanako");
    expect(details.agentName).toBe("Hanako");

    const sidecar = JSON.parse(fs.readFileSync(path.join(path.dirname(childSessionPath), "session-meta.json"), "utf-8"));
    expect(sidecar["child.jsonl"]).toMatchObject({
      executorAgentId: "hanako",
      executorAgentNameSnapshot: "Hanako",
      executorMetaVersion: 1,
    });
  });
});

describe("migration #5: migrateModelRefsToCompositeKey", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function makeRegistryWithModels(entries) {
    return {
      get: (id) => ({ id }),
      getAllProvidersRaw: () => {
        const providers = {};
        for (const [provider, modelIds] of Object.entries(entries)) {
          providers[provider] = { models: modelIds };
        }
        return providers;
      },
    };
  }

  function runMigration5(prefs, providerRegistry) {
    const p = prefs.getPreferences();
    p._dataVersion = 4;
    prefs.savePreferences(p);
    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry,
      log: () => {},
    });
  }

  it("normalizes agent config models.chat from provider/id string to object", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: "openai/gpt-4o", utility: "qwen-plus" },
    });
    const prefs = makePrefs(userDir);

    runMigration5(prefs, makeRegistryWithModels({ openai: ["gpt-4o"], dashscope: ["qwen-plus"] }));

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.models.chat).toEqual({ id: "gpt-4o", provider: "openai" });
    expect(config.models.utility).toEqual({ id: "qwen-plus", provider: "dashscope" });
  });

  it("normalizes shared model preferences from bare id to object", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      utility_model: "qwen-plus",
      utility_large_model: { id: "gpt-4.1", provider: "" },
      _dataVersion: 4,
    });

    runMigration5(prefs, makeRegistryWithModels({
      dashscope: ["qwen-plus"],
      openai: ["gpt-4.1"],
    }));

    const next = prefs.getPreferences();
    expect(next.utility_model).toEqual({ id: "qwen-plus", provider: "dashscope" });
    expect(next.utility_large_model).toEqual({ id: "gpt-4.1", provider: "openai" });
    expect(next._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #20: Pi model input schema compatibility", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = tmpDir;
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("removes invalid Pi input modalities and preserves G-SAP video capability in compat", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 19 });
    const modelsJsonPath = path.join(tmpDir, "models.json");
    fs.writeFileSync(modelsJsonPath, JSON.stringify({
      providers: {
        dashscope: {
          models: [
            { id: "qwen3-vl-plus", name: "Qwen VL", input: ["text", "image", "video"] },
            { id: "qwen-plus", name: "Qwen Plus", input: ["text", "audio"] },
            { id: "custom-video", name: "Custom Video", input: ["video"], video: true },
          ],
          modelOverrides: {
            "qwen3-vl-plus": { input: ["text", "image", "video"] },
            "qwen-plus": { input: ["text", "audio"] },
          },
        },
      },
    }, null, 2) + "\n", "utf-8");

    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const raw = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(raw.providers.dashscope.models[0]).toMatchObject({
      id: "qwen3-vl-plus",
      input: ["text", "image"],
      compat: { gsapVideoInput: true },
    });
    expect(raw.providers.dashscope.models[0].compat).not.toHaveProperty("hanaVideoInput");
    expect(raw.providers.dashscope.models[1]).toMatchObject({
      id: "qwen-plus",
      input: ["text"],
    });
    expect(raw.providers.dashscope.models[1].compat?.gsapVideoInput).toBeUndefined();
    expect(raw.providers.dashscope.models[2]).toMatchObject({
      id: "custom-video",
      input: ["text"],
      compat: { gsapVideoInput: true },
    });
    expect(raw.providers.dashscope.models[2]).not.toHaveProperty("video");
    expect(raw.providers.dashscope.modelOverrides["qwen3-vl-plus"]).toMatchObject({
      input: ["text", "image"],
      compat: { gsapVideoInput: true },
    });
    expect(raw.providers.dashscope.modelOverrides["qwen-plus"]).toEqual({
      input: ["text"],
    });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #21: video transport capability refresh", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = tmpDir;
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("repairs existing models.json entries for newly declared Kimi video models", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 20 });
    const modelsJsonPath = path.join(tmpDir, "models.json");
    fs.writeFileSync(modelsJsonPath, JSON.stringify({
      providers: {
        moonshot: {
          models: [
            { id: "kimi-k2.6", name: "Kimi K2.6", input: ["text", "image"] },
          ],
        },
      },
    }, null, 2) + "\n", "utf-8");

    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const raw = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(raw.providers.moonshot.models[0]).toMatchObject({
      id: "kimi-k2.6",
      input: ["text", "image"],
      compat: { gsapVideoInput: true },
    });
    expect(raw.providers.moonshot.models[0].compat).not.toHaveProperty("hanaVideoInput");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #22-25: channel phone metadata compatibility", () => {
  let tmpDir, userDir, agentsDir, channelsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    channelsDir = path.join(tmpDir, "channels");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("adds explicit channel phone defaults and removes deprecated free-text reply scope fields", () => {
    fs.writeFileSync(
      path.join(channelsDir, "ch_crew.md"),
      [
        "---",
        "id: ch_crew",
        "members: [hana, butter, ming]",
        "name: Crew",
        "agentPhoneReplyInstructions: legacy",
        "---",
        "",
        "### user | 2026-05-12 12:00:00",
        "",
        "hello",
        "",
      ].join("\n"),
      "utf-8",
    );

    const conversationsDir = path.join(agentsDir, "hana", "phone", "conversations");
    fs.mkdirSync(conversationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(conversationsDir, "ch_crew.md"),
      [
        "---",
        "agentId: hana",
        "conversationId: ch_crew",
        "replyInstructions: legacy",
        "replyMinChars: 20",
        "---",
        "",
        "# Agent Phone",
        "",
      ].join("\n"),
      "utf-8",
    );

    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 21 });
    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const raw = fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8");
    expect(raw).toContain("agentPhoneReminderIntervalMinutes: 31");
    expect(raw).toContain("agentPhoneProactiveEnabled: true");
    expect(raw).toContain("agentPhoneModelOverrideEnabled: false");
    expect(raw).toContain("agentPhoneGuardLimit: 36");
    expect(raw).not.toContain("agentPhoneReplyInstructions");
    expect(raw).toContain("### user | 2026-05-12 12:00:00");

    const projectionRaw = fs.readFileSync(path.join(conversationsDir, "ch_crew.md"), "utf-8");
    expect(projectionRaw).not.toContain("replyInstructions");
    expect(projectionRaw).toContain("replyMinChars: 20");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("preserves channels where proactive initiation was explicitly disabled", () => {
    fs.writeFileSync(
      path.join(channelsDir, "ch_quiet.md"),
      [
        "---",
        "id: ch_quiet",
        "members: [hana, butter]",
        "agentPhoneProactiveEnabled: false",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );

    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 24 });
    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const raw = fs.readFileSync(path.join(channelsDir, "ch_quiet.md"), "utf-8");
    expect(raw).toContain("agentPhoneProactiveEnabled: false");
    expect(raw.match(/agentPhoneProactiveEnabled/g)).toHaveLength(1);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #28: durable subagent run registry", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  it("backfills durable subagent run mappings from existing deferred metadata", () => {
    const prefs = makePrefs(userDir);
    const childSessionPath = path.join(agentsDir, "gsap", "subagent-sessions", "child.jsonl");
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");

    writeJson(path.join(tmpDir, ".ephemeral", "deferred-tasks.json"), {
      "subagent-legacy": {
        status: "resolved",
        result: "done",
        reason: null,
        deferredAt: 1710000000000,
        meta: {
          type: "subagent",
          sessionPath: childSessionPath,
          summary: "legacy summary",
          requestedAgentId: "gsap",
          requestedAgentNameSnapshot: "G-SAP",
          executorAgentId: "gsap",
          executorAgentNameSnapshot: "G-SAP",
          executorMetaVersion: 1,
        },
      },
    });

    prefs.savePreferences({ _dataVersion: 25 });
    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const registry = readJson(path.join(tmpDir, "subagent-runs.json"));
    expect(registry.runs["subagent-legacy"]).toMatchObject({
      taskId: "subagent-legacy",
      childSessionPath,
      status: "resolved",
      summary: "done",
      requestedAgentId: "gsap",
      executorAgentId: "gsap",
    });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("backfills completed child-session mappings from parent session history", () => {
    const prefs = makePrefs(userDir);
    const parentSessionPath = path.join(agentsDir, "gsap", "sessions", "parent.jsonl");
    const childSessionPath = path.join(agentsDir, "gsap", "subagent-sessions", "child.jsonl");
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");
    writeSessionJsonl(parentSessionPath, [
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-with-child",
          task: "work",
          sessionPath: childSessionPath,
          streamStatus: "done",
          requestedAgentId: "gsap",
          requestedAgentNameSnapshot: "G-SAP",
          executorAgentId: "gsap",
          executorAgentNameSnapshot: "G-SAP",
          executorMetaVersion: 1,
        },
      },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-without-child",
          task: "lost",
          streamStatus: "running",
        },
      },
    ]);

    prefs.savePreferences({ _dataVersion: 25 });
    runMigrations({
      gsapHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const registry = readJson(path.join(tmpDir, "subagent-runs.json"));
    expect(registry.runs["subagent-with-child"]).toMatchObject({
      taskId: "subagent-with-child",
      parentSessionPath,
      childSessionPath,
      status: "resolved",
      requestedAgentId: "gsap",
      executorAgentId: "gsap",
    });
    expect(registry.runs["subagent-without-child"]).toBeUndefined();
  });
});
