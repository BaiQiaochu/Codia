// @ts-nocheck
/**
 * update-settings-tool.js 注册表单元测试
 *
 * 覆盖：apply 签名、toggle boolean 转换、agent null guard
 */
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { loadLocale } from "../server/i18n.js";

// ── Mock 工厂 ──

function makeMockPrefs(initial = {}) {
  const store = { ...initial };
  return {
    getPreferences: () => ({ ...store }),
    getSandbox: () => store.sandbox !== false,
    setSandbox(v) { store.sandbox = typeof v === "string" ? v === "true" : !!v; },
    getSandboxNetwork: () => store.sandbox_network === true,
    setSandboxNetwork(v) { store.sandbox_network = typeof v === "string" ? v === "true" : !!v; },
    getLocale: () => store.locale || "",
    setLocale(v) { store.locale = v; },
    getTimezone: () => store.timezone || "",
    setTimezone(v) { store.timezone = v; },
    getExperimentValue: vi.fn((id) => store.experiments?.[id]),
    setExperimentValue: vi.fn((id, value) => {
      store.experiments = { ...(store.experiments || {}), [id]: value };
    }),
    getBridgeMediaPublicBaseUrl: () => store.bridge?.mediaPublicBaseUrl || "",
    setBridgeMediaPublicBaseUrl(v) {
      store.bridge = { ...(store.bridge || {}), mediaPublicBaseUrl: v };
    },
    getThinkingLevel: () => store.thinking_level || "auto",
    setThinkingLevel(v) { store.thinking_level = v; },
    getFileBackup: () => store.file_backup || { enabled: false, retention_days: 1, max_file_size_kb: 1024 },
    setFileBackup(v) { store.file_backup = { ...(store.file_backup || {}), ...v }; },
    _store: store,
  };
}

function makeMockEngine(overrides = {}) {
  const prefs = makeMockPrefs(overrides.prefsData || {});
  const eventBus = overrides.eventBus || { request: vi.fn() };
  return {
    preferences: prefs,
    _prefs: prefs,
    agent: overrides.agent !== undefined ? overrides.agent : {
      memoryMasterEnabled: true,
      agentName: "TestAgent",
      userName: "TestUser",
      config: { models: { chat: "qwen-plus" } },
      updateConfig: vi.fn(),
    },
    availableModels: overrides.availableModels || [],
    getHomeFolder: () => overrides.homeFolder || "/home/test",
    setHomeFolder: vi.fn(),
    setSandbox: vi.fn(function (v) { prefs.setSandbox(v); }),
    setSandboxNetwork: vi.fn(function (v) { prefs.setSandboxNetwork(v); }),
    setFileBackup: vi.fn(function (v) { prefs.setFileBackup(v); }),
    setLocale: vi.fn(function (v) { prefs.setLocale(v); }),
    setTimezone: vi.fn(function (v) { prefs.setTimezone(v); }),
    getBridgeMediaPublicBaseUrl: vi.fn(() => prefs.getBridgeMediaPublicBaseUrl()),
    setBridgeMediaPublicBaseUrl: vi.fn(function (v) { prefs.setBridgeMediaPublicBaseUrl(v); }),
    setThinkingLevel: vi.fn(function (v) { prefs.setThinkingLevel(v); }),
    getComputerUseSettings: vi.fn(() => prefs._store.computer_use || { enabled: false }),
    setComputerUseSettings: vi.fn(function (v) {
      prefs._store.computer_use = { ...(prefs._store.computer_use || {}), ...v };
      return prefs._store.computer_use;
    }),
    updateConfig: vi.fn(async () => true),
    getEventBus: vi.fn(() => eventBus),
    currentSessionPath: "/sessions/test",
    emitSessionEvent: vi.fn(),
  };
}

function makeMockConfirmStore(action = "confirmed", value = undefined) {
  return {
    create: vi.fn(() => ({
      confirmId: "test-confirm-id",
      promise: Promise.resolve({ action, value }),
    })),
  };
}

describe("update-settings-tool", () => {
  let createUpdateSettingsTool;

  beforeAll(async () => {
    const mod = await import("../lib/tools/update-settings-tool.js");
    createUpdateSettingsTool = mod.createUpdateSettingsTool;
  }, 20_000);

  beforeEach(() => {
    loadLocale("en");
  });

  function buildTool(engineOpts = {}, confirmAction = "confirmed") {
    const engine = makeMockEngine(engineOpts);
    const confirmStore = makeMockConfirmStore(confirmAction);
    const tool = createUpdateSettingsTool({
      getEngine: () => engine,
      getAgent: () => engine.agent,
      getConfirmStore: () => confirmStore,
      getSessionPath: () => "/sessions/test",
      emitEvent: vi.fn(),
    });
    return { tool, engine, confirmStore };
  }

  function makeMemoryAgent(agentId = "agent-test") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-update-settings-memory-"));
    const agentDir = path.join(root, agentId);
    const memoryDir = path.join(agentDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const agent = {
      id: agentId,
      agentDir,
      memoryMdPath: path.join(memoryDir, "memory.md"),
      memoryMasterEnabled: true,
      agentName: "TestAgent",
      userName: "TestUser",
      config: { models: { chat: "qwen-plus" } },
      summaryManager: { getAllSummaries: vi.fn(() => []) },
      updateConfig: vi.fn(),
    };
    return { root, agentDir, memoryDir, agent };
  }

  describe("sandbox toggle — this 绑定 + boolean 转换", () => {
    it("apply sandbox=false 实际关闭沙盒", async () => {
      const { tool, engine } = buildTool({ prefsData: { sandbox: true } });
      await tool.execute("c1", { action: "apply", key: "sandbox", value: "false" });

      expect(engine.setSandbox).toHaveBeenCalled();
      // 传入的是 boolean false（调度侧 toggle parse）
      expect(engine.setSandbox.mock.calls[0][0]).toBe(false);
      // preferences 存的也是 boolean false
      expect(engine._prefs._store.sandbox).toBe(false);
    });

    it("apply sandbox=true 存入 boolean true", async () => {
      const { tool, engine } = buildTool({ prefsData: { sandbox: false } });
      await tool.execute("c2", { action: "apply", key: "sandbox", value: "true" });

      expect(engine.setSandbox.mock.calls[0][0]).toBe(true);
      expect(engine._prefs._store.sandbox).toBe(true);
    });
  });

  describe("sandbox_network toggle", () => {
    it("apply sandbox_network=true enables sandbox network access", async () => {
      const { tool, engine } = buildTool({ prefsData: { sandbox_network: false } });
      await tool.execute("c2n", { action: "apply", key: "sandbox_network", value: "true" });

      expect(engine.setSandboxNetwork).toHaveBeenCalledWith(true);
      expect(engine._prefs._store.sandbox_network).toBe(true);
    });

    it("search network exposes sandbox_network setting", async () => {
      const { tool } = buildTool({ prefsData: { sandbox_network: false } });
      const result = await tool.execute("c2s", { action: "search", query: "network" });

      expect(result.content[0].text).toContain("sandbox_network");
    });
  });

  describe("file_backup toggle", () => {
    it("enables file backup", async () => {
      const { tool, engine } = buildTool({ prefsData: {} });
      await tool.execute("c3", { action: "apply", key: "file_backup", value: "true" });

      expect(engine.setFileBackup).toHaveBeenCalled();
      expect(engine.setFileBackup.mock.calls[0][0]).toEqual({ enabled: true });
    });
  });

  describe("bridge media public URL", () => {
    it("searches the Bridge media public URL setting", async () => {
      const { tool } = buildTool();
      const result = await tool.execute("c-bridge-url-search", { action: "search", query: "public url" });
      const text = result.content[0].text;

      expect(text).toContain("bridge_media_public_base_url");
      expect(text).toContain("Bridge File Public URL");
    });

    it("applies the Bridge media public URL as a confirmed global setting", async () => {
      const { tool, engine, confirmStore } = buildTool();
      const result = await tool.execute("c-bridge-url-apply", {
        action: "apply",
        key: "bridge_media_public_base_url",
        value: "https://gsap.example.com",
      });

      expect(confirmStore.create).toHaveBeenCalled();
      expect(engine.setBridgeMediaPublicBaseUrl).toHaveBeenCalledWith("https://gsap.example.com");
      expect(engine._prefs._store.bridge.mediaPublicBaseUrl).toBe("https://gsap.example.com");
      expect(result.details.settingsUpdate).toMatchObject({
        status: "applied",
        key: "bridge_media_public_base_url",
      });
    });

    it("allows clearing the Bridge media public URL with an empty value", async () => {
      const { tool, engine } = buildTool({
        prefsData: { bridge: { mediaPublicBaseUrl: "https://gsap.example.com" } },
      });
      const result = await tool.execute("c-bridge-url-clear", {
        action: "apply",
        key: "bridge_media_public_base_url",
        value: "",
      });

      expect(engine.setBridgeMediaPublicBaseUrl).toHaveBeenCalledWith("");
      expect(engine._prefs._store.bridge.mediaPublicBaseUrl).toBe("");
      expect(result.details.settingsUpdate).toMatchObject({
        status: "applied",
        key: "bridge_media_public_base_url",
      });
    });
  });

  describe("computer use global gate", () => {
    it("searches the computer control switch in experiments", async () => {
      const { tool } = buildTool({ prefsData: { computer_use: { enabled: false } } });
      const result = await tool.execute("c-computer-search", { action: "search", query: "computer use" });
      const text = result.content[0].text;

      expect(text).toMatch(/\[\d+\]\s+experiments\.computer_use\.enabled/);
      expect(text).not.toMatch(/\[\d+\]\s+computer_use\.enabled/);
      expect(text).toContain("Computer control");
    });

    it("applies the computer control switch through engine preferences", async () => {
      const { tool, engine } = buildTool({ prefsData: { computer_use: { enabled: false } } });
      const result = await tool.execute("c-computer-apply", {
        action: "apply",
        key: "experiments.computer_use.enabled",
        value: "true",
      });

      expect(engine.setComputerUseSettings).toHaveBeenCalledWith({ enabled: true });
      expect(engine._prefs._store.computer_use.enabled).toBe(true);
      expect(result.details.settingsUpdate).toMatchObject({
        status: "applied",
        key: "experiments.computer_use.enabled",
      });
    });

    it("keeps the legacy computer control key as an apply-only compatibility alias", async () => {
      const { tool, engine } = buildTool({ prefsData: { computer_use: { enabled: false } } });
      const result = await tool.execute("c-computer-legacy-apply", {
        action: "apply",
        key: "computer_use.enabled",
        value: "true",
      });

      expect(engine.setComputerUseSettings).toHaveBeenCalledWith({ enabled: true });
      expect(engine._prefs._store.computer_use.enabled).toBe(true);
      expect(result.details.settingsUpdate).toMatchObject({
        status: "applied",
        key: "experiments.computer_use.enabled",
      });
    });
  });

  describe("locale — 非 toggle 类型不受 parse 影响", () => {
    it("apply locale=en 传入字符串", async () => {
      const { tool, engine } = buildTool({ prefsData: { locale: "zh-CN" } });
      const result = await tool.execute("c3", { action: "apply", key: "locale", value: "en" });

      expect(engine.setLocale).toHaveBeenCalledWith("en");
      expect(result.details.settingsUpdate).toMatchObject({
        status: "applied",
        action: "core.apply",
        key: "locale",
        changes: [
          expect.objectContaining({
            key: "locale",
            before: "zh-CN",
            after: "en",
          }),
        ],
      });
      expect(result.content[0].text).toContain("Language");
    });
  });

  describe("agent-scoped null guard", () => {
    it("get memory.enabled 在 agent=null 时不返回 true", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c4", { action: "search", query: "memory" });
      const text = result.content[0].text;
      expect(text).not.toContain("→ true");
      expect(text).toContain("N/A");
    });

    it("apply memory.enabled 在 agent=null 时返回错误", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c5", { action: "apply", key: "memory.enabled", value: "true" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });

    it("get agent.name 在 agent=null 时返回 N/A", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c6", { action: "search", query: "agent.name" });
      const text = result.content[0].text;
      expect(text).toContain("N/A");
    });
  });

  describe("memory.facts editable memory boundary", () => {
    it("rejects Agent fact edits while the editable memory experiment is disabled", async () => {
      const { root, memoryDir, agent } = makeMemoryAgent("owner");
      try {
        fs.writeFileSync(path.join(memoryDir, "facts.md"), "Legacy facts\n", "utf-8");
        const { tool } = buildTool({ agent });

        const result = await tool.execute("c-memory-facts-disabled", {
          action: "apply",
          key: "memory.facts",
          value: "User likes clean boundaries.",
        });

        expect(result.details.settingsUpdate).toMatchObject({
          status: "failed",
          key: "memory.facts",
        });
        expect(fs.existsSync(path.join(memoryDir, "editable-facts.md"))).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("writes editable facts and rebuilds memory.md when the experiment is enabled", async () => {
      const { root, memoryDir, agent } = makeMemoryAgent("owner");
      try {
        fs.writeFileSync(path.join(memoryDir, "facts.md"), "Legacy facts\n", "utf-8");
        fs.writeFileSync(path.join(memoryDir, "today.md"), "Today stays read-only.\n", "utf-8");
        fs.writeFileSync(path.join(memoryDir, "week.md"), "Week stays read-only.\n", "utf-8");
        fs.writeFileSync(path.join(memoryDir, "longterm.md"), "Long-term stays read-only.\n", "utf-8");
        const { tool } = buildTool({
          agent,
          prefsData: { experiments: { "memory.editable_facts": true } },
        });

        const result = await tool.execute("c-memory-facts-enabled", {
          action: "apply",
          key: "memory.facts",
          value: "User likes clean boundaries.",
        });

        expect(result.details.settingsUpdate).toMatchObject({
          status: "applied",
          key: "memory.facts",
        });
        expect(fs.readFileSync(path.join(memoryDir, "editable-facts.md"), "utf-8")).toBe("User likes clean boundaries.\n");
        const compiled = fs.readFileSync(path.join(memoryDir, "memory.md"), "utf-8");
        expect(compiled).toContain("## Key facts");
        expect(compiled).toContain("User likes clean boundaries.");
        expect(compiled).toContain("Today stays read-only.");
        expect(compiled).toContain("Week stays read-only.");
        expect(compiled).toContain("Long-term stays read-only.");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("MCP settings actions", () => {
    it("routes MCP connector add through the backend event bus with the target agent", async () => {
      const request = vi.fn(async () => ({
        settingsUpdate: {
          status: "applied",
          action: "mcp.connector.add",
          key: "mcp.connector.github",
          title: "MCP connector added",
          summary: "Added GitHub.",
          changes: [{ key: "mcp.connector.github", label: "GitHub", before: "", after: "added" }],
        },
      }));
      const { tool, confirmStore } = buildTool({
        eventBus: { request },
        agent: {
          id: "owner",
          memoryMasterEnabled: true,
          agentName: "Owner",
          userName: "TestUser",
          config: { models: { chat: "qwen-plus" } },
          updateConfig: vi.fn(),
        },
      });

      const result = await tool.execute("c-mcp-add", {
        action: "apply",
        key: "mcp.connector.add",
        value: JSON.stringify({
          name: "GitHub",
          transport: "remote",
          url: "https://mcp.github.com/mcp",
          authType: "bearer",
          authorizationToken: "secret-token",
        }),
      });

      expect(confirmStore.create).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith("mcp:settings-action", {
        action: "mcp.connector.add",
        agentId: "owner",
        payload: {
          name: "GitHub",
          transport: "remote",
          url: "https://mcp.github.com/mcp",
          authType: "bearer",
          authorizationToken: "secret-token",
        },
      });
      expect(result.details.settingsUpdate).toMatchObject({
        action: "mcp.connector.add",
        status: "applied",
      });
    });
  });

  describe("confirmation rejected/aborted", () => {
    it("rejected 返回取消消息", async () => {
      const { tool } = buildTool({}, "rejected");
      const result = await tool.execute("c7", { action: "apply", key: "locale", value: "en" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });

    it("aborted（session 关闭）不返回成功消息", async () => {
      const { tool } = buildTool({}, "aborted");
      const result = await tool.execute("c8", { action: "apply", key: "locale", value: "en" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });
  });
});
