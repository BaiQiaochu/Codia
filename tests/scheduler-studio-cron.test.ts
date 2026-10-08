import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../hub/scheduler.js";

describe("Scheduler studio cron", () => {
  const schedulers = [];

  afterEach(async () => {
    await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.stop()));
  });

  it("runs studio cron jobs with their actor agent and execution context", async () => {
    const job = {
      id: "studio_job_1",
      label: "Daily",
      enabled: true,
      actorAgentId: "agent-a",
      model: "",
      prompt: "daily",
      executionContext: {
        cwd: "E:/workspace",
        workspaceFolders: ["E:/workspace/pkg"],
        sourceSessionPath: "E:/sessions/a.jsonl",
      },
    };
    const store = {
      listJobs: vi.fn(() => [job]),
      getJob: vi.fn(() => job),
      logRun: vi.fn(),
      markRun: vi.fn(),
    };
    const activityStore = { add: vi.fn() };
    const executeIsolated = vi.fn(async () => ({ sessionPath: null, error: null }));
    const engine = {
      agents: new Map(),
      agentsDir: "E:/gsap/agents",
      getStudioCronStore: () => store,
      canRunBackgroundTask: () => true,
      ensureAgentRuntime: vi.fn(async () => {}),
      executeIsolated,
      getAgent: () => ({ agentName: "Agent A" }),
      getActivityStore: () => activityStore,
      summarizeActivity: vi.fn(),
      emitDevLog: vi.fn(),
    };
    const scheduler = new Scheduler({
      hub: {
        engine,
        eventBus: { emit: vi.fn() },
      },
    });
    schedulers.push(scheduler);

    scheduler.startAgentCron("agent-a");
    const result = await scheduler.runAgentCronNow("agent-a", "studio_job_1");

    expect(result.status).toBe("success");
    expect(executeIsolated).toHaveBeenCalledWith(expect.stringContaining("daily"), expect.objectContaining({
      agentId: "agent-a",
      cwd: "E:/workspace",
      workspaceFolders: ["E:/workspace/pkg"],
      parentSessionPath: "E:/sessions/a.jsonl",
      activityType: "cron",
    }));
    expect(store.markRun).toHaveBeenCalledWith("studio_job_1", { success: true });
  });
});
