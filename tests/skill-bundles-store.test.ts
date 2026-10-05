// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSkillBundle,
  deleteSkillBundle,
  detachAgentFromBundles,
  loadSkillBundleStore,
  removeSkillsFromBundles,
  reorderSkillBundles,
  updateSkillBundle,
} from "../lib/skill-bundles/store.js";

describe("skill bundle store", () => {
  let tempDir;
  let engine;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-skill-bundles-"));
    engine = { gsapHome: tempDir };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not create an empty store when removing skills and no bundle store exists", () => {
    const store = removeSkillsFromBundles(engine, ["missing"]);

    expect(store).toEqual({ schemaVersion: 1, bundles: [] });
    expect(fs.existsSync(path.join(tempDir, "skill-bundles.json"))).toBe(false);
  });

  it("creates, updates, deletes, and reorders user-managed bundles", () => {
    const bundle = createSkillBundle(engine, {
      name: "Coding Bundle",
      skillNames: ["writer", "writer", "reader"],
    });

    expect(bundle).toMatchObject({
      id: "coding-bundle",
      name: "Coding Bundle",
      skillNames: ["writer", "reader"],
      source: "user",
      agentId: null,
      sourcePackage: null,
    });

    const updated = updateSkillBundle(engine, bundle.id, {
      name: "Work Bundle",
      skillNames: ["reader", "debugger"],
    });
    expect(updated).toMatchObject({
      id: bundle.id,
      name: "Work Bundle",
      skillNames: ["reader", "debugger"],
    });

    const second = createSkillBundle(engine, { name: "Second Bundle", skillNames: ["reader"] });
    const reordered = reorderSkillBundles(engine, [second.id, bundle.id]);
    expect(reordered.bundles.map(item => item.id)).toEqual([second.id, bundle.id]);

    expect(deleteSkillBundle(engine, bundle.id)).toBe(true);
    expect(loadSkillBundleStore(engine).bundles.map(item => item.id)).toEqual([second.id]);
  });

  it("supports empty manual bundles but removes bundles emptied by deleted skills", () => {
    const manual = createSkillBundle(engine, { name: "Empty Bundle" });
    expect(manual.skillNames).toEqual([]);
    expect(loadSkillBundleStore(engine).bundles).toHaveLength(1);

    updateSkillBundle(engine, manual.id, { skillNames: ["only-skill"] });
    const store = removeSkillsFromBundles(engine, ["only-skill"]);

    expect(store.bundles).toEqual([]);
  });

  it("detaches deleted agents from imported bundles while keeping bundle membership", () => {
    const bundle = createSkillBundle(engine, {
      name: "G-SAP Bundle",
      skillNames: ["quiet-musing", "skill-creator"],
      source: "character-card-import",
      agentId: "gsap-2",
      sourcePackage: "gsap-character-card.zip",
    });

    const store = detachAgentFromBundles(engine, "gsap-2");
    expect(store.bundles).toHaveLength(1);
    expect(store.bundles[0]).toMatchObject({
      id: bundle.id,
      agentId: null,
      skillNames: ["quiet-musing", "skill-creator"],
      source: "character-card-import",
      sourcePackage: "gsap-character-card.zip",
    });
  });
});
