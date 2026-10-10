import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { LATEST_DATA_VERSION, runMigrations } from "../core/migrations.js";

function makePrefs(initial) {
  let data = { ...initial };
  return {
    getPreferences: vi.fn(() => data),
    savePreferences: vi.fn((next) => { data = { ...next }; }),
  };
}

function writeCronJobs(filePath, jobs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2)}\n`, "utf-8");
}

describe("automation cron migrations", () => {
  it("patches studio and legacy agent cron jobs through the current automation read model", () => {
    const codiaHome = fs.mkdtempSync(path.join(os.tmpdir(), "codia-migrations-automation-"));
    try {
      const agentsDir = path.join(codiaHome, "agents");
      const studioJobsPath = path.join(codiaHome, "studios", "main", "desk", "cron-jobs.json");
      const agentJobsPath = path.join(agentsDir, "agent-a", "desk", "cron-jobs.json");
      writeCronJobs(studioJobsPath, [{
        id: "studio_job_1",
        type: "cron",
        schedule: "0 9 * * *",
        prompt: "daily summary",
        actorAgentId: "agent-a",
        enabled: true,
        model: "",
      }]);
      writeCronJobs(agentJobsPath, [{
        id: "job_1",
        type: "every",
        schedule: 60000,
        prompt: "legacy heartbeat",
        enabled: true,
        model: "",
      }]);

      const prefs = makePrefs({ _dataVersion: 29 });
      runMigrations({
        codiaHome,
        agentsDir,
        prefs,
        providerRegistry: null,
        log: vi.fn(),
      });

      const [studioJob] = JSON.parse(fs.readFileSync(studioJobsPath, "utf-8")).jobs;
      const [agentJob] = JSON.parse(fs.readFileSync(agentJobsPath, "utf-8")).jobs;
      expect(studioJob.schemaVersion).toBe(3);
      expect(studioJob.trigger).toEqual({ kind: "cron", expression: "0 9 * * *" });
      expect(studioJob.executor).toMatchObject({
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "daily summary",
      });
      expect(studioJob.createdBy).toEqual({ kind: "agent", agentId: "agent-a" });
      expect(agentJob.schemaVersion).toBe(3);
      expect(agentJob.trigger).toEqual({ kind: "every", intervalMs: 60000 });
      expect(agentJob.executor).toMatchObject({
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "legacy heartbeat",
      });
      expect(agentJob.createdBy).toEqual({ kind: "agent", agentId: "agent-a" });
      expect(prefs.savePreferences).toHaveBeenLastCalledWith(
        expect.objectContaining({ _dataVersion: LATEST_DATA_VERSION }),
      );
    } finally {
      fs.rmSync(codiaHome, { recursive: true, force: true });
    }
  });
});
