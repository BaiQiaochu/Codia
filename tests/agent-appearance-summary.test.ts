import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_APPEARANCE_SUMMARY_REQUEST,
  formatAgentAppearancePrompt,
  readAgentAvatarResource,
  sanitizeAgentAppearanceSummary,
  writeCachedAgentAppearanceSummary,
  readCachedAgentAppearanceSummary,
} from "../lib/agent-appearance-summary.ts";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw6N6wAAAABJRU5ErkJggg==",
  "base64",
);

describe("agent appearance summary", () => {
  let tmpDir: string;
  let agentDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-agent-appearance-"));
    agentDir = path.join(tmpDir, "agents", "agent-a");
    fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "avatars", "agent.png"), PNG_BYTES);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses a neutral self-appearance request instead of image-description examples", () => {
    expect(AGENT_APPEARANCE_SUMMARY_REQUEST).toContain("这个 Agent 的样子");
    expect(AGENT_APPEARANCE_SUMMARY_REQUEST).toContain("你的形象");
    expect(AGENT_APPEARANCE_SUMMARY_REQUEST).toContain("有活人感");
    expect(AGENT_APPEARANCE_SUMMARY_REQUEST).not.toContain("来自图片");
  });

  it("filters external image descriptions and formats natural self-knowledge", () => {
    expect(sanitizeAgentAppearanceSummary("你的形象是银白色短发，神情安静。")).toBe("你的形象是银白色短发，神情安静。");
    expect(sanitizeAgentAppearanceSummary("图片中是一位银白色短发角色。")).toBe("");

    const section = formatAgentAppearancePrompt("你的样子带着温和而专注的气质。", "zh-CN");
    expect(section).toContain("## 你的样子");
    expect(section).toContain("你的样子带着温和而专注的气质。");
    expect(section).not.toContain("图片");
  });

  it("invalidates cached summaries when the avatar hash changes", () => {
    const first = readAgentAvatarResource(agentDir);
    expect(first).not.toBeNull();

    writeCachedAgentAppearanceSummary(agentDir, {
      avatarHash: first!.hash,
      summary: "你的形象是银白色短发，神情安静。",
      model: "vision-a",
    });
    expect(readCachedAgentAppearanceSummary(agentDir)?.summary).toContain("银白色短发");

    fs.writeFileSync(path.join(agentDir, "avatars", "agent.png"), Buffer.from("changed-avatar"));

    expect(readCachedAgentAppearanceSummary(agentDir)).toBeNull();
  });
});
