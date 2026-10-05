import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../hub/scheduler.js";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-scheduler-automation-"));
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
  return {
    root,
    agentsDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function makeAgentEngine(overrides: Record<string, any> = {}) {
  const { agentsDir, cleanup } = makeRoot();
  const activityStore = { add: vi.fn() };
  const executeIsolated = vi.fn(async () => ({ sessionPath: null, error: null }));
  const engine: any = {
    agents: new Map(),
    agentsDir,
    getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
    canRunBackgroundTask: () => true,
    ensureAgentRuntime: vi.fn(async () => {}),
    executeIsolated,
    getAgent: () => ({ agentName: "Agent A" }),
    getActivityStore: () => activityStore,
    summarizeActivity: vi.fn(),
    emitDevLog: vi.fn(),
    ...overrides,
  };
  return { engine, activityStore, executeIsolated, cleanup };
}

describe("Scheduler automation executors", () => {
  it("executes agent_session cron jobs through the executor read model", async () => {
    const { engine, executeIsolated, cleanup } = makeAgentEngine();
    try {
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });

      await scheduler._executeCronJob({
        id: "studio_job_2",
        label: "Executor job",
        trigger: { kind: "cron", expression: "0 9 * * *" },
        executor: {
          kind: "agent_session",
          agentId: "agent-a",
          prompt: "run from executor",
          model: { id: "gpt-test", provider: "openai" },
          executionContext: {
            kind: "session_workspace",
            cwd: "/workspace/a",
            workspaceFolders: ["/workspace/ref"],
            sourceSessionPath: "/sessions/a.jsonl",
            createdByAgentId: "agent-a",
          },
        },
      });

      expect(executeIsolated).toHaveBeenCalledWith(
        expect.stringContaining("run from executor"),
        expect.objectContaining({
          agentId: "agent-a",
          cwd: "/workspace/a",
          workspaceFolders: ["/workspace/ref"],
          parentSessionPath: "/sessions/a.jsonl",
          model: { id: "gpt-test", provider: "openai" },
          activityType: "cron",
        }),
      );
    } finally {
      cleanup();
    }
  });

  it("fails closed if a legacy notify direct-action executor reaches the scheduler", async () => {
    const deliverNotification = vi.fn(async () => ({
      ok: true,
      deliveries: [{ channel: "desktop", status: "sent" }],
    }));
    const { engine, executeIsolated, cleanup } = makeAgentEngine({ deliverNotification });
    try {
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });

      await expect(scheduler._executeCronJob({
        id: "studio_job_notify",
        label: "Drink Water",
        actorAgentId: "agent-a",
        executor: {
          kind: "direct_action",
          action: "notify",
          params: {
            title: "Drink water",
            body: "Stand up for a minute",
            channels: ["desktop"],
          },
        },
      })).rejects.toThrow(/unsupported automation executor: direct_action/);

      expect(executeIsolated).not.toHaveBeenCalled();
      expect(deliverNotification).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("fails closed if a legacy plugin-action executor reaches the scheduler", async () => {
    const pluginTool = {
      name: "notes_create_note",
      _pluginId: "notes",
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    };
    const executePluginTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const { engine, executeIsolated, cleanup } = makeAgentEngine({
      runtimeContext: {
        executionBoundary: {
          schemaVersion: 1,
          boundaryId: "execb_test",
          kind: "local_process",
        },
      },
      pluginManager: {
        getPluginTool: vi.fn(() => pluginTool),
        executePluginTool,
      },
    });
    try {
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });

      await expect(scheduler._executeCronJob({
        id: "studio_job_plugin",
        label: "Daily note",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: ["/workspace/ref"],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
        executor: {
          kind: "plugin_action",
          pluginId: "notes",
          actionId: "create_note",
          params: { title: "Today" },
        },
      })).rejects.toThrow(/unsupported automation executor: plugin_action/);

      expect(executeIsolated).not.toHaveBeenCalled();
      expect(executePluginTool).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("rejects legacy plugin-action jobs before plugin tool lookup", async () => {
    const { engine, cleanup } = makeAgentEngine({
      pluginManager: {
        getPluginTool: vi.fn(() => null),
        executePluginTool: vi.fn(),
      },
    });
    try {
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });

      await expect(scheduler._executeCronJob({
        id: "studio_job_plugin_missing",
        label: "Missing plugin action",
        actorAgentId: "agent-a",
        executor: {
          kind: "plugin_action",
          pluginId: "notes",
          actionId: "create_note",
          params: {},
        },
      })).rejects.toThrow(/unsupported automation executor: plugin_action/);
      expect(engine.pluginManager.getPluginTool).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
