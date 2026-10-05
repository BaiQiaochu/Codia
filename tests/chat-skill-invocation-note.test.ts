import { describe, expect, it } from "vitest";
import { buildSkillInvocationNote, resolveSelectedSkillRecords } from "../server/routes/chat.js";

describe("chat skill invocation note", () => {
  it("turns selected skill badges into explicit SKILL.md instructions", () => {
    const note = buildSkillInvocationNote(["user-guide", " user-guide ", "gsap-plugin-creator", ""], [
      { name: "user-guide", filePath: "C:\\skills\\user-guide\\SKILL.md", description: "User guide", source: "user" },
      { name: "gsap-plugin-creator", filePath: "C:\\skills\\gsap-plugin-creator\\SKILL.md", description: "", source: "user" },
    ]);

    expect(note).toContain("<available_skills>");
    expect(note).toContain("<selected-skills>");
    expect(note).toContain("name: user-guide");
    expect(note).toContain("skill_md_path: C:\\skills\\user-guide\\SKILL.md");
    expect(note).toContain("- user-guide: read C:\\skills\\user-guide\\SKILL.md");
    expect(note.match(/name: user-guide/g)).toHaveLength(1);
    expect(note).toContain("read that exact SKILL.md path");
    expect(note).toContain("final visible answer");
    expect(note).toContain("Do not finish with only thinking");
  });

  it("ignores empty skill selections", () => {
    expect(buildSkillInvocationNote([])).toBe("");
    expect(buildSkillInvocationNote([" ", null, undefined])).toBe("");
  });

  it("resolves selected skill records from the current session agent", () => {
    const engine = {
      currentAgentId: "fallback",
      agentIdFromSessionPath: () => "agent-a",
      getRuntimeSkills: (agentId) => {
        expect(agentId).toBe("agent-a");
        return [
          {
            name: "wall-of-sighs",
            description: "Process emotional overload before action.",
            baseDir: "C:\\Users\\ghost\\.gsap\\skills\\wall-of-sighs",
            source: "user",
            enabled: true,
          },
        ];
      },
    };

    const records = resolveSelectedSkillRecords(engine, ["wall-of-sighs", "missing"], "session.jsonl");

    expect(records[0]).toMatchObject({
      name: "wall-of-sighs",
      filePath: "C:\\Users\\ghost\\.gsap\\skills\\wall-of-sighs\\SKILL.md",
      description: "Process emotional overload before action.",
    });
    expect(records[1]).toMatchObject({ name: "missing", filePath: "" });
    expect(buildSkillInvocationNote(["missing"], [records[1]])).toContain("do not infer its rules from the name");
  });
});
