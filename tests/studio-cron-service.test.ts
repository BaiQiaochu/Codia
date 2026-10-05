import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { StudioCronService } from "../core/studio-cron-service.js";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-studio-cron-"));
}

function writeLegacyJobs(root, agentId, jobs) {
  const deskDir = path.join(root, "agents", agentId, "desk");
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(
    path.join(deskDir, "cron-jobs.json"),
    JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2) + "\n",
    "utf-8",
  );
}

function writeLegacyRun(root, agentId, jobId, run) {
  const runsDir = path.join(root, "agents", agentId, "desk", "cron-runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, `${jobId}.jsonl`), JSON.stringify(run) + "\n", "utf-8");
}

function writeStudioJobs(root, studioId, jobs) {
  const deskDir = path.join(root, "studios", studioId, "desk");
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(
    path.join(deskDir, "cron-jobs.json"),
    JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2) + "\n",
    "utf-8",
  );
}

describe("StudioCronService", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports legacy per-agent jobs into a studio-scoped store", () => {
    const root = makeRoot();
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    writeLegacyJobs(root, "agent-a", [
      {
        id: "job_1",
        type: "cron",
        schedule: "0 9 * * *",
        prompt: "daily a",
        label: "Daily A",
        model: "",
        enabled: true,
        consecutiveErrors: 0,
        createdAt: "2026-05-01T00:00:00.000Z",
        lastRunAt: null,
        nextRunAt: "2026-05-21T01:00:00.000Z",
      },
    ]);
    writeLegacyJobs(root, "agent-b", [
      {
        id: "job_1",
        type: "every",
        schedule: 3_600_000,
        prompt: "hourly b",
        label: "Hourly B",
        model: { id: "gpt-test", provider: "openai" },
        enabled: false,
        consecutiveErrors: 2,
        createdAt: "2026-05-02T00:00:00.000Z",
        lastRunAt: "2026-05-03T00:00:00.000Z",
        nextRunAt: "2026-05-21T02:00:00.000Z",
      },
    ]);

    const service = new StudioCronService({
      gsapHome: root,
      agentsDir,
      getStudioId: () => "studio-main",
    });

    const jobs = service.listJobs().sort((a, b) => a.actorAgentId.localeCompare(b.actorAgentId));

    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
    expect(jobs.every((job) => job.id.startsWith("studio_job_"))).toBe(true);
    expect(jobs[0]).toEqual(expect.objectContaining({
      actorAgentId: "agent-a",
      legacyRef: { agentId: "agent-a", jobId: "job_1" },
      executionContext: {
        kind: "legacy_agent_home",
        cwd: null,
        workspaceFolders: [],
        sourceSessionPath: null,
        createdByAgentId: "agent-a",
      },
    }));
    expect(jobs[1]).toEqual(expect.objectContaining({
      actorAgentId: "agent-b",
      legacyRef: { agentId: "agent-b", jobId: "job_1" },
      model: { id: "gpt-test", provider: "openai" },
      enabled: false,
      consecutiveErrors: 2,
      lastRunAt: "2026-05-03T00:00:00.000Z",
    }));
  });

  it("does not duplicate imported legacy jobs on later reads or service instances", () => {
    const root = makeRoot();
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    writeLegacyJobs(root, "agent-a", [
      {
        id: "job_1",
        type: "cron",
        schedule: "0 9 * * *",
        prompt: "daily a",
        label: "Daily A",
        enabled: true,
        nextRunAt: "2026-05-21T01:00:00.000Z",
      },
    ]);

    const opts = { gsapHome: root, agentsDir, getStudioId: () => "studio-main" };
    const first = new StudioCronService(opts);
    expect(first.listJobs()).toHaveLength(1);
    expect(first.listJobs()).toHaveLength(1);

    const second = new StudioCronService(opts);
    expect(second.listJobs()).toHaveLength(1);
  });

  it("does not re-import a deleted legacy job after the legacy store was reconciled", () => {
    const root = makeRoot();
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    writeLegacyJobs(root, "agent-a", [
      {
        id: "job_1",
        type: "cron",
        schedule: "0 9 * * *",
        prompt: "daily a",
        label: "Daily A",
        enabled: true,
        nextRunAt: "2026-05-21T01:00:00.000Z",
      },
    ]);
    writeLegacyRun(root, "agent-a", "job_1", {
      status: "success",
      startedAt: "2026-05-20T01:00:00.000Z",
      finishedAt: "2026-05-20T01:00:01.000Z",
    });

    const opts = { gsapHome: root, agentsDir, getStudioId: () => "studio-main" };
    const first = new StudioCronService(opts);
    const imported = first.listJobs();
    expect(imported).toHaveLength(1);
    expect(first.getRunHistory(imported[0].id, 10)).toEqual([
      expect.objectContaining({
        status: "success",
        startedAt: "2026-05-20T01:00:00.000Z",
      }),
    ]);
    expect(first.removeJob(imported[0].id)).toBe(true);
    expect(first.listJobs()).toHaveLength(0);

    const second = new StudioCronService(opts);
    expect(second.listJobs()).toHaveLength(0);

    const legacyData = JSON.parse(
      fs.readFileSync(path.join(agentsDir, "agent-a", "desk", "cron-jobs.json"), "utf-8"),
    );
    expect(legacyData.jobs).toHaveLength(1);
    expect(legacyData.studioCronMigration).toMatchObject({
      version: 1,
      status: "imported",
      studioId: "studio-main",
    });
  });

  it("reconciles legacy stores imported before the migration marker existed", () => {
    const root = makeRoot();
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    writeLegacyJobs(root, "agent-a", [
      {
        id: "job_1",
        type: "cron",
        schedule: "0 9 * * *",
        prompt: "daily a",
        label: "Daily A",
        enabled: true,
        nextRunAt: "2026-05-21T01:00:00.000Z",
      },
    ]);
    writeStudioJobs(root, "studio-main", [
      {
        id: "studio_job_1",
        type: "cron",
        schedule: "0 9 * * *",
        prompt: "daily a",
        label: "Daily A",
        enabled: true,
        nextRunAt: "2026-05-21T01:00:00.000Z",
        legacyRef: { agentId: "agent-a", jobId: "job_1" },
      },
    ]);

    const service = new StudioCronService({
      gsapHome: root,
      agentsDir,
      getStudioId: () => "studio-main",
    });
    expect(service.listJobs()).toHaveLength(1);
    expect(service.removeJob("studio_job_1")).toBe(true);
    expect(service.listJobs()).toHaveLength(0);

    const restarted = new StudioCronService({
      gsapHome: root,
      agentsDir,
      getStudioId: () => "studio-main",
    });
    expect(restarted.listJobs()).toHaveLength(0);
  });

  it("keeps different studios isolated", () => {
    const root = makeRoot();
    roots.push(root);
    const service = new StudioCronService({
      gsapHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-a",
    });
    service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "studio a",
      actorAgentId: "agent-a",
      executionContext: { kind: "api_request", cwd: null, workspaceFolders: [] },
    });

    const otherStudio = new StudioCronService({
      gsapHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-b",
    });

    expect(otherStudio.listJobs()).toEqual([]);
  });

  it("requires new jobs to carry actorAgentId and executionContext", () => {
    const root = makeRoot();
    roots.push(root);
    const service = new StudioCronService({
      gsapHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });

    expect(() => service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "missing actor",
      executionContext: { kind: "api_request", cwd: null, workspaceFolders: [] },
    })).toThrow("cron job requires actorAgentId");

    expect(() => service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "missing context",
      actorAgentId: "agent-a",
    })).toThrow("cron job requires executionContext");
  });
});
