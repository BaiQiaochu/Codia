// @ts-nocheck
import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "js-yaml";

vi.mock("../lib/pi-sdk/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    formatSkillsForPrompt: vi.fn((skills) => `\n[skills:${skills.map((skill) => skill.name).join(",")}]`),
  };
});

describe("system prompt route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /system-prompt appends enabled skills for dev view", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const engine = {
      currentAgentId: "agent-a",
      getAgent: vi.fn((id) => id === "agent-a"
        ? {
            id: "agent-a",
            systemPrompt: "BASE_PROMPT",
            enabledSkills: [{ name: "alpha" }, { name: "beta" }],
          }
        : null),
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/system-prompt");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      content: "BASE_PROMPT\n[skills:alpha,beta]",
    });
  });

  it("legacy identity and ishiki routes use the same editable template fallback", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-config-prompt-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      const productDir = path.join(tempRoot, "product");
      const agentDir = path.join(agentsDir, "agent-a");
      fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
      fs.mkdirSync(path.join(productDir, "ishiki-templates"), { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "config.yaml"),
        YAML.dump({ locale: "zh-CN", agent: { name: "Legacy Agent", yuan: "butter" }, user: { name: "Ghost" } }),
        "utf-8",
      );
      fs.writeFileSync(path.join(productDir, "identity-templates", "butter.md"), "identity {{agentName}}", "utf-8");
      fs.writeFileSync(path.join(productDir, "ishiki-templates", "butter.md"), "ishiki {{userName}}", "utf-8");

      const { createConfigRoute } = await import("../server/routes/config.js");
      const app = new Hono();
      const agent = {
        id: "agent-a",
        agentDir,
        productDir,
        config: { locale: "zh-CN", agent: { name: "Legacy Agent", yuan: "butter" }, user: { name: "Ghost" } },
        agentName: "Legacy Agent",
        userName: "Ghost",
      };
      const engine = {
        currentAgentId: "agent-a",
        agentsDir,
        productDir,
        config: { locale: "zh-CN" },
        getLocale: () => "zh-CN",
        getAgent: vi.fn((id) => (id === "agent-a" ? agent : null)),
        providerRegistry: { getAllProvidersRaw: vi.fn(() => ({})) },
      };

      app.route("/api", createConfigRoute(engine));

      const identityRes = await app.request("/api/identity");
      const ishikiRes = await app.request("/api/ishiki");

      expect(await identityRes.json()).toEqual({ content: "identity Legacy Agent" });
      expect(await ishikiRes.json()).toEqual({ content: "ishiki Ghost" });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
