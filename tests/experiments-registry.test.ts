import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.js";
import {
  CACHE_SNAPSHOT_EXPERIMENT_ID,
  COMPACTION_MODE_EXPERIMENT_ID,
  DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID,
  EDITABLE_MEMORY_EXPERIMENT_ID,
  PROACTIVE_SUBAGENT_EXPERIMENT_ID,
  getExperimentDefinitions,
  getResolvedExperimentValue,
  setExperimentValue,
} from "../lib/experiments/registry.js";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-experiments-"));
  const userDir = path.join(root, "user");
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "preferences.json"), "{}\n");
  return { root, prefs: new PreferencesManager({ userDir, agentsDir }) };
}

function makePrefsWithPreferences(preferences) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-experiments-"));
  const userDir = path.join(root, "user");
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "preferences.json"), JSON.stringify(preferences, null, 2) + "\n");
  return { root, prefs: new PreferencesManager({ userDir, agentsDir }) };
}

describe("experiment registry", () => {
  it("keeps retired cache snapshot out of visible definitions while resolving it to off", () => {
    const defs = getExperimentDefinitions();
    const entry = defs.find((def) => def.id === CACHE_SNAPSHOT_EXPERIMENT_ID);

    expect(entry).toBeUndefined();
    const { prefs } = makePrefs();
    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("off");
  });

  it("rejects unknown experiment ids without writing preferences", () => {
    const { prefs } = makePrefs();

    expect(() => setExperimentValue(prefs, "unknown.flag", true)).toThrow("unknown experiment id");
    expect(prefs.getPreferences().experiments).toBeUndefined();
  });

  it("normalizes retired cache snapshot writes back to off", () => {
    const { prefs } = makePrefs();

    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("off");
    expect(setExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID, "shadow")).toBe("off");
    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("off");
    expect(prefs.getPreferences().experiments[CACHE_SNAPSHOT_EXPERIMENT_ID]).toBe("off");
  });

  it("migrates persisted retired cache snapshot preferences back to off on startup", () => {
    const { prefs } = makePrefsWithPreferences({
      experiments: {
        [CACHE_SNAPSHOT_EXPERIMENT_ID]: "write",
        [DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID]: true,
      },
    });

    expect(prefs.getPreferences().experiments).toMatchObject({
      [CACHE_SNAPSHOT_EXPERIMENT_ID]: "off",
      [DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID]: true,
    });
  });

  it("does not validate retired cache snapshot values as active enum options", () => {
    const { prefs } = makePrefs();

    expect(setExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID, "maybe")).toBe("off");
    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("off");
  });

  it("defines the session compaction mode experiment", () => {
    const defs = getExperimentDefinitions();
    const entry = defs.find((def) => def.id === COMPACTION_MODE_EXPERIMENT_ID);

    expect(entry).toMatchObject({
      id: "session.compaction_mode",
      owner: "session",
      scope: "global",
      defaultValue: "auto",
      valueSchema: {
        type: "enum",
        presentation: { type: "select" },
      },
    });
    expect(entry.valueSchema.options.map((opt) => opt.value)).toEqual([
      "auto",
      "cache_preserving",
      "pi_compatible",
    ]);
  });

  it("defines provider and subagent boolean experiments from the upstream TS registry", () => {
    const defs = getExperimentDefinitions();
    const deepseek = defs.find((def) => def.id === DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID);
    const proactive = defs.find((def) => def.id === PROACTIVE_SUBAGENT_EXPERIMENT_ID);

    expect(deepseek).toMatchObject({
      id: "provider.deepseek_roleplay_reasoning_patch",
      owner: "provider",
      scope: "global",
      defaultValue: false,
      valueSchema: {
        type: "boolean",
        presentation: { type: "toggle" },
      },
    });
    expect(proactive).toMatchObject({
      id: "subagent.proactive_delegation",
      owner: "session",
      scope: "global",
      defaultValue: false,
      valueSchema: {
        type: "boolean",
        presentation: { type: "toggle" },
      },
    });
  });

  it("defines editable memory facts as an opt-in global boolean experiment", () => {
    const defs = getExperimentDefinitions();
    const entry = defs.find((def) => def.id === EDITABLE_MEMORY_EXPERIMENT_ID);

    expect(entry).toMatchObject({
      id: "memory.editable_facts",
      owner: "memory",
      scope: "global",
      defaultValue: false,
      valueSchema: {
        type: "boolean",
        presentation: { type: "toggle" },
      },
    });
  });

  it("persists and resolves session compaction mode values", () => {
    const { prefs } = makePrefs();

    expect(getResolvedExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID)).toBe("auto");
    expect(setExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID, "pi_compatible")).toBe("pi_compatible");
    expect(getResolvedExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID)).toBe("pi_compatible");
  });

  it("persists and resolves provider boolean experiment values", () => {
    const { prefs } = makePrefs();

    expect(getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)).toBe(false);
    expect(setExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID, true)).toBe(true);
    expect(getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)).toBe(true);
    expect(setExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID, false)).toBe(false);
    expect(getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)).toBe(false);
  });
});
