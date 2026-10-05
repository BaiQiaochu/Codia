// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hub } from "../hub/index.js";
import { createChannel } from "../lib/channels/channel-store.js";
import { createCompanyService } from "../plugins/company/lib/company-service.js";

function makeEngine({ root, channelsDir, agentsDir, userDir }) {
  const callbacks = {};
  return {
    channelsDir,
    agentsDir,
    userDir,
    callbacks,
    agents: new Map(),
    agentName: "G-SAP",
    userName: "Boss",
    availableModels: [],
    setHubCallbacks: vi.fn((value) => Object.assign(callbacks, value)),
    setEventBus: vi.fn(),
    isChannelsEnabled: vi.fn(() => true),
    canRunBackgroundTask: vi.fn(() => true),
    isSessionStreaming: vi.fn(() => false),
    promptSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => false),
    listSessions: vi.fn(async () => []),
    listAgents: vi.fn(() => [
      { id: "pm-1", name: "项目经理A" },
      { id: "admin-1", name: "管理员A" },
      { id: "worker-1", name: "工人A" },
    ]),
    getAgent: vi.fn((agentId) => ({
      id: agentId,
      agentName: agentId,
      agentDir: path.join(agentsDir, agentId),
      config: { agent: { name: agentId, yuan: "gsap" } },
    })),
    providerRegistry: {
      getCredentials: vi.fn(() => ({})),
      getAllProvidersRaw: vi.fn(() => ({})),
      getAll: vi.fn(() => new Map()),
      getAllModelsByType: vi.fn(() => []),
      getModelsByType: vi.fn(() => []),
      getMediaProviders: vi.fn(() => []),
      getMediaProviderCredentialStatus: vi.fn(() => ({ hasCredentials: false, lanes: [] })),
    },
    resolveUtilityConfig: vi.fn(() => ({})),
    dispose: vi.fn(async () => {}),
    gsapHome: root,
  };
}

describe("company plugin and channel linkage", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("posts assigned company tasks into the bound main channel and triggers mentioned workers", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-company-channel-link-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(userDir, { recursive: true });

    for (const agentId of ["pm-1", "admin-1", "worker-1"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), `agent:\n  name: ${agentId}\n`, "utf-8");
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# Channels\n\n", "utf-8");
    }

    const { id: channelId } = createChannel(channelsDir, {
      id: "crew",
      name: "工作群",
      members: ["pm-1", "admin-1", "worker-1"],
      memberRoles: {
        "pm-1": "project_manager",
        "admin-1": "admin",
        "worker-1": "worker",
      },
    });

    const engine = makeEngine({ root, channelsDir, agentsDir, userDir });
    const hub = new Hub({ engine });
    const triggerSpy = vi.spyOn(hub, "triggerChannelDelivery").mockResolvedValue();

    const service = createCompanyService({
      pluginId: "company",
      dataDir: path.join(root, "plugin-data"),
      bus: hub.eventBus,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    const tasks = await service.assignCommand({
      channelId,
      command: "做一份女式西服完整工程包，需要项目经理拆解、脚本方案、视觉设计、视频制作、发布质检。",
    });
    const status = await service.getStatus();

    const pmTask = tasks.find((task) => task.assigneeRole === "project_manager");
    const workerTasks = tasks.filter((task) => task.assigneeRole !== "project_manager");
    expect(pmTask).toMatchObject({
      taskKind: "root",
      parentTaskId: "",
      depth: 0,
    });
    expect(pmTask.treeId).toMatch(/^tree_/);
    expect(workerTasks.length).toBeGreaterThan(0);
    expect(workerTasks.every((task) =>
      task.treeId === pmTask.treeId &&
      task.parentTaskId === pmTask.id &&
      task.depth === 1 &&
      task.taskKind === "agent_task"
    )).toBe(true);

    expect(tasks.map((task) => task.assigneeAgentId)).toEqual(
      expect.arrayContaining(["pm-1", "worker-1", "admin-1"]),
    );
    expect(status.channels).toContainEqual(expect.objectContaining({
      id: channelId,
      internalChannelId: channelId,
      platform: "internal",
      status: "connected",
    }));

    const channelRaw = fs.readFileSync(path.join(channelsDir, `${channelId}.md`), "utf-8");
    expect(channelRaw).toContain("公司任务已分派");
    expect(channelRaw).toContain("@pm-1");
    expect(channelRaw).toContain("@worker-1");
    expect(channelRaw).toContain("@admin-1");
    expect(triggerSpy).toHaveBeenCalledWith(channelId, {
      mentionedAgents: expect.arrayContaining(["pm-1", "worker-1", "admin-1"]),
    });

    await hub.dispose();
  });

  it("renders assigned task titles and channel task cards without template placeholders", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-company-channel-template-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(userDir, { recursive: true });

    for (const agentId of ["pm-1", "worker-1"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), `agent:\n  name: ${agentId}\n`, "utf-8");
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# Channels\n\n", "utf-8");
    }

    const { id: channelId } = createChannel(channelsDir, {
      id: "crew",
      name: "Crew",
      members: ["pm-1", "worker-1"],
      memberRoles: {
        "pm-1": "project_manager",
        "worker-1": "worker",
      },
    });

    const engine = makeEngine({ root, channelsDir, agentsDir, userDir });
    const hub = new Hub({ engine });
    vi.spyOn(hub, "triggerChannelDelivery").mockResolvedValue();

    const service = createCompanyService({
      pluginId: "company",
      dataDir: path.join(root, "plugin-data"),
      bus: hub.eventBus,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    const tasks = await service.assignCommand({
      channelId,
      command: "Build demo project",
    });

    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0].title).toContain("Build demo project");
    expect(tasks.map((task) => task.title).join("\n")).not.toContain("{summarize");

    const channelRaw = fs.readFileSync(path.join(channelsDir, `${channelId}.md`), "utf-8");
    expect(channelRaw).toContain("Build demo project");
    expect(channelRaw).not.toContain("{task.title");
    expect(channelRaw).not.toContain("{safeArray");
    expect(channelRaw).not.toContain("{summarize");

    await hub.dispose();
  });

  it("fans generic channel project commands out to the available channel agent roles", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-company-channel-fanout-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(userDir, { recursive: true });

    for (const agentId of ["pm-1", "admin-1", "worker-1"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), `agent:\n  name: ${agentId}\n`, "utf-8");
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# Channels\n\n", "utf-8");
    }

    const { id: channelId } = createChannel(channelsDir, {
      id: "crew",
      name: "Crew",
      members: ["pm-1", "admin-1", "worker-1"],
      memberRoles: {
        "pm-1": "project_manager",
        "admin-1": "admin",
        "worker-1": "worker",
      },
    });

    const engine = makeEngine({ root, channelsDir, agentsDir, userDir });
    const hub = new Hub({ engine });
    const triggerSpy = vi.spyOn(hub, "triggerChannelDelivery").mockResolvedValue();

    const service = createCompanyService({
      pluginId: "company",
      dataDir: path.join(root, "plugin-data"),
      bus: hub.eventBus,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    const tasks = await service.assignCommand({
      channelId,
      command: "清理并融合主程序功能",
    });

    expect(tasks.map((task) => task.assigneeAgentId)).toEqual(
      expect.arrayContaining(["pm-1", "admin-1", "worker-1"]),
    );
    expect(tasks.filter((task) => task.taskKind === "agent_task").length).toBeGreaterThanOrEqual(2);
    expect(triggerSpy).toHaveBeenCalledWith(channelId, {
      mentionedAgents: expect.arrayContaining(["pm-1", "admin-1", "worker-1"]),
    });

    await hub.dispose();
  });

  it("routes externally bound company channels through their linked internal channel", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-company-external-channel-link-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(userDir, { recursive: true });

    for (const agentId of ["pm-1", "admin-1", "worker-1"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), `agent:\n  name: ${agentId}\n`, "utf-8");
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# Channels\n\n", "utf-8");
    }

    const { id: internalChannelId } = createChannel(channelsDir, {
      id: "crew",
      name: "Crew",
      members: ["pm-1", "admin-1", "worker-1"],
      memberRoles: {
        "pm-1": "project_manager",
        "admin-1": "admin",
        "worker-1": "worker",
      },
    });

    const engine = makeEngine({ root, channelsDir, agentsDir, userDir });
    const hub = new Hub({ engine });
    const triggerSpy = vi.spyOn(hub, "triggerChannelDelivery").mockResolvedValue();

    const service = createCompanyService({
      pluginId: "company",
      dataDir: path.join(root, "plugin-data"),
      bus: hub.eventBus,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    const company = await service.createDefaultCompany({});
    const bound = await service.bindChannel({
      companyId: company.id,
      platform: "telegram",
      externalGroupId: "tg-crew",
      externalTitle: "外部工作群",
      internalChannelId,
      mirrorToExternal: true,
    });

    await service.ingestChannelMessage(bound.id, {
      senderId: "boss",
      senderName: "Boss",
      isBoss: true,
      text: "老板：做一份完整工程包，需要项目经理拆解、视觉设计和发布质检。",
    });

    const channelRaw = fs.readFileSync(path.join(channelsDir, `${internalChannelId}.md`), "utf-8");
    expect(channelRaw).toContain("公司任务已分派");
    expect(channelRaw).toContain("@pm-1");
    expect(channelRaw).toContain("@worker-1");
    expect(channelRaw).toContain("@admin-1");
    expect(triggerSpy).toHaveBeenCalledWith(internalChannelId, {
      mentionedAgents: expect.arrayContaining(["pm-1", "worker-1", "admin-1"]),
    });

    await hub.dispose();
  });

  it("exposes channel-scoped company assignment and report tools for agent phone turns", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-company-channel-tool-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    createChannel(channelsDir, {
      id: "crew",
      name: "Crew",
      members: ["pm-1", "worker-1"],
      memberRoles: {
        "pm-1": "project_manager",
        "worker-1": "worker",
      },
    });

    const assignTool = {
      name: "company_assign",
      description: "assign company tasks",
      parameters: {},
      execute: vi.fn(async () => ({
        content: [{ type: "text", text: "ok" }],
        details: { tasks: [] },
      })),
    };
    const reportTool = {
      name: "company_report",
      description: "report company task",
      parameters: {},
      execute: vi.fn(async () => ({
        content: [{ type: "text", text: "reported" }],
        details: { task: { id: "task-1" } },
      })),
    };
    const engine = {
      ...makeEngine({ root, channelsDir, agentsDir, userDir }),
      pluginManager: {
        getPluginTool: vi.fn((_pluginId, toolName) => {
          if (toolName === "assign") return assignTool;
          if (toolName === "report") return reportTool;
          return null;
        }),
      },
    };
    const hub = new Hub({ engine });

    const tools = hub.channelRouter._createCompanyChannelTools("pm-1", "crew");
    expect(tools.map((tool) => tool.name)).toEqual(["company_assign", "company_report"]);

    await tools[0].execute("call-company", { command: "清理并融合主程序功能" }, {
      sessionPath: "/phone/crew.jsonl",
    });

    expect(assignTool.execute).toHaveBeenCalledWith(
      "call-company",
      expect.objectContaining({
        command: "清理并融合主程序功能",
        channelId: "crew",
      }),
      expect.objectContaining({
        agentId: "pm-1",
        channelId: "crew",
        conversationId: "crew",
        conversationType: "channel",
        sessionPath: "/phone/crew.jsonl",
      }),
    );

    await tools[1].execute("call-report", { report: "done" }, {
      sessionPath: "/phone/crew.jsonl",
    });

    expect(reportTool.execute).toHaveBeenCalledWith(
      "call-report",
      expect.objectContaining({
        report: "done",
        channelId: "crew",
      }),
      expect.objectContaining({
        agentId: "pm-1",
        channelId: "crew",
        conversationId: "crew",
        conversationType: "channel",
        sessionPath: "/phone/crew.jsonl",
      }),
    );

    await hub.dispose();
  });

  it("lets channel workers report company tasks but not dispatch new task trees", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-company-channel-worker-tool-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    createChannel(channelsDir, {
      id: "crew",
      name: "Crew",
      members: ["pm-1", "worker-1"],
      memberRoles: {
        "pm-1": "project_manager",
        "worker-1": "worker",
      },
    });

    const assignTool = {
      name: "company_assign",
      description: "assign company tasks",
      parameters: {},
      execute: vi.fn(),
    };
    const reportTool = {
      name: "company_report",
      description: "report company task",
      parameters: {},
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "reported" }] })),
    };
    const engine = {
      ...makeEngine({ root, channelsDir, agentsDir, userDir }),
      pluginManager: {
        getPluginTool: vi.fn((_pluginId, toolName) => {
          if (toolName === "assign") return assignTool;
          if (toolName === "report") return reportTool;
          return null;
        }),
      },
    };
    const hub = new Hub({ engine });

    const tools = hub.channelRouter._createCompanyChannelTools("worker-1", "ch_crew");
    expect(tools.map((tool) => tool.name)).toEqual(["company_report"]);

    await tools[0].execute("call-report", { status: "reported", report: "Implemented" }, {
      sessionPath: "/phone/crew.jsonl",
    });

    expect(assignTool.execute).not.toHaveBeenCalled();
    expect(reportTool.execute).toHaveBeenCalledWith(
      "call-report",
      expect.objectContaining({
        status: "reported",
        report: "Implemented",
        channelId: "ch_crew",
      }),
      expect.objectContaining({
        agentId: "worker-1",
        channelId: "ch_crew",
        conversationId: "ch_crew",
        conversationType: "channel",
        sessionPath: "/phone/crew.jsonl",
      }),
    );

    await hub.dispose();
  });
});
