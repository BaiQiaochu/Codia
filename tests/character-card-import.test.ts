import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCharacterCardService } from "../lib/character-cards/service.js";
import { createCharacterCardsRoute } from "../server/routes/character-cards.js";
import { extractZip } from "../lib/extract-zip.js";
import { writeZipFromDirectory } from "../lib/zip-writer.js";

const DEFAULT_EXPORT_AVATAR_HASH = "624e42fa61ac15a1ad6f9559035fe2c1e2ae802cc1b79a152762397f422e9c7d";

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function fileHash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeSkill(root, relativeDir, name, body = "# Skill\n") {
  const dir = path.join(root, relativeDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\n${body}`, "utf-8");
  return dir;
}

function expectAppEvent(emitEvent, type, payload) {
  expect(emitEvent).toHaveBeenCalledWith({
    type: "app_event",
    event: {
      type,
      payload,
      source: "server",
    },
  }, null);
}

describe("character-card import/export service", () => {
  let tempDir;
  let packageDir;
  let skillsDir;
  let agentsDir;
  let engine;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-character-card-"));
    packageDir = path.join(tempDir, "package");
    skillsDir = path.join(tempDir, "skills");
    agentsDir = path.join(tempDir, "agents");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });

	    engine = {
	      codiaHome: tempDir,
      agentsDir,
      userSkillsDir: skillsDir,
      skillsDir,
      cwd: tempDir,
      deskCwd: tempDir,
      reloadSkills: vi.fn().mockResolvedValue(undefined),
      createAgent: vi.fn(async ({ id, name }) => {
        const agentDir = path.join(agentsDir, id);
        fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
        return { id, name };
      }),
      getAgent: vi.fn(() => ({ factStore: { importAll: vi.fn(), exportAll: vi.fn(() => []) } })),
      getAllSkills: vi.fn(() => []),
      invalidateAgentListCache: vi.fn(),
      emitEvent: vi.fn(),
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("imports packaged skills, records their bundle, and creates the agent with isolated enabled skills", async () => {
    writeSkill(skillsDir, "code-writer", "code-writer", "existing");
    writeSkill(packageDir, "skills/code-writer", "code-writer", "imported");
    writeJson(path.join(packageDir, "card.json"), {
      kind: "CharacterCard",
      package: { name: "Codia Writer Card" },
      agent: { name: "Codia Writer", id: "codia-writer", yuan: "codia" },
      skills: {
        bundles: [
          { name: "Coding Bundle", skills: [{ path: "skills/code-writer" }] },
        ],
      },
    });

    const service = createCharacterCardService(engine);
    const plan = await service.createImportPlanFromPath(packageDir);
    expect(plan).toMatchObject({
      packageName: "Codia Writer Card",
      agent: { name: "Codia Writer", yuan: "codia" },
      skills: { count: 1 },
      assets: { avatar: true, cardFront: true },
    });

    const result = await service.commitImportPlan(plan.token, { importMemory: false });
    const importedName = result.installedSkills[0].name;

    expect(importedName).toMatch(/^code-writer-[a-z0-9]{6}$/);
    expect(fs.readFileSync(path.join(skillsDir, "code-writer", "SKILL.md"), "utf-8")).toContain("existing");
    expect(fs.readFileSync(path.join(skillsDir, importedName, "SKILL.md"), "utf-8")).toContain(`name: ${importedName}`);
    expect(engine.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      id: "codia-writer",
      name: "Codia Writer",
      yuan: "codia",
      enabledSkills: [importedName],
    }));

    const bundleStore = JSON.parse(fs.readFileSync(path.join(tempDir, "skill-bundles.json"), "utf-8"));
    expect(bundleStore.bundles[0]).toMatchObject({
      name: "Coding Bundle",
      source: "character-card-import",
      agentId: "codia-writer",
      skillNames: [importedName],
      sourcePackage: "Codia Writer Card",
    });
  });

  it("normalizes removed Hermes character-card yuan values to the debranded default", async () => {
    writeJson(path.join(packageDir, "card.json"), {
      kind: "CharacterCard",
      package: { name: "Legacy Hermes Card" },
      agent: { name: "Legacy Hermes", id: "legacy-hermes", yuan: "hermes" },
    });

    const service = createCharacterCardService(engine);
    const plan = await service.createImportPlanFromPath(packageDir);
    expect(plan.agent).toMatchObject({
      name: "Legacy Hermes",
      yuan: "codia",
    });

    await service.commitImportPlan(plan.token, { importMemory: false });

    expect(engine.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      id: "legacy-hermes",
      name: "Legacy Hermes",
      yuan: "codia",
    }));
  });

  it("exports an agent package with Codia naming and no original project branding", async () => {
    const agentDir = path.join(agentsDir, "codia");
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), [
      "agent:",
      "  name: Codia Helper",
      "  yuan: codia",
      "skills:",
      "  enabled:",
      "    - writer",
    ].join("\n"), "utf-8");
    fs.writeFileSync(path.join(agentDir, "identity.md"), "Codia identity", "utf-8");
    fs.writeFileSync(path.join(agentDir, "ishiki.md"), "Codia private prompt", "utf-8");
    fs.writeFileSync(path.join(agentDir, "public-ishiki.md"), "Codia public prompt", "utf-8");
    fs.writeFileSync(path.join(agentDir, "description.md"), "<mood>hidden</mood>\nLocal assistant card", "utf-8");
    fs.writeFileSync(path.join(agentDir, "memory", "facts.md"), "User prefers concise answers.", "utf-8");
    writeSkill(skillsDir, "writer", "writer", "exported skill");

    engine.getAgent = vi.fn((id) => id === "codia"
      ? { id: "codia", agentDir, factStore: { exportAll: vi.fn(() => []) } }
      : null);
    engine.getAllSkills = vi.fn(() => [
      {
        name: "writer",
        enabled: true,
        baseDir: path.join(skillsDir, "writer"),
        filePath: path.join(skillsDir, "writer", "SKILL.md"),
        source: "user",
      },
    ]);

    const service = createCharacterCardService(engine);
    const preview = await service.createExportPreview("codia");
    expect(preview).toMatchObject({
      mode: "export",
      agentId: "codia",
      packageName: "codia-helper-character-card.zip",
      agent: { name: "Codia Helper", yuan: "codia", description: "Local assistant card" },
      skills: { count: 1 },
    });

    const exported = await service.exportAgentPackage("codia", {
      exportMemory: true,
      targetDir: tempDir,
    });
    expect(exported.filePath).toBe(path.join(tempDir, "codia-helper-character-card.zip"));

    const outDir = path.join(tempDir, "unzipped-export");
    fs.mkdirSync(outDir);
    await extractZip(exported.filePath, outDir);
    const card = JSON.parse(fs.readFileSync(path.join(outDir, "card.json"), "utf-8"));
    expect(card.agent).toEqual({ name: "Codia Helper", yuan: "codia", description: "Local assistant card" });
    expect(card.skills.bundles[0].skills).toEqual([{ name: "writer", path: "skills/writer" }]);
    expect(JSON.stringify(card)).toMatch(/codia/i);
  });

  it("sanitizes legacy original-project branding from exported package text", async () => {
    const agentDir = path.join(agentsDir, "legacy");
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), [
      "agent:",
      "  name: Codia Helper",
      "  yuan: codia",
      "skills:",
      "  enabled:",
      "    - codia-writer",
    ].join("\n"), "utf-8");
    fs.writeFileSync(path.join(agentDir, "identity.md"), "You are Codia, the Codia assistant.", "utf-8");
    fs.writeFileSync(path.join(agentDir, "ishiki.md"), "Codia should keep the Codia tone.", "utf-8");
    fs.writeFileSync(path.join(agentDir, "public-ishiki.md"), "Project Codia public prompt.", "utf-8");
    fs.writeFileSync(path.join(agentDir, "description.md"), "Codia description", "utf-8");
    fs.writeFileSync(path.join(agentDir, "memory", "facts.md"), "User migrated from Codia.", "utf-8");
    writeSkill(skillsDir, "codia-writer", "codia-writer", "Codia skill body");
    fs.mkdirSync(path.join(skillsDir, "codia-writer", "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "codia-writer", "docs", "codia-guide.md"),
      "Codia nested guide",
      "utf-8",
    );

    engine.getAgent = vi.fn((id) => id === "legacy"
      ? { id: "legacy", agentDir, factStore: { exportAll: vi.fn(() => [{ fact: "Codia fact", tags: ["codia"] }]) } }
      : null);
    engine.getAllSkills = vi.fn(() => [
      {
        name: "codia-writer",
        enabled: true,
        baseDir: path.join(skillsDir, "codia-writer"),
        filePath: path.join(skillsDir, "codia-writer", "SKILL.md"),
        source: "user",
      },
    ]);

    const service = createCharacterCardService(engine);
    const preview = await service.createExportPreview("legacy");
    expect(JSON.stringify(preview)).toMatch(/codia/i);

    const exported = await service.exportAgentPackage("legacy", {
      exportMemory: true,
      targetDir: tempDir,
    });
    const outDir = path.join(tempDir, "unzipped-legacy-export");
    fs.mkdirSync(outDir);
    await extractZip(exported.filePath, outDir);

    const textFiles = [];
    const stack = [outDir];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/\.(json|ya?ml|md|txt)$/i.test(entry.name)) textFiles.push(full);
      }
    }

    expect(textFiles.length).toBeGreaterThan(0);
    const exportedText = textFiles
      .map(file => `${path.relative(outDir, file)}\n${fs.readFileSync(file, "utf-8")}`)
      .join("\n---\n");
    expect(exportedText).toMatch(/codia/i);
    expect(exportedText).toContain("Codia");
    const exportedEntries = [];
    const entryStack = [outDir];
    while (entryStack.length > 0) {
      const current = entryStack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        exportedEntries.push(path.relative(outDir, full));
        if (entry.isDirectory()) entryStack.push(full);
      }
    }
    expect(exportedEntries.join("\n")).toMatch(/codia/i);
    expect(fs.existsSync(path.join(outDir, "skills", "codia-writer", "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(outDir, "skills", "codia-writer", "SKILL.md"), "utf-8"))
      .toContain("name: codia-writer");
  });

  it("uses the debranded export avatar when the agent has no custom avatar", async () => {
    const agentDir = path.join(agentsDir, "codia");
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), [
      "agent:",
      "  name: Codia Helper",
      "  yuan: codia",
    ].join("\n"), "utf-8");
    engine.getAgent = vi.fn((id) => id === "codia"
      ? { id: "codia", agentDir, factStore: { exportAll: vi.fn(() => []) } }
      : null);

    const service = createCharacterCardService(engine);
    const avatar = service.resolveExportAsset("codia", "avatar");
    expect(avatar.filePath).toContain(path.join("desktop", "src", "assets", "character-cards"));
    expect(fileHash(avatar.filePath)).toBe(DEFAULT_EXPORT_AVATAR_HASH);

    const exported = await service.exportAgentPackage("codia", { targetDir: tempDir });
    const outDir = path.join(tempDir, "unzipped-default-avatar-export");
    fs.mkdirSync(outDir);
    await extractZip(exported.filePath, outDir);
    const card = JSON.parse(fs.readFileSync(path.join(outDir, "card.json"), "utf-8"));
    expect(card.assets.avatar).toBe("assets/avatar.png");
    expect(fileHash(path.join(outDir, card.assets.avatar))).toBe(DEFAULT_EXPORT_AVATAR_HASH);
  });

  it("keeps the agent custom avatar when exporting character cards", () => {
    const agentDir = path.join(agentsDir, "custom-avatar");
    const avatarDir = path.join(agentDir, "avatars");
    fs.mkdirSync(avatarDir, { recursive: true });
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), [
      "agent:",
      "  name: Custom Avatar",
      "  yuan: codia",
    ].join("\n"), "utf-8");
    const customAvatarPath = path.join(avatarDir, "agent.png");
    fs.writeFileSync(customAvatarPath, Buffer.from("custom avatar image"));
    engine.getAgent = vi.fn((id) => id === "custom-avatar"
      ? { id: "custom-avatar", agentDir, factStore: { exportAll: vi.fn(() => []) } }
      : null);

    const service = createCharacterCardService(engine);
    const avatar = service.resolveExportAsset("custom-avatar", "avatar");
    expect(avatar.filePath).toBe(customAvatarPath);
    expect(fileHash(avatar.filePath)).not.toBe(DEFAULT_EXPORT_AVATAR_HASH);
  });

  it("uses the unified CODIA emblem for built-in character-card identity", async () => {
    writeJson(path.join(packageDir, "card.json"), {
      kind: "CharacterCard",
      package: { name: "Fallback Assets Card" },
      agent: { name: "Fallback Assets", id: "fallback-assets", yuan: "codia" },
    });

    const agentDir = path.join(agentsDir, "codia");
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), [
      "agent:",
      "  name: Codia Helper",
      "  yuan: codia",
    ].join("\n"), "utf-8");
    engine.getAgent = vi.fn((id) => id === "codia"
      ? { id: "codia", agentDir, factStore: { exportAll: vi.fn(() => []) } }
      : null);

    const service = createCharacterCardService(engine);
    const importPlan = await service.createImportPlanFromPath(packageDir);
    const importAvatar = service.resolvePlanAsset(importPlan.token, "avatar");
    const importBack = service.resolvePlanAsset(importPlan.token, "cardBack");
    const importIcon = service.resolvePlanAsset(importPlan.token, "yuanIcon");
    expect(fileHash(importBack.filePath)).not.toBe(fileHash(importAvatar.filePath));
    expect(fileHash(importIcon.filePath)).toBe(fileHash(importAvatar.filePath));

    const exportBack = service.resolveExportAsset("codia", "cardBack");
    const exportIcon = service.resolveExportAsset("codia", "yuanIcon");
    expect(exportBack.filePath).toContain(path.join("desktop", "src", "assets", "character-cards"));
    expect(exportIcon.filePath).toContain(path.join("desktop", "src", "assets", "character-cards"));
    expect(fileHash(exportBack.filePath)).not.toBe(fileHash(service.resolveExportAsset("codia", "avatar").filePath));
    expect(fileHash(exportIcon.filePath)).toBe(fileHash(service.resolveExportAsset("codia", "avatar").filePath));

    const exported = await service.exportAgentPackage("codia", { targetDir: tempDir });
    const outDir = path.join(tempDir, "unzipped-fallback-export");
    fs.mkdirSync(outDir);
    await extractZip(exported.filePath, outDir);
    const card = JSON.parse(fs.readFileSync(path.join(outDir, "card.json"), "utf-8"));
    expect(card.assets).toMatchObject({
      avatar: "assets/avatar.png",
      cardBack: "assets/card-back.png",
      yuanIcon: "assets/yuan-icon.png",
    });
    expect(fileHash(path.join(outDir, card.assets.cardBack))).not.toBe(fileHash(path.join(outDir, card.assets.avatar)));
    expect(fileHash(path.join(outDir, card.assets.yuanIcon))).toBe(fileHash(path.join(outDir, card.assets.avatar)));
    expect(JSON.stringify(card)).toMatch(/codia/i);
  });

  it("plans and commits through the route, then emits agent and skill events", async () => {
    writeSkill(packageDir, "skills/research", "research");
    writeJson(path.join(packageDir, "card.json"), {
      kind: "CharacterCard",
      agent: { name: "Research Codia", id: "research-codia", yuan: "codia" },
      skills: [{ path: "skills/research" }],
    });

    const app = new Hono();
    app.route("/api", createCharacterCardsRoute(engine));

    const planRes = await app.request("/api/character-cards/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: packageDir }),
    });
    const planData = await planRes.json();
    expect(planRes.status).toBe(200);
    expect(planData.plan).toMatchObject({
      packageName: "package",
      agent: { name: "Research Codia", yuan: "codia" },
      skills: { count: 1 },
    });
    expect(planData.plan.agent.id).toBeUndefined();

    const importRes = await app.request("/api/character-cards/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: planData.plan.token }),
    });
    const importData = await importRes.json();
    expect(importRes.status).toBe(200);
    expect(importData.agent).toEqual({ id: "research-codia", name: "Research Codia" });
    expectAppEvent(engine.emitEvent, "agent-created", { agentId: "research-codia", name: "Research Codia" });
    expectAppEvent(engine.emitEvent, "skills-changed", { agentId: "research-codia" });
  });

  it("sanitizes multipart upload names before writing temporary character-card packages", async () => {
    const app = new Hono();
    app.route("/api", createCharacterCardsRoute(engine));
    const form = new FormData();
    form.append("file", new File(["not a zip"], "bad<name>\u0001\u007f:path?.zip", {
      type: "application/zip",
    }));

    const res = await app.request("/api/character-cards/plan", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const uploadDir = path.join(tempDir, ".ephemeral", "character-card-uploads");
    const uploaded = fs.readdirSync(uploadDir);
    expect(uploaded).toHaveLength(1);
    const forbiddenNameChars = new Set([
      ...'<>:"/\\|?*',
      ...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)),
      String.fromCharCode(127),
    ]);
    expect([...uploaded[0]].some((char) => forbiddenNameChars.has(char))).toBe(false);
    expect(uploaded[0]).toMatch(/badnamepath\.zip$/);
  });

  it("plans branded and legacy package uploads whose extension omits .zip", async () => {
    writeJson(path.join(packageDir, "card.json"), {
      kind: "CharacterCard",
      package: { name: "Legacy Character Package" },
      agent: { name: "Legacy Assistant", id: "legacy-assistant", yuan: "codia" },
    });
    const packagePath = path.join(tempDir, "legacy-package.zip");
    await writeZipFromDirectory(packageDir, packagePath);
    const bytes = fs.readFileSync(packagePath);

    const app = new Hono();
    app.route("/api", createCharacterCardsRoute(engine));

    for (const fileName of ["legacy.codia-package", "legacy.codia-package"]) {
      const form = new FormData();
      form.append("file", new File([bytes], fileName, { type: "application/octet-stream" }));

      const res = await app.request("/api/character-cards/plan", {
        method: "POST",
        body: form,
      });
      const data = await res.json();

      expect(res.status, fileName).toBe(200);
      expect(data.plan).toMatchObject({
        packageName: "Legacy Character Package",
        agent: { name: "Legacy Assistant", yuan: "codia" },
      });
    }
  });
});
