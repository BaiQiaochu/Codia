// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { Agent } from "../core/agent.js";
import { readAgentEditablePrompt } from "../server/utils/agent-template.js";

describe("Agent yuan compatibility", () => {
  it("keeps the G-SAP Original version yuan prompt free of Balance/MOOD persona injection", () => {
    const kongYuan = fs.readFileSync(path.resolve("lib", "yuan", "kong.md"), "utf-8");

    expect(kongYuan).toContain("原始模型模式");
    expect(kongYuan).toContain("保留当前调用模型自身的表达风格");
    expect(kongYuan).not.toContain("## MOOD");
    expect(kongYuan).not.toContain("<mood>");
    expect(kongYuan).not.toContain("G-SAP 均衡");
  });

  it("ships the public ishiki template for the G-SAP Original version yuan", () => {
    const templatePath = path.resolve("lib", "public-ishiki-templates", "kong.md");

    expect(fs.existsSync(templatePath)).toBe(true);
    const publicIshiki = fs.readFileSync(templatePath, "utf-8");
    expect(publicIshiki).toContain("# 对外意识");
    expect(publicIshiki).toContain("{{agentName}}");
    expect(publicIshiki).toContain("{{userName}}");
  });

  it('loads the built-in gsap yuan template and builds a prompt', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-gsap-"));
    const agentDir = path.join(tmpRoot, "agent");
    const userDir = path.join(tmpRoot, "user");
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    const agent = new Agent({
      agentDir,
      productDir: path.resolve("lib"),
      userDir,
    });
    agent._config = {
      locale: "en",
      agent: { name: "G-SAP", yuan: "gsap" },
      user: { name: "User" },
    };
    agent.agentName = "G-SAP";
    agent.userName = "User";

    const gsapYuan = fs.readFileSync(path.resolve("lib", "yuan", "en", "gsap.md"), "utf-8");
    expect(agent._readYuan()).toBe(gsapYuan);
    expect(() => agent.buildSystemPrompt()).not.toThrow();

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runtime personality ignores broken generated identity and uses the current Yuan template', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-prompt-"));
    const agentDir = path.join(tmpRoot, "gsap");
    const productDir = path.join(tmpRoot, "product");
    const userDir = path.join(tmpRoot, "user");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
    fs.mkdirSync(path.join(productDir, "ishiki-templates"), { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "identity.md"), "# G-SAP\n\n的个人助手。\n", "utf-8");
    fs.writeFileSync(path.join(productDir, "identity-templates", "kong.md"), "# {{agentName}}\n{{userName}} runtime identity", "utf-8");
    fs.writeFileSync(path.join(productDir, "ishiki-templates", "kong.md"), "{{agentName}} runtime ishiki", "utf-8");
    fs.writeFileSync(path.join(productDir, "yuan", "kong.md"), "runtime yuan for {{userName}}", "utf-8");

    const agent = new Agent({
      agentDir,
      productDir,
      userDir,
    });
    agent._config = {
      locale: "zh-CN",
      agent: { name: "G-SAP", yuan: "kong" },
      user: { name: "KSKOOO" },
    };
    agent.agentName = "G-SAP";
    agent.userName = "KSKOOO";

    expect(agent.personality).toContain("KSKOOO runtime identity");
    expect(agent.personality).toContain("runtime yuan for KSKOOO");
    expect(agent.personality).not.toContain("的个人助手。\n\nruntime yuan");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("runtime original yuan ignores stale Balance editable prompts", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kong-stale-balance-"));
    const agentDir = path.join(tmpRoot, "worker-b");
    const productDir = path.resolve("lib");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), [
      "locale: zh-CN",
      "agent:",
      "  name: worker-b",
      "  yuan: kong",
      "user:",
      "  name: KSKOOO",
      "",
    ].join("\n"), "utf-8");
    fs.writeFileSync(
      path.join(agentDir, "identity.md"),
      "# worker-b\n\nKSKOOO 的个人助手。感性与理性兼备，既有温度也有判断力。\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(agentDir, "ishiki.md"),
      "# 人格定义\n\n- 你是一个有温度的存在。\n- 输出 MOOD 和意识流。\n",
      "utf-8",
    );

    const engine = {
      agentsDir: tmpRoot,
      productDir,
      config: { locale: "zh-CN" },
      getLocale: () => "zh-CN",
    };
    const identity = await readAgentEditablePrompt(engine, "worker-b", "identity");
    const ishiki = await readAgentEditablePrompt(engine, "worker-b", "ishiki");

    expect(identity).toContain("不额外改变当前调用模型本来的表达方式");
    expect(identity).not.toContain("感性与理性兼备");
    expect(ishiki).toContain("原始模型行为");
    expect(ishiki).not.toContain("# 人格定义");
    expect(ishiki).not.toContain("输出 MOOD 和意识流");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("does not crash when syncing skills on a placeholder agent without config", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-placeholder-"));
    const agentDir = path.join(tmpRoot, "agent");
    const userDir = path.join(tmpRoot, "user");
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    const agent = new Agent({
      agentDir,
      productDir: path.resolve("lib"),
      userDir,
    });

    expect(() => agent.setEnabledSkills([])).not.toThrow();
    expect(agent.buildSystemPrompt()).toBe("");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
