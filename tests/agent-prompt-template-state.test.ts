import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readAgentPromptTemplateState,
  resetAgentEditablePrompt,
} from "../server/utils/agent-template.js";

const roots = [];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-agent-template-"));
  roots.push(root);
  const productDir = path.join(root, "product");
  const agentsDir = path.join(root, "agents");
  const agentDir = path.join(agentsDir, "agent-a");
  fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
  fs.mkdirSync(path.join(productDir, "ishiki-templates"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "identity-templates", "codia.md"), "# {{agentName}}\n默认身份 {{userName}}\n", "utf-8");
  fs.writeFileSync(path.join(productDir, "ishiki-templates", "codia.md"), "- 默认意识 {{agentName}}\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: 工人A\n  yuan: codia\nuser:\n  name: 用户\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "identity.md"), "# 工人A\n自定义身份\n", "utf-8");
  return {
    root,
    engine: {
      agentsDir,
      productDir,
      config: { locale: "zh-CN" },
      getAgent: (id) => id === "agent-a" ? {
        id,
        agentDir,
        productDir,
        config: { agent: { name: "工人A", yuan: "codia" }, user: { name: "用户" } },
      } : null,
    },
    agentDir,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent prompt template state", () => {
  it("exposes current text, yuan template preview, and a custom diff for each editable prompt", async () => {
    const { engine } = makeFixture();
    const state = await readAgentPromptTemplateState(engine, "agent-a");

    expect(state.agentId).toBe("agent-a");
    expect(state.yuan).toBe("codia");
    expect(state.prompts.identity.template).toContain("默认身份 用户");
    expect(state.prompts.identity.current).toContain("自定义身份");
    expect(state.prompts.identity.hasCustomChanges).toBe(true);
    expect(state.prompts.identity.diff.added).toContain("自定义身份");
    expect(state.prompts.identity.diff.removed).toContain("默认身份 用户");
    expect(state.prompts.ishiki.hasCustomChanges).toBe(false);
  });

  it("restores one prompt kind to the active yuan template without touching the other prompt", async () => {
    const { engine, agentDir } = makeFixture();
    const result = await resetAgentEditablePrompt(engine, "agent-a", "identity");

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(agentDir, "identity.md"), "utf-8")).toContain("默认身份 用户");
    expect(fs.existsSync(path.join(agentDir, "ishiki.md"))).toBe(false);
  });
});
