// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { CronStore } from "../lib/desk/cron-store.js";

function makeTmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-automation-test-"));
  return {
    jobsPath: path.join(dir, "cron-jobs.json"),
    runsDir: path.join(dir, "cron-runs"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeTmpStore() {
  const paths = makeTmpPaths();
  return {
    store: new CronStore(paths.jobsPath, paths.runsDir),
    cleanup: paths.cleanup,
  };
}

describe("CronStore automation read model", () => {
  it("projects legacy prompt jobs to agent_session executors", () => {
    const { store, cleanup } = makeTmpStore();
    try {
      const model = { id: "gpt-test", provider: "openai" };
      const executionContext = {
        kind: "session_workspace",
        cwd: "/workspace",
        workspaceFolders: ["/workspace"],
        sourceSessionPath: "/sessions/source.jsonl",
        createdByAgentId: "agent-a",
      };

      const job = store.addJob({
        type: "cron",
        schedule: "0 9 * * *",
        prompt: "summarize",
        actorAgentId: "agent-a",
        executionContext,
        model,
      });

      expect(job.schemaVersion).toBe(3);
      expect(job.trigger).toEqual({ kind: "cron", expression: "0 9 * * *" });
      expect(job.executor).toMatchObject({
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "summarize",
        model,
        executionContext,
      });
      expect(job.createdBy).toEqual({ kind: "agent", agentId: "agent-a" });
    } finally {
      cleanup();
    }
  });

  it("migrates legacy notify direct-action jobs loaded from disk to agent_session executors", () => {
    const paths = makeTmpPaths();
    try {
      fs.writeFileSync(
        paths.jobsPath,
        JSON.stringify({
          jobs: [{
            id: "legacy_notify",
            type: "cron",
            schedule: "0 9 * * *",
            label: "Drink Water",
            actorAgentId: "agent-a",
            enabled: true,
            nextRunAt: "2026-05-21T01:00:00.000Z",
            executor: {
              kind: "direct_action",
              action: "notify",
              params: {
                title: "Drink water",
                body: "Stand up for a minute",
                channels: ["desktop"],
              },
            },
            createdBy: { kind: "agent", agentId: "agent-a", sourceSessionPath: "/sessions/source.jsonl" },
          }],
          nextNum: 2,
        }, null, 2),
        "utf-8",
      );
      const store = new CronStore(paths.jobsPath, paths.runsDir);
      const [job] = store.listJobs();

      expect(job.prompt).toContain("notify");
      expect(job.label).toBe("Drink Water");
      expect(job.trigger).toEqual({ kind: "cron", expression: "0 9 * * *" });
      expect(job.executor).toMatchObject({
        kind: "agent_session",
        agentId: "agent-a",
        migratedFrom: {
          kind: "direct_action",
          action: "notify",
        },
      });
      expect(job.createdBy).toEqual({
        kind: "agent",
        agentId: "agent-a",
        sourceSessionPath: "/sessions/source.jsonl",
      });
    } finally {
      paths.cleanup();
    }
  });

  it("migrates legacy plugin-action jobs loaded from disk to agent_session executors", () => {
    const paths = makeTmpPaths();
    try {
      fs.writeFileSync(
        paths.jobsPath,
        JSON.stringify({
          jobs: [{
            id: "legacy_plugin",
            type: "cron",
            schedule: "0 18 * * *",
            label: "Daily Note",
            actorAgentId: "agent-a",
            enabled: true,
            nextRunAt: "2026-05-21T10:00:00.000Z",
            executor: {
              kind: "plugin_action",
              pluginId: "notes",
              actionId: "create_note",
              params: { title: "Today" },
            },
            createdBy: { kind: "agent", agentId: "agent-a" },
          }],
          nextNum: 2,
        }, null, 2),
        "utf-8",
      );
      const store = new CronStore(paths.jobsPath, paths.runsDir);
      const [job] = store.listJobs();

      expect(job.prompt).toContain("notes");
      expect(job.executor).toMatchObject({
        kind: "agent_session",
        agentId: "agent-a",
        migratedFrom: {
          kind: "plugin_action",
          pluginId: "notes",
          actionId: "create_note",
        },
      });
    } finally {
      paths.cleanup();
    }
  });

  it("rejects explicit notify direct-action executors on new writes", () => {
    const { store, cleanup } = makeTmpStore();
    try {
      expect(() => store.addJob({
        type: "cron",
        schedule: "0 9 * * *",
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
        createdBy: { kind: "agent", agentId: "agent-a", sourceSessionPath: "/sessions/source.jsonl" },
      })).toThrow(/unsupported automation executor: direct_action/);
    } finally {
      cleanup();
    }
  });

  it("rejects removed file.create direct-action executors on new writes", () => {
    const { store, cleanup } = makeTmpStore();
    try {
      expect(() => store.addJob({
        type: "cron",
        schedule: "0 18 * * *",
        actorAgentId: "agent-a",
        executor: {
          kind: "direct_action",
          action: "file.create",
          params: { relativePath: "notes/today.md", content: "# Today\n" },
        },
      })).toThrow(/unsupported automation executor: direct_action/);
    } finally {
      cleanup();
    }
  });
});
