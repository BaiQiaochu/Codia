import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createSystemHealthRoute } from "../server/routes/system-health.ts";
import { createStartupHealthSnapshot } from "../server/startup-health.ts";

function createApp(engine, options) {
  const app = new Hono();
  app.route("/api", createSystemHealthRoute(engine, options));
  return app;
}

describe("system health route", () => {
  it("does not report a removed VS Code coding runtime in startup health", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codia-health-vscode-"));
    const snapshot = createStartupHealthSnapshot({
      projectRoot: tmp,
      artifactsDir: path.join(tmp, "artifacts"),
      platform: "win32",
    });

    expect(snapshot).not.toHaveProperty("vscodeRuntime");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns local health, plugin, task, schedule and deferred summaries", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codia-health-"));
    try {
      const localHealthPath = path.join(tmp, "local-health.json");
      fs.writeFileSync(localHealthPath, JSON.stringify({
        ok: true,
        startedAt: "2026-05-16T01:00:00.000Z",
        finishedAt: "2026-05-16T01:00:05.000Z",
        skippedBuild: true,
        checks: [
          { name: "lint:quiet", status: 0, durationMs: 50 },
          { name: "test:core", status: 0, durationMs: 100 },
        ],
      }), "utf-8");

      const engine = {
        pluginManager: {
          listPlugins: () => [
            { id: "ok", status: "loaded", hidden: false },
            { id: "warn", status: "loaded", disabledTools: [{ name: "demo", reason: "off" }], hidden: false },
            { id: "failed", status: "failed", error: "boom", hidden: false },
          ],
        },
        taskRegistry: {
          listAll: () => [
            { taskId: "task-1", type: "subagent", aborted: false, status: "running" },
            { taskId: "task-2", type: "plugin", aborted: true, status: "aborted", failureReason: "user aborted" },
          ],
          listAttention: () => [
            { taskId: "task-2", type: "plugin", aborted: true, status: "aborted", failureReason: "user aborted", updatedAt: 100 },
          ],
          listSchedules: () => [{ scheduleId: "daily", type: "digest", enabled: true }],
          canRetry: (taskId) => taskId === "task-2",
        },
        deferredResults: {
          summary: () => ({
            total: 3,
            pending: 1,
            resolved: 1,
            failed: 1,
            aborted: 0,
            delivered: 1,
            undelivered: 1,
          }),
          listAttention: () => [
            { taskId: "deferred-1", status: "failed", sessionPath: "E:/session.jsonl", meta: { type: "image" }, deferredAt: 90, reason: "boom", delivered: false },
          ],
        },
        availableModels: [
          { id: "vision-model", provider: "openai", input: ["text", "image"], reasoning: true },
        ],
        providerRegistry: {
          getAllModelsByType: (type) => type === "image"
            ? [{ id: "img", provider: "openai", type: "image" }]
            : [],
          getAll: () => new Map([
            ["openai", { id: "openai", displayName: "OpenAI", api: "openai" }],
          ]),
        },
      };

      const app = createApp(engine, { localHealthPath });
      const res = await app.request("/api/system/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        localHealth: {
          available: true,
          ok: true,
          checks: { total: 2, failed: 0 },
        },
        startup: {
          buildArtifacts: expect.objectContaining({
            available: true,
            status: expect.any(String),
          }),
          audits: expect.objectContaining({
            themeToken: expect.objectContaining({ status: expect.any(String) }),
            mojibake: expect.objectContaining({ status: expect.any(String) }),
          }),
          bridge: expect.objectContaining({
            available: false,
          }),
        },
        plugins: {
          summary: { total: 3, ok: 1, warn: 1, error: 1 },
        },
        tasks: {
          total: 2,
          aborted: 1,
          schedules: 1,
        },
        deferred: {
          total: 3,
          pending: 1,
          failed: 1,
          undelivered: 1,
        },
        recovery: {
          attention: 2,
          failed: 1,
          aborted: 1,
          undelivered: 1,
        },
        media: {
          byType: {
            image: { models: 1, providers: 1 },
          },
        },
        models: {
          total: 1,
          providers: 1,
          vision: 1,
        },
      });

      const recoveryRes = await app.request("/api/system/task-recovery");
      expect(recoveryRes.status).toBe(200);
      const recovery = await recoveryRes.json();
      expect(recovery.summary).toMatchObject({ attention: 2, failed: 1, aborted: 1 });
      expect(recovery.items.map((item) => item.taskId)).toEqual(["task-2", "deferred-1"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns an operations overview with health, provider, workflow, and release modules", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codia-ops-overview-"));
    try {
      const localHealthPath = path.join(tmp, "local-health.json");
      fs.writeFileSync(localHealthPath, JSON.stringify({
        ok: true,
        checks: [
          { name: "typecheck", status: 0, durationMs: 100 },
          { name: "lint --quiet", status: 0, durationMs: 80 },
          { name: "audit:source-tree --strict", status: 0, durationMs: 40 },
          { name: "test:core", status: 0, durationMs: 200 },
        ],
      }), "utf-8");

      const engine = {
        pluginManager: {
          listPlugins: () => [
            { id: "ok", status: "loaded", hidden: false },
          ],
        },
        taskRegistry: {
          listAll: () => [
            { taskId: "wf-1", type: "workflow", status: "succeeded", updatedAt: 100 },
            { taskId: "sub-1", type: "subagent", status: "running", updatedAt: 90 },
          ],
          listSchedules: () => [],
          listAttention: () => [],
        },
        deferredResults: {
          summary: () => ({ total: 1, pending: 0, resolved: 1, failed: 0, aborted: 0, delivered: 1, undelivered: 0 }),
          listAttention: () => [],
        },
        availableModels: [
          { id: "chat", provider: "openai", input: ["text"], contextWindow: 128000 },
          { id: "img", provider: "openai", type: "image_generation", input: ["text", "image"] },
        ],
        providerRegistry: {
          getAllModelsByType: (type) => type === "image"
            ? [{ id: "img", provider: "openai", type: "image" }]
            : [],
          getAll: () => new Map([
            ["openai", { id: "openai", displayName: "OpenAI", api: "openai", api_key: "codia-runtime-api-key:openai", models: [{ id: "chat" }] }],
            ["empty", { id: "empty", displayName: "Empty", api: "openai-compatible", api_key: "", models: [] }],
          ]),
        },
      };

      const app = createApp(engine, { localHealthPath, artifactsDir: path.join(tmp, "artifacts") });
      const res = await app.request("/api/system/ops-overview");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.modules.map((module) => module.id)).toEqual([
        "system-health-center",
        "provider-debugger",
        "workflow-audit",
        "release-preflight",
      ]);
      expect(json.modules[0]).toMatchObject({
        title: "系统健康中心",
        status: "ok",
      });
      expect(json.modules[1]).toMatchObject({
        title: "Provider 调试器",
        status: "warn",
      });
      expect(json.modules[1].items).toContainEqual(expect.objectContaining({
        id: "provider-openai",
        label: "OpenAI",
        value: expect.stringContaining("runtime secret"),
        status: "ok",
        providerId: "openai",
        testModelId: "chat",
      }));
      expect(json.modules[1].items).toContainEqual(expect.objectContaining({
        id: "provider-empty",
        status: "error",
      }));
      expect(json.modules[2]).toMatchObject({
        title: "工作流执行审计",
        status: "ok",
      });
      expect(json.modules[2].items).toContainEqual(expect.objectContaining({
        id: "workflow-run-wf-1",
        label: "wf-1",
        value: "succeeded",
        status: "ok",
      }));
      expect(json.modules[3].checks.map((check) => check.id)).toEqual([
        "typecheck",
        "lint-quiet",
        "source-tree-audit",
        "core-tests",
      ]);
      expect(json.modules[3].status).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns warning-shaped defaults when local health and registries are unavailable", async () => {
    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-health-missing-"));
    fs.rmSync(missingRoot, { recursive: true, force: true });
    const app = createApp({}, {
      localHealthPath: path.join(missingRoot, "local-health.json"),
      artifactsDir: path.join(missingRoot, "artifacts"),
    });
    const res = await app.request("/api/system/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      localHealth: { available: false, ok: null },
      startup: {
        audits: {
          themeToken: { available: false, status: "warn" },
          mojibake: { available: false, status: "warn" },
          commentCode: { available: false, status: "warn" },
        },
      },
      plugins: { summary: { total: 0, ok: 0, warn: 0, error: 0 } },
      tasks: { total: 0, aborted: 0, schedules: 0 },
      deferred: { total: 0, pending: 0, resolved: 0, failed: 0, aborted: 0, delivered: 0, undelivered: 0 },
      recovery: { attention: 0, failed: 0, aborted: 0, undelivered: 0 },
      media: { byType: { image: { models: 0, providers: 0 } } },
      models: { total: 0, providers: 0 },
    });
  });

  it("exposes a retry endpoint only for task handlers that support retry", async () => {
    const calls = [];
    const app = createApp({
      taskRegistry: {
        retry: (taskId) => {
          calls.push(taskId);
          if (taskId === "missing") return { status: "not_found" };
          if (taskId === "unsupported") return { status: "unsupported" };
          return { status: "retrying" };
        },
      },
    }, {});

    expect((await app.request("/api/system/task-recovery/task-1/retry", { method: "POST" })).status).toBe(200);
    expect((await app.request("/api/system/task-recovery/unsupported/retry", { method: "POST" })).status).toBe(400);
    expect((await app.request("/api/system/task-recovery/missing/retry", { method: "POST" })).status).toBe(404);
    expect(calls).toEqual(["task-1", "unsupported", "missing"]);
  });
});
