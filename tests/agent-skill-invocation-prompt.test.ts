// @ts-nocheck
import { describe, expect, it } from "vitest";
import { Agent } from "../core/agent.js";

function createAgent(locale) {
  const agent = new Agent({
    agentDir: "C:/tmp/agent",
    productDir: "C:/tmp/product",
    userDir: "C:/tmp/user",
  });
  agent._config = { locale };
  agent._systemPrompt = "BASE";
  return agent;
}

describe("Agent skill invocation prompt", () => {
  it("adds stronger skill invocation guidance in Chinese locale", () => {
    const prompt = createAgent("zh-CN").systemPrompt;

    expect(prompt).toContain("技能调用纪律");
    expect(prompt).toContain("先用 read 工具读取该技能的 SKILL.md");
  });

  it("adds stronger skill invocation guidance in non-Chinese locale", () => {
    const prompt = createAgent("en-US").systemPrompt;

    expect(prompt).toContain("Skill Invocation Discipline");
    expect(prompt).toContain("use the read tool to load that skill's SKILL.md");
  });
});
