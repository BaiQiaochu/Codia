import { beforeEach, describe, expect, it } from "vitest";
import { SkillManager, __test } from "../core/skill-manager.js";

describe("SkillManager.computeDefaultEnabledForNewAgent", () => {
  let manager;

  beforeEach(() => {
    manager = new SkillManager({ skillsDir: "/tmp/codia-test-skills" });
  });

  it("includes user source skills", () => {
    manager._allSkills = [
      { name: "pdf", source: "user" },
      { name: "docx", source: "user" },
    ];
    expect(manager.computeDefaultEnabledForNewAgent()).toEqual(["pdf", "docx"]);
  });

  it("excludes learned and external skills", () => {
    manager._allSkills = [
      { name: "pdf", source: "user" },
      { name: "my-learned", source: "learned", _agentId: "agent-a" },
      { name: "external", source: "external" },
      { name: "workspace", source: "external", _workspaceSkill: true },
    ];
    expect(manager.computeDefaultEnabledForNewAgent()).toEqual(["pdf"]);
  });

  it("excludes skills that opt out of default enablement", () => {
    manager._allSkills = [
      { name: "pdf", source: "user" },
      { name: "codia-plugin-creator", source: "user", defaultEnabled: false },
    ];
    expect(manager.computeDefaultEnabledForNewAgent()).toEqual(["pdf"]);
  });
});

describe("SkillManager learned skill visibility", () => {
  it("shows only the requested agent's learned skills in API and runtime views", () => {
    const manager = new SkillManager({ skillsDir: "/tmp/codia-test-skills" });
    manager._allSkills = [
      { name: "global-skill", source: "user" },
      { name: "agent-a-note", source: "learned", _agentId: "agent-a" },
      { name: "agent-b-note", source: "learned", _agentId: "agent-b" },
    ];
    const agent = {
      agentDir: "/tmp/codia-agents/agent-a",
      config: { skills: { enabled: ["global-skill", "agent-a-note", "agent-b-note"] } },
      setEnabledSkills: () => {},
    };

    expect(manager.getAllSkills(agent).map(skill => skill.name)).toEqual([
      "global-skill",
      "agent-a-note",
    ]);
    expect(manager.getRuntimeSkillInfos(agent).map(skill => skill.name)).toEqual([
      "global-skill",
      "agent-a-note",
    ]);
    expect(manager.getSkillsForAgent(agent).skills.map(skill => skill.name)).toEqual([
      "global-skill",
      "agent-a-note",
    ]);
  });
});

describe("SkillManager watcher ignore rules", () => {
  it("ignores heavy directories inside a skill without ignoring a skill named build", () => {
    const ignored = __test.createSkillWatchIgnore("/tmp/codia-skills");

    expect(ignored("/tmp/codia-skills/my-skill/node_modules/pkg/index.js")).toBe(true);
    expect(ignored("/tmp/codia-skills/my-skill/dist/out.js")).toBe(true);
    expect(ignored("/tmp/codia-skills/my-skill/.DS_Store")).toBe(true);
    expect(ignored("/tmp/codia-skills/build/SKILL.md")).toBe(false);
  });
});
