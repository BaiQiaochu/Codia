// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractZip } from "../lib/extract-zip.js";
import { t } from "../server/i18n.js";

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

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC32_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf-8");
    const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), "utf-8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

describe("skills route", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-skills-route-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  it("runtime=1 returns workspace skills in the runtime view while default remains agent skills", async () => {
    const agentId = "codia";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Codia\n", "utf-8");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();

    const getAllSkills = vi.fn(() => [{ name: "global-skill", enabled: true }]);
    const getRuntimeSkills = vi.fn(() => [
      { name: "global-skill", enabled: true },
      { name: "workspace-skill", enabled: true, managedBy: "workspace" },
    ]);

    const engine = {
      agentsDir: tempRoot,
      getAllSkills,
      getRuntimeSkills,
    };

    app.route("/api", createSkillsRoute(engine));

    const defaultRes = await app.request(`/api/skills?agentId=${agentId}`);
    expect(defaultRes.status).toBe(200);
    expect(await defaultRes.json()).toEqual({
      skills: [{ name: "global-skill", enabled: true }],
    });
    expect(getAllSkills).toHaveBeenCalledWith(agentId);
    expect(getRuntimeSkills).not.toHaveBeenCalled();

    const runtimeRes = await app.request(`/api/skills?agentId=${agentId}&runtime=1`);
    expect(runtimeRes.status).toBe(200);
    expect(await runtimeRes.json()).toEqual({
      skills: [
        { name: "global-skill", enabled: true },
        { name: "workspace-skill", enabled: true, managedBy: "workspace" },
      ],
    });
    expect(getRuntimeSkills).toHaveBeenCalledWith(agentId);
  });

  it("filters out skills that have been replaced by built-in tools", async () => {
    const agentId = "codia";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Codia\n", "utf-8");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();

    const engine = {
      agentsDir: tempRoot,
      getAllSkills: vi.fn(() => [
        { name: "global-skill", enabled: true },
        { name: "hermes-agent", enabled: true },
      ]),
      getRuntimeSkills: vi.fn(() => [
        { name: "global-skill", enabled: true },
        { name: "hermes-agent", enabled: true },
      ]),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request(`/api/skills?agentId=${agentId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skills: [{ name: "global-skill", enabled: true }],
    });
  });

  it("rejects installing hermes-agent as a duplicate skill because hermes_agent is built in", async () => {
    const skillDir = path.join(tempRoot, "hermes-agent");
    const userSkillsDir = path.join(tempRoot, "user-skills");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(userSkillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: hermes-agent\n---\n",
      "utf-8",
    );

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();

    const engine = {
      agentsDir: tempRoot,
      userSkillsDir,
      reloadSkills: vi.fn(async () => {}),
      getAllSkills: vi.fn(() => []),
      getRuntimeSkills: vi.fn(() => []),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: skillDir }),
    });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toContain(
      t("error.skillAlreadyBuiltInTool", { name: "hermes-agent", tool: "hermes_agent" }),
    );
    expect(fs.existsSync(path.join(userSkillsDir, "hermes-agent"))).toBe(false);
    expect(engine.reloadSkills).not.toHaveBeenCalled();
  });

  it("installs an uploaded base64 skill package and cleans the temporary upload", async () => {
    const userSkillsDir = path.join(tempRoot, "user-skills");
    fs.mkdirSync(userSkillsDir, { recursive: true });
    const archive = createStoredZip([{
      name: "SKILL.md",
      content: "---\nname: uploaded-skill\n---\n\nUploaded skill\n",
    }]);

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const engine = {
      codiaHome: tempRoot,
      agentsDir: tempRoot,
      userSkillsDir,
      reloadSkills: vi.fn(async () => {}),
      getAllSkills: vi.fn(() => [{ name: "uploaded-skill", enabled: false, source: "user" }]),
      getRuntimeSkills: vi.fn(() => []),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: {
          filename: "uploaded.skill",
          contentBase64: archive.toString("base64"),
        },
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      skill: { name: "uploaded-skill" },
    });
    expect(fs.existsSync(path.join(userSkillsDir, "uploaded-skill", "SKILL.md"))).toBe(true);
    const uploadRoot = path.join(tempRoot, "tmp", "skill-install-uploads");
    const leftovers = fs.existsSync(uploadRoot) ? fs.readdirSync(uploadRoot) : [];
    expect(leftovers).toEqual([]);
  });

  it("translates skill names through the requested agent context", async () => {
    const agentId = "codia";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Codia\n", "utf-8");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const skills = [{ name: "workspace-skill", enabled: true }];
    const engine = {
      agentsDir: tempRoot,
      getAllSkills: vi.fn(() => skills),
      getRuntimeSkills: vi.fn(() => []),
      translateSkillNames: vi.fn(async () => ({ "workspace-skill": "工作区技能" })),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, names: ["workspace-skill"], lang: "zh" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ "workspace-skill": "工作区技能" });
    expect(engine.getAllSkills).toHaveBeenCalledWith(agentId);
    expect(engine.translateSkillNames).toHaveBeenCalledWith(
      ["workspace-skill"],
      "zh",
      { agentId, skills },
    );
  });

  it("rejects skill name translation without an agent id", async () => {
    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      getAllSkills: vi.fn(() => []),
      getRuntimeSkills: vi.fn(() => []),
      translateSkillNames: vi.fn(async () => ({})),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: ["workspace-skill"], lang: "zh" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "agentId is required" });
    expect(engine.translateSkillNames).not.toHaveBeenCalled();
  });

  it("lists skill bundles with the requested agent enabled state", async () => {
    const agentId = "codia";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Codia\n", "utf-8");
    fs.writeFileSync(path.join(tempRoot, "skill-bundles.json"), JSON.stringify({
      schemaVersion: 1,
      bundles: [
        {
          id: "coding",
          name: "Coding Bundle",
          skillNames: ["writer", "reader", "missing-skill"],
          source: "character-card-import",
          agentId,
          sourcePackage: "coding.zip",
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
      ],
    }, null, 2), "utf-8");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const engine = {
      codiaHome: tempRoot,
      agentsDir: tempRoot,
      getAllSkills: vi.fn(() => [
        { name: "writer", enabled: true, source: "user" },
        { name: "reader", enabled: false, source: "user" },
      ]),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request(`/api/skills/bundles?agentId=${agentId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      bundles: [
        {
          id: "coding",
          name: "Coding Bundle",
          skillNames: ["writer", "reader", "missing-skill"],
          source: "character-card-import",
          agentId,
          sourcePackage: "coding.zip",
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
          skills: [
            { name: "writer", displayName: "writer", displayNames: {}, shortDescription: "", shortDescriptions: {}, enabled: true, source: "user", missing: false },
            { name: "reader", displayName: "reader", displayNames: {}, shortDescription: "", shortDescriptions: {}, enabled: false, source: "user", missing: false },
            { name: "missing-skill", enabled: false, source: null, missing: true },
          ],
        },
      ],
    });
    expect(engine.getAllSkills).toHaveBeenCalledWith(agentId);
  });

  it("creates, updates, reorders, and deletes skill bundles through the skills route", async () => {
    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const engine = {
      codiaHome: tempRoot,
      agentsDir: tempRoot,
      emitEvent: vi.fn(),
      getAllSkills: vi.fn(() => [
        { name: "writer", enabled: false, source: "user" },
        { name: "reader", enabled: false, source: "user" },
      ]),
    };

    app.route("/api", createSkillsRoute(engine));

    const createRes = await app.request("/api/skills/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Writing Bundle", skillNames: ["writer", "writer"] }),
    });
    expect(createRes.status).toBe(200);
    expect(await createRes.json()).toMatchObject({
      ok: true,
      bundle: {
        id: "writing-bundle",
        name: "Writing Bundle",
        skillNames: ["writer"],
        source: "user",
      },
    });

    const secondRes = await app.request("/api/skills/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reading Bundle", skillNames: ["reader"] }),
    });
    expect(secondRes.status).toBe(200);

    const updateRes = await app.request("/api/skills/bundles/writing-bundle", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Writing Pack", skillNames: ["writer", "reader"] }),
    });
    expect(updateRes.status).toBe(200);
    expect(await updateRes.json()).toMatchObject({
      ok: true,
      bundle: { id: "writing-bundle", name: "Writing Pack", skillNames: ["writer", "reader"] },
    });

    const orderRes = await app.request("/api/skills/bundles/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleIds: ["reading-bundle", "writing-bundle"] }),
    });
    expect(orderRes.status).toBe(200);
    expect((await orderRes.json()).bundles.map(bundle => bundle.id)).toEqual(["reading-bundle", "writing-bundle"]);

    const deleteRes = await app.request("/api/skills/bundles/writing-bundle", { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });
    expectAppEvent(engine.emitEvent, "skills-changed", { agentId: null });
  });

  it("exports a skill bundle as a zip with only resolvable public skills", async () => {
    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const userSkillsDir = path.join(tempRoot, "user-skills");
    const exportsDir = path.join(tempRoot, "exports");
    fs.mkdirSync(path.join(userSkillsDir, "writer"), { recursive: true });
    fs.writeFileSync(
      path.join(userSkillsDir, "writer", "SKILL.md"),
      "---\nname: writer\n---\n# Writer\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(userSkillsDir, "writer", "notes.txt"), "public skill asset\n", "utf-8");
    fs.writeFileSync(path.join(tempRoot, "skill-bundles.json"), JSON.stringify({
      schemaVersion: 1,
      bundles: [
        {
          id: "writing-bundle",
          name: "Writing Bundle",
          skillNames: ["writer", "missing-skill"],
          source: "user",
          agentId: null,
          sourcePackage: null,
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
      ],
    }), "utf-8");
    const engine = {
      codiaHome: tempRoot,
      userSkillsDir,
      skillsDir: userSkillsDir,
      cwd: exportsDir,
      agentsDir: tempRoot,
      getAllSkills: vi.fn(() => [
        {
          name: "writer",
          source: "user",
          enabled: false,
          baseDir: path.join(userSkillsDir, "writer"),
          filePath: path.join(userSkillsDir, "writer", "SKILL.md"),
        },
      ]),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/bundles/writing-bundle/export", { method: "POST" });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      fileName: "writing-bundle-skillbundle.zip",
      warnings: [{ type: "missing-skill", name: "missing-skill" }],
    });
    expect(data.filePath).toBe(path.join(exportsDir, "writing-bundle-skillbundle.zip"));

    const outDir = path.join(tempRoot, "unzipped-skill-bundle");
    fs.mkdirSync(outDir);
    await extractZip(data.filePath, outDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "bundle.json"), "utf-8"));
    expect(manifest).toMatchObject({
      kind: "SkillBundle",
      schemaVersion: 1,
      package: {
        name: data.fileName,
      },
      bundle: {
        name: "Writing Bundle",
        source: "user",
      },
      skills: {
        bundles: [
          {
            name: "Writing Bundle",
            skills: [{ name: "writer", path: "skills/writer" }],
          },
        ],
      },
    });
    expect(fs.readFileSync(path.join(outDir, "skills", "writer", "SKILL.md"), "utf-8")).toContain("name: writer");
    expect(fs.readFileSync(path.join(outDir, "skills", "writer", "notes.txt"), "utf-8")).toBe("public skill asset\n");
    expect(fs.existsSync(path.join(outDir, "skills", "missing-skill"))).toBe(false);
  });

  it("exports agent learned skills when an agent-scoped bundle is exported", async () => {
    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const agentId = "agent-a";
    const agentsDir = path.join(tempRoot, "agents");
    const learnedSkillDir = path.join(agentsDir, agentId, "learned-skills", "agent-note");
    const exportsDir = path.join(tempRoot, "exports");
    fs.mkdirSync(learnedSkillDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, agentId, "config.yaml"), "agent:\n  name: Agent A\n", "utf-8");
    fs.writeFileSync(
      path.join(learnedSkillDir, "SKILL.md"),
      "---\nname: agent-note\n---\n# Agent Note\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(learnedSkillDir, "notes.txt"), "learned asset\n", "utf-8");
    fs.writeFileSync(path.join(tempRoot, "skill-bundles.json"), JSON.stringify({
      schemaVersion: 1,
      bundles: [
        {
          id: "learned-bundle",
          name: "Learned Bundle",
          skillNames: ["agent-note"],
          source: "user",
          agentId: null,
          sourcePackage: null,
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
      ],
    }), "utf-8");

    const engine = {
      codiaHome: tempRoot,
      userSkillsDir: path.join(tempRoot, "skills"),
      skillsDir: path.join(tempRoot, "skills"),
      cwd: exportsDir,
      agentsDir,
      currentAgentId: agentId,
      getAgent: vi.fn((id) => id === agentId ? { agentDir: path.join(agentsDir, agentId) } : null),
      getAllSkills: vi.fn((id) => {
        if (id !== agentId) throw new Error("getAllSkills requires explicit agentId");
        return [
          {
            name: "agent-note",
            source: "learned",
            enabled: true,
            baseDir: learnedSkillDir,
            filePath: path.join(learnedSkillDir, "SKILL.md"),
          },
        ];
      }),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request(`/api/skills/bundles/learned-bundle/export?agentId=${agentId}`, { method: "POST" });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      fileName: "learned-bundle-skillbundle.zip",
      warnings: [],
    });
    expect(engine.getAllSkills).toHaveBeenCalledWith(agentId);

    const outDir = path.join(tempRoot, "unzipped-learned-bundle");
    fs.mkdirSync(outDir);
    await extractZip(data.filePath, outDir);
    expect(fs.readFileSync(path.join(outDir, "skills", "agent-note", "SKILL.md"), "utf-8")).toContain("name: agent-note");
    expect(fs.readFileSync(path.join(outDir, "skills", "agent-note", "notes.txt"), "utf-8")).toBe("learned asset\n");
  });

  it("exports the requested agent's learned skill even when the skill index has a duplicate name from another agent", async () => {
    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const agentId = "agent-a";
    const otherAgentId = "agent-b";
    const agentsDir = path.join(tempRoot, "agents");
    const learnedSkillDir = path.join(agentsDir, agentId, "learned-skills", "shared-note");
    const otherLearnedSkillDir = path.join(agentsDir, otherAgentId, "learned-skills", "shared-note");
    const exportsDir = path.join(tempRoot, "exports");
    const skillsDir = path.join(tempRoot, "skills");
    fs.mkdirSync(learnedSkillDir, { recursive: true });
    fs.mkdirSync(otherLearnedSkillDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, agentId, "config.yaml"), "agent:\n  name: Agent A\n", "utf-8");
    fs.writeFileSync(path.join(agentsDir, otherAgentId, "config.yaml"), "agent:\n  name: Agent B\n", "utf-8");
    fs.writeFileSync(path.join(learnedSkillDir, "SKILL.md"), "---\nname: shared-note\n---\n# Agent A Note\n", "utf-8");
    fs.writeFileSync(path.join(learnedSkillDir, "notes.txt"), "agent-a asset\n", "utf-8");
    fs.writeFileSync(path.join(otherLearnedSkillDir, "SKILL.md"), "---\nname: shared-note\n---\n# Agent B Note\n", "utf-8");
    fs.writeFileSync(path.join(otherLearnedSkillDir, "notes.txt"), "agent-b asset\n", "utf-8");
    fs.writeFileSync(path.join(tempRoot, "skill-bundles.json"), JSON.stringify({
      schemaVersion: 1,
      bundles: [
        {
          id: "shared-bundle",
          name: "Shared Bundle",
          skillNames: ["shared-note"],
          source: "user",
          agentId: null,
          sourcePackage: null,
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
      ],
    }), "utf-8");

    const engine = {
      codiaHome: tempRoot,
      userSkillsDir: skillsDir,
      skillsDir,
      cwd: exportsDir,
      agentsDir,
      getAgent: vi.fn((id) => id === agentId ? { agentDir: path.join(agentsDir, agentId) } : null),
      getAllSkills: vi.fn(() => [
        {
          name: "shared-note",
          source: "learned",
          enabled: true,
          baseDir: otherLearnedSkillDir,
          filePath: path.join(otherLearnedSkillDir, "SKILL.md"),
        },
      ]),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request(`/api/skills/bundles/shared-bundle/export?agentId=${agentId}`, { method: "POST" });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      fileName: "shared-bundle-skillbundle.zip",
      warnings: [],
    });

    const outDir = path.join(tempRoot, "unzipped-shared-bundle");
    fs.mkdirSync(outDir);
    await extractZip(data.filePath, outDir);
    expect(fs.readFileSync(path.join(outDir, "skills", "shared-note", "notes.txt"), "utf-8")).toBe("agent-a asset\n");
  });

  it("rejects bundle membership for skills that are not installed", async () => {
    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const engine = {
      codiaHome: tempRoot,
      agentsDir: tempRoot,
      getAllSkills: vi.fn(() => [{ name: "writer", enabled: false, source: "user" }]),
      emitEvent: vi.fn(),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad Bundle", skillNames: ["writer", "missing"] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown skill in bundle: missing" });
    expect(fs.existsSync(path.join(tempRoot, "skill-bundles.json"))).toBe(false);
  });

  it("toggles one skill through the incremental agent skill route", async () => {
    const agentId = "agent-a";
    fs.mkdirSync(path.join(tempRoot, agentId), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, agentId, "config.yaml"), "agent:\n  name: Agent A\n", "utf-8");

    let skills = [
      { name: "writer", enabled: false, source: "user" },
      { name: "reader", enabled: true, source: "user" },
    ];
    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const updateConfig = vi.fn(async (partial) => {
      skills = skills.map(skill => ({
        ...skill,
        enabled: partial.skills.enabled.includes(skill.name),
      }));
    });
    const engine = {
      agentsDir: tempRoot,
      getAgent: vi.fn(() => ({ id: agentId })),
      updateConfig,
      getAllSkills: vi.fn(() => skills),
      emitEvent: vi.fn(),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/skills/writer`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      enabled: ["writer", "reader"],
      changed: ["writer"],
    });
    expect(updateConfig).toHaveBeenCalledWith(
      { skills: { enabled: ["writer", "reader"] } },
      { agentId },
    );
  });

  it("toggles all skills in a bundle through the incremental bundle route", async () => {
    const agentId = "agent-a";
    fs.mkdirSync(path.join(tempRoot, agentId), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, agentId, "config.yaml"), "agent:\n  name: Agent A\n", "utf-8");
    fs.writeFileSync(path.join(tempRoot, "skill-bundles.json"), JSON.stringify({
      schemaVersion: 1,
      bundles: [
        {
          id: "writing-bundle",
          name: "Writing Bundle",
          skillNames: ["writer", "reader"],
          source: "user",
          agentId: null,
          sourcePackage: null,
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
      ],
    }), "utf-8");

    let skills = [
      { name: "writer", enabled: true, source: "user" },
      { name: "reader", enabled: true, source: "user" },
      { name: "other", enabled: true, source: "user" },
    ];
    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const updateConfig = vi.fn(async (partial) => {
      skills = skills.map(skill => ({
        ...skill,
        enabled: partial.skills.enabled.includes(skill.name),
      }));
    });
    const engine = {
      codiaHome: tempRoot,
      agentsDir: tempRoot,
      getAgent: vi.fn(() => ({ id: agentId })),
      updateConfig,
      getAllSkills: vi.fn(() => skills),
      emitEvent: vi.fn(),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/skill-bundles/writing-bundle`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      enabled: ["other"],
      changed: ["writer", "reader"],
    });
    expect(updateConfig).toHaveBeenCalledWith(
      { skills: { enabled: ["other"] } },
      { agentId },
    );
  });
});

describe("DELETE /skills/:name per-agent target selection", () => {
  let tempRoot;
  let agentsDir;
  let skillsDir;

  /**
    * */
  function buildEngine({ agents = [], currentAgentId = null } = {}) {
    const agentMap = new Map();
    for (const id of agents) {
      const agentDir = path.join(agentsDir, id);
      fs.mkdirSync(agentDir, { recursive: true });
      if (!fs.existsSync(path.join(agentDir, "config.yaml"))) {
        fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: " + id + "\n", "utf-8");
      }
      agentMap.set(id, { agentDir });
    }
    return {
      codiaHome: tempRoot,
      skillsDir,
      agentsDir,
      currentAgentId,
      getAgent: (id) => agentMap.get(id),
      //
      getAllSkills: vi.fn(() => []),
      getRuntimeSkills: vi.fn(() => []),
      reloadSkills: vi.fn(async () => {}),
    };
  }

  function writeLearnedSkill(agentId, skillName) {
    const dir = path.join(agentsDir, agentId, "learned-skills", skillName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skillName}\n---\n`, "utf-8");
    return dir;
  }

  function writeUserSkill(skillName) {
    const dir = path.join(skillsDir, skillName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skillName}\n---\n`, "utf-8");
    return dir;
  }

  function writeAgentConfigWithEnabled(agentId, enabledSkills) {
    const configPath = path.join(agentsDir, agentId, "config.yaml");
    const body =
      `agent:\n  name: ${agentId}\nskills:\n  enabled:\n` +
      enabledSkills.map(n => `    - ${n}`).join("\n") + "\n";
    fs.writeFileSync(configPath, body, "utf-8");
  }

  async function readAgentEnabled(agentId) {
    // Clear config-loader cache to isolate tests.
    const { loadConfig, clearConfigCache } = await import("../lib/memory/config-loader.js");
    clearConfigCache();
    const cfg = loadConfig(path.join(agentsDir, agentId, "config.yaml"));
    return cfg?.skills?.enabled || [];
  }

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-skills-delete-"));
    agentsDir = path.join(tempRoot, "agents");
    skillsDir = path.join(tempRoot, "skills");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("backward compat: without agentId query, resolveAgent fallback deletes user skill", async () => {
    const engine = buildEngine({ agents: ["agent-a"], currentAgentId: "agent-a" });
    writeUserSkill("my-skill");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/my-skill", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fs.existsSync(path.join(skillsDir, "my-skill"))).toBe(false);
    expect(engine.reloadSkills).toHaveBeenCalled();
  });

  it("deletes a learned skill from the explicitly requested agent", async () => {
    const engine = buildEngine({
      agents: ["agent-a", "agent-b"],
      currentAgentId: "agent-a",
    });
    const learnedDir = writeLearnedSkill("agent-b", "test-skill");
    expect(fs.existsSync(learnedDir)).toBe(true);

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/test-skill?agentId=agent-b", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fs.existsSync(learnedDir)).toBe(false);
  });

  it("regression #419: deletes only the requested agent's duplicate learned skill", async () => {
    const engine = buildEngine({
      agents: ["agent-a", "agent-b"],
      currentAgentId: "agent-a", // 焦点在 a，但要到 b
    });
    const dirA = writeLearnedSkill("agent-a", "dup-skill");
    const dirB = writeLearnedSkill("agent-b", "dup-skill");
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/dup-skill?agentId=agent-b", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    //
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(path.join(dirA, "SKILL.md"))).toBe(true);
  });

  it("explicit agentId deletes user skill and clears enabled lists for all agents", async () => {
    const engine = buildEngine({
      agents: ["agent-a", "agent-b"],
      currentAgentId: "agent-a",
    });
    writeUserSkill("globalskill");
    writeAgentConfigWithEnabled("agent-a", ["globalskill", "other"]);
    writeAgentConfigWithEnabled("agent-b", ["globalskill", "other"]);

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/globalskill?agentId=agent-b", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(fs.existsSync(path.join(skillsDir, "globalskill"))).toBe(false);

    const enabledA = await readAgentEnabled("agent-a");
    const enabledB = await readAgentEnabled("agent-b");
    expect(enabledA).not.toContain("globalskill");
    expect(enabledB).not.toContain("globalskill");
    expect(enabledA).toContain("other");
    expect(enabledB).toContain("other");
  });

  it("removes deleted user skills from skill bundle metadata", async () => {
    const engine = buildEngine({
      agents: ["agent-a"],
      currentAgentId: "agent-a",
    });
    engine.codiaHome = tempRoot;
    writeUserSkill("bundled-skill");
    fs.writeFileSync(path.join(tempRoot, "skill-bundles.json"), JSON.stringify({
      schemaVersion: 1,
      bundles: [
        {
          id: "coding",
          name: "Coding Bundle",
          skillNames: ["bundled-skill", "keep-skill"],
          source: "character-card-import",
          agentId: "agent-a",
          sourcePackage: "coding.zip",
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
        {
          id: "empty-after-delete",
          name: "Empty After Delete",
          skillNames: ["bundled-skill"],
          source: "character-card-import",
          agentId: "agent-a",
          sourcePackage: "coding.zip",
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
      ],
    }, null, 2), "utf-8");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/bundled-skill?agentId=agent-a", { method: "DELETE" });
    expect(res.status).toBe(200);

    const store = JSON.parse(fs.readFileSync(path.join(tempRoot, "skill-bundles.json"), "utf-8"));
    expect(store.bundles).toHaveLength(1);
    expect(store.bundles[0]).toMatchObject({
      id: "coding",
      name: "Coding Bundle",
      skillNames: ["keep-skill"],
    });
  });

  it("explicit agentId returns 404 when the agent does not exist", async () => {
    const engine = buildEngine({ agents: ["agent-a"], currentAgentId: "agent-a" });
    writeUserSkill("my-skill");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/my-skill?agentId=nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "agent not found" });
    // 文件必须保持原样
    expect(fs.existsSync(path.join(skillsDir, "my-skill"))).toBe(true);
  });
});
