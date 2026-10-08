import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "js-yaml";

vi.mock("../lib/memory/config-loader.js", () => ({
  saveConfig: vi.fn((configPath, partial) => {
    const current = fs.existsSync(configPath)
      ? YAML.load(fs.readFileSync(configPath, "utf-8")) || {}
      : {};
    const merge = (target, source) => {
      for (const [key, value] of Object.entries(source || {})) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          target[key] = merge({ ...(target[key] || {}) }, value);
        } else {
          target[key] = value;
        }
      }
      return target;
    };
    fs.writeFileSync(configPath, YAML.dump(merge(current, partial)), "utf-8");
  }),
  clearConfigCache: vi.fn(),
}));

vi.mock("../lib/tools/experience.js", () => ({
  listExperienceDocuments: vi.fn(() => []),
  normalizeExperienceCategory: vi.fn((value) => String(value || "").trim()),
  rebuildIndex: vi.fn(),
  syncExperienceCategories: vi.fn(),
}));

describe("agents route", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-agents-route-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  it("editing another agent config can clear saved provider credentials", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "api:\n  provider: openai\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const saveProvider = vi.fn();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: "other",
      providerRegistry: {
        saveProvider,
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: {
          api_key: "",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("openai", { api_key: "" });
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
  });

  it("passes the target workspace path when creating an agent", async () => {
    const workspace = path.join(tempRoot, "workspace-target");
    fs.mkdirSync(workspace, { recursive: true });

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      createAgent: vi.fn(async (opts) => ({
        id: opts.id || "worker-a",
        name: opts.name,
        yuan: opts.yuan || "gsap",
      })),
      emitEvent: vi.fn(),
      listAgents: vi.fn(() => []),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "worker-a",
        name: "Worker A",
        yuan: "hermes",
        homeFolder: workspace,
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.createAgent).toHaveBeenCalledWith({
      id: "worker-a",
      name: "Worker A",
      yuan: "hermes",
      homeFolder: workspace,
    });
  });

  it("includes workspace and memory context when switching agents", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const sessionPath = path.join(tempRoot, "gsap", "sessions", "main.jsonl");
    const engine = {
      agentsDir: tempRoot,
      config: { cwd_history: ["/old"] },
      currentSessionPath: sessionPath,
      cwd: "/workspace",
      switchAgent: vi.fn(async () => ({
        cwd: "/workspace",
        sessionPath,
        homeFolder: "/home/gsap",
      })),
      getAgent: vi.fn(() => ({ agentName: "G-SAP", memoryMasterEnabled: false })),
      getExplicitHomeCwd: vi.fn(() => "/home/gsap"),
      getSessionWorkspaceFolders: vi.fn(() => ["/workspace", "/workspace/lib"]),
      updateConfig: vi.fn(async () => {}),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "gsap" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      sessionPath,
      cwd: "/workspace",
      homeFolder: "/home/gsap",
      workspaceFolders: ["/workspace", "/workspace/lib"],
      cwdHistory: ["/workspace", "/old"],
      memoryMasterEnabled: false,
    });
    expect(engine.emitEvent).toHaveBeenCalledWith(
      {
        type: "app_event",
        event: {
          type: "agent-switched",
          payload: expect.objectContaining({
            agentId: "gsap",
            sessionPath,
            memoryMasterEnabled: false,
          }),
          source: "server",
        },
      },
      null,
    );
  });

  it("emits memory-master-changed when agent memory is toggled", async () => {
    const agentId = "gsap";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: G-SAP\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: agentId,
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
      setMemoryMasterEnabled: vi.fn(),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: { enabled: false } }),
    });

    expect(res.status).toBe(200);
    expect(engine.setMemoryMasterEnabled).toHaveBeenCalledWith(agentId, false);
    expect(engine.emitEvent).toHaveBeenCalledWith(
      {
        type: "app_event",
        event: {
          type: "memory-master-changed",
          payload: { agentId, enabled: false },
          source: "server",
        },
      },
      null,
    );
  });

  it("applies provider models before the first-run chat model in one config update", async () => {
    const agentId = "gsap";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Assistant\n", "utf-8");

    const order = [];
    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: agentId,
      providerRegistry: {
        saveProvider: vi.fn(() => order.push("saveProvider")),
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      onProviderChanged: vi.fn(async () => {
        order.push("onProviderChanged");
      }),
      updateConfig: vi.fn(async (partial) => {
        order.push(partial?.models?.chat ? "updateConfig:chat" : "updateConfig:empty");
      }),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
      getAgent: vi.fn(() => ({ tools: [] })),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          "custom-provider": {
            models: ["chat-model"],
          },
        },
        models: {
          chat: { id: "chat-model", provider: "custom-provider" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.providerRegistry.saveProvider).toHaveBeenCalledWith("custom-provider", {
      models: ["chat-model"],
    });
    expect(order).toEqual([
      "saveProvider",
      "onProviderChanged",
      "updateConfig:empty",
      "updateConfig:chat",
    ]);
  });

  it("returns Yuan templates when identity and ishiki files are missing", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    const productDir = path.join(tempRoot, "product");
    fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
    fs.mkdirSync(path.join(productDir, "ishiki-templates"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      YAML.dump({ locale: "zh-CN", agent: { name: "Test Agent", yuan: "ming" }, user: { name: "Ghost" } }),
      "utf-8",
    );
    fs.writeFileSync(path.join(productDir, "identity-templates", "ming.md"), "# {{agentName}}\n{{userName}} identity", "utf-8");
    fs.writeFileSync(path.join(productDir, "ishiki-templates", "ming.md"), "{{agentId}} ishiki for {{agentName}}", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      productDir,
      config: { locale: "zh-CN" },
      getLocale: () => "zh-CN",
      getAgent: vi.fn(() => null),
    };

    app.route("/api", createAgentsRoute(engine));

    const identityRes = await app.request(`/api/agents/${agentId}/identity`);
    const ishikiRes = await app.request(`/api/agents/${agentId}/ishiki`);

    expect(identityRes.status).toBe(200);
    expect(await identityRes.json()).toEqual({ content: "# Test Agent\nGhost identity" });
    expect(ishikiRes.status).toBe(200);
    expect(await ishikiRes.json()).toEqual({ content: "hana ishiki for Test Agent" });
  });

  it("returns Yuan templates when identity and ishiki files are empty", async () => {
    const agentId = "empty-agent";
    const agentDir = path.join(tempRoot, agentId);
    const productDir = path.join(tempRoot, "product-empty");
    fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
    fs.mkdirSync(path.join(productDir, "ishiki-templates"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      YAML.dump({ locale: "en", agent: { name: "Empty Agent", yuan: "hermes" }, user: { name: "Ghost" } }),
      "utf-8",
    );
    fs.writeFileSync(path.join(agentDir, "identity.md"), "\n", "utf-8");
    fs.writeFileSync(path.join(agentDir, "ishiki.md"), "   ", "utf-8");
    fs.mkdirSync(path.join(productDir, "identity-templates", "en"), { recursive: true });
    fs.mkdirSync(path.join(productDir, "ishiki-templates", "en"), { recursive: true });
    fs.writeFileSync(path.join(productDir, "identity-templates", "en", "hermes.md"), "{{agentName}} english identity", "utf-8");
    fs.writeFileSync(path.join(productDir, "ishiki-templates", "en", "hermes.md"), "{{userName}} english ishiki", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      productDir,
      config: { locale: "en" },
      getLocale: () => "en",
      getAgent: vi.fn(() => null),
    };

    app.route("/api", createAgentsRoute(engine));

    const identityRes = await app.request(`/api/agents/${agentId}/identity`);
    const ishikiRes = await app.request(`/api/agents/${agentId}/ishiki`);

    expect(await identityRes.json()).toEqual({ content: "Empty Agent english identity" });
    expect(await ishikiRes.json()).toEqual({ content: "Ghost english ishiki" });
  });

  it("returns bundled kong identity and ishiki templates", async () => {
    const agentId = "gsap";
    const agentDir = path.join(tempRoot, agentId);
    const productDir = path.join(process.cwd(), "lib");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      YAML.dump({ locale: "zh-CN", agent: { name: "Test Agent", yuan: "kong" }, user: { name: "Ghost" } }),
      "utf-8",
    );

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      productDir,
      config: { locale: "zh-CN" },
      getLocale: () => "zh-CN",
      getAgent: vi.fn(() => null),
    };

    app.route("/api", createAgentsRoute(engine));

    const identityRes = await app.request(`/api/agents/${agentId}/identity`);
    const ishikiRes = await app.request(`/api/agents/${agentId}/ishiki`);

    expect(identityRes.status).toBe(200);
    const identityContent = (await identityRes.json()).content;
    expect(identityContent).toContain("# Test Agent");
    expect(identityContent).toContain("Ghost");
    expect(ishikiRes.status).toBe(200);
    const ishikiContent = (await ishikiRes.json()).content;
    expect(ishikiContent).toContain("原始模型行为");
    expect(ishikiContent).not.toContain("自主意识");
    expect(ishikiContent).not.toContain("MOOD 块");
  });

  it("keeps user-saved ishiki customization for kong even when it contains legacy persona keywords", async () => {
    const agentId = "kong-custom-ishiki";
    const agentDir = path.join(tempRoot, agentId);
    const productDir = path.join(process.cwd(), "lib");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      YAML.dump({ locale: "zh-CN", agent: { name: "Skill Agent", yuan: "kong" }, user: { name: "Ghost" } }),
      "utf-8",
    );

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      productDir,
      config: { locale: "zh-CN" },
      getLocale: () => "zh-CN",
      getAgent: vi.fn(() => null),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const customIshiki = [
      "# 人格定义",
      "",
      "- 保留当前调用模型的基础表达方式。",
      "- 允许根据 wall-of-sighs 技能整理用户压力，但不要输出 MOOD 块。",
    ].join("\n");

    const saveRes = await app.request(`/api/agents/${agentId}/ishiki`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: customIshiki }),
    });
    expect(saveRes.status).toBe(200);

    const readRes = await app.request(`/api/agents/${agentId}/ishiki`);
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toEqual({ content: customIshiki });
  });

  it("falls back from broken generated identity without replacing handwritten identity", async () => {
    const productDir = path.join(tempRoot, "product-broken-identity");
    fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
    fs.writeFileSync(path.join(productDir, "identity-templates", "kong.md"), "# {{agentName}}\n{{userName}} fallback identity", "utf-8");

    const brokenId = "broken-identity";
    const brokenDir = path.join(tempRoot, brokenId);
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(
      path.join(brokenDir, "config.yaml"),
      YAML.dump({ locale: "zh-CN", agent: { name: "G-SAP", yuan: "kong" }, user: { name: "Ghost" } }),
      "utf-8",
    );
    fs.writeFileSync(path.join(brokenDir, "identity.md"), "# G-SAP\n\n的个人助手。\n", "utf-8");

    const customId = "custom-identity";
    const customDir = path.join(tempRoot, customId);
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(
      path.join(customDir, "config.yaml"),
      YAML.dump({ locale: "zh-CN", agent: { name: "G-SAP", yuan: "kong" }, user: { name: "Ghost" } }),
      "utf-8",
    );
    fs.writeFileSync(path.join(customDir, "identity.md"), "# Custom\n\n保留我的自定义身份。\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      productDir,
      config: { locale: "zh-CN" },
      getLocale: () => "zh-CN",
      getAgent: vi.fn(() => null),
    };

    app.route("/api", createAgentsRoute(engine));

    const brokenRes = await app.request(`/api/agents/${brokenId}/identity`);
    const customRes = await app.request(`/api/agents/${customId}/identity`);

    expect((await brokenRes.json()).content).toContain("# G-SAP");
    expect((await customRes.json()).content).toContain("# Custom");
  });

  it("refreshes default identity and ishiki when switching Yuan", async () => {
    const agentId = "gsap";
    const agentDir = path.join(tempRoot, agentId);
    const productDir = path.join(tempRoot, "product-yuan-switch");
    fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
    fs.mkdirSync(path.join(productDir, "ishiki-templates"), { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      YAML.dump({ locale: "zh-CN", agent: { name: "G-SAP", yuan: "butter" }, user: { name: "KSKOOO" } }),
      "utf-8",
    );
    fs.writeFileSync(path.join(productDir, "identity-templates", "butter.md"), "# {{agentName}}\n{{userName}} butter identity", "utf-8");
    fs.writeFileSync(path.join(productDir, "identity-templates", "kong.md"), "# {{agentName}}\n{{userName}} kong identity", "utf-8");
    fs.writeFileSync(path.join(productDir, "ishiki-templates", "butter.md"), "{{agentName}} butter ishiki", "utf-8");
    fs.writeFileSync(path.join(productDir, "ishiki-templates", "kong.md"), "{{agentName}} kong ishiki", "utf-8");
    fs.writeFileSync(path.join(productDir, "yuan", "butter.md"), "butter yuan", "utf-8");
    fs.writeFileSync(path.join(productDir, "yuan", "kong.md"), "kong yuan", "utf-8");
    fs.writeFileSync(path.join(agentDir, "identity.md"), "# G-SAP\nKSKOOO butter identity", "utf-8");
    fs.writeFileSync(path.join(agentDir, "ishiki.md"), "G-SAP butter ishiki", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      productDir,
      config: { locale: "zh-CN" },
      getLocale: () => "zh-CN",
      getAgent: vi.fn(() => null),
      providerRegistry: { getAllProvidersRaw: vi.fn(() => ({})), get: vi.fn(() => null) },
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { yuan: "kong" } }),
    });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(agentDir, "identity.md"), "utf-8")).toBe("# G-SAP\nKSKOOO kong identity");
    expect(fs.readFileSync(path.join(agentDir, "ishiki.md"), "utf-8")).toBe("G-SAP kong ishiki");

    const identityRes = await app.request(`/api/agents/${agentId}/identity`);
    const ishikiRes = await app.request(`/api/agents/${agentId}/ishiki`);
    expect(await identityRes.json()).toEqual({ content: "# G-SAP\nKSKOOO kong identity" });
    expect(await ishikiRes.json()).toEqual({ content: "G-SAP kong ishiki" });
  });

  it("rejects config writes that point to a missing Yuan template", async () => {
    const agentId = "gsap-invalid-yuan";
    const agentDir = path.join(tempRoot, agentId);
    const productDir = path.join(tempRoot, "product-yuan-invalid");
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(productDir, "yuan", "gsap.md"), "valid yuan", "utf-8");
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      YAML.dump({ locale: "zh-CN", agent: { name: "G-SAP", yuan: "gsap" }, user: { name: "KSKOOO" } }),
      "utf-8",
    );

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      productDir,
      config: { locale: "zh-CN" },
      getLocale: () => "zh-CN",
      getAgent: vi.fn(() => null),
      providerRegistry: { getAllProvidersRaw: vi.fn(() => ({})), get: vi.fn(() => null) },
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { yuan: "missing-yuan" } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Invalid yuan "missing-yuan": template not found in lib/yuan',
    });
    expect(engine.updateConfig).not.toHaveBeenCalled();
    const saved = YAML.load(fs.readFileSync(path.join(agentDir, "config.yaml"), "utf-8"));
    expect(saved.agent.yuan).toBe("gsap");
  });

  it("keeps handwritten identity and ishiki when switching Yuan", async () => {
    const agentId = "custom-gsap";
    const agentDir = path.join(tempRoot, agentId);
    const productDir = path.join(tempRoot, "product-yuan-custom");
    fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
    fs.mkdirSync(path.join(productDir, "ishiki-templates"), { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      YAML.dump({ locale: "zh-CN", agent: { name: "G-SAP", yuan: "butter" }, user: { name: "KSKOOO" } }),
      "utf-8",
    );
    fs.writeFileSync(path.join(productDir, "identity-templates", "kong.md"), "{{userName}} kong identity", "utf-8");
    fs.writeFileSync(path.join(productDir, "ishiki-templates", "kong.md"), "{{agentName}} kong ishiki", "utf-8");
    fs.writeFileSync(path.join(productDir, "yuan", "butter.md"), "butter yuan", "utf-8");
    fs.writeFileSync(path.join(productDir, "yuan", "kong.md"), "kong yuan", "utf-8");
    fs.writeFileSync(path.join(agentDir, "identity.md"), "# Custom\nhandwritten identity", "utf-8");
    fs.writeFileSync(path.join(agentDir, "ishiki.md"), "handwritten ishiki", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      productDir,
      config: { locale: "zh-CN" },
      getLocale: () => "zh-CN",
      getAgent: vi.fn(() => null),
      providerRegistry: { getAllProvidersRaw: vi.fn(() => ({})), get: vi.fn(() => null) },
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { yuan: "kong" } }),
    });

    expect(fs.readFileSync(path.join(agentDir, "identity.md"), "utf-8")).toBe("# Custom\nhandwritten identity");
    expect(fs.readFileSync(path.join(agentDir, "ishiki.md"), "utf-8")).toBe("handwritten ishiki");
  });
});
