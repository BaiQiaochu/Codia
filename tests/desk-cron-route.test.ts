import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDeskRoute } from "../server/routes/desk.js";

function createCronStore() {
  return {
    addJob: vi.fn(() => ({ id: "job_1", label: "Test job" })),
    removeJob: vi.fn(() => true),
    toggleJob: vi.fn(() => ({ id: "job_1", enabled: false })),
    updateJob: vi.fn(() => ({ id: "job_1", label: "Updated job" })),
    listJobs: vi.fn(() => [{ id: "job_1", label: "Test job" }]),
    getJob: vi.fn((id) => ({ id, label: "Test job" })),
  };
}

describe("desk cron route", () => {
  it("supports manual cron creation", async () => {
    const cronStore = createCronStore();
    const app = new Hono();
    const engine = {
      currentAgentId: "hana",
      getAgent: vi.fn(() => ({
        id: "hana",
        cronStore,
        deskDir: "",
      })),
      deskCwd: "",
      homeCwd: "",
    };
    app.route("/api", createDeskRoute(engine, { scheduler: {} }));

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "every",
        schedule: 5,
        prompt: "summarize my desk",
        label: "Desk summary",
      }),
    });

    expect(res.status).toBe(200);
    expect(cronStore.addJob).toHaveBeenCalledWith(expect.objectContaining({
      type: "every",
      prompt: "summarize my desk",
      label: "Desk summary",
    }));
  });

  it("supports manual run-now dispatch", async () => {
    const cronStore = createCronStore();
    const runAgentCronNow = vi.fn(async () => ({ status: "success" }));
    const app = new Hono();
    const engine = {
      currentAgentId: "hana",
      getAgent: vi.fn(() => ({
        id: "hana",
        cronStore,
        deskDir: "",
      })),
      deskCwd: "",
      homeCwd: "",
    };
    app.route("/api", createDeskRoute(engine, { scheduler: { runAgentCronNow } }));

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "run-now",
        id: "job_1",
      }),
    });

    expect(res.status).toBe(200);
    expect(runAgentCronNow).toHaveBeenCalledWith("hana", "job_1");
  });

  it("returns 400 for invalid cron expressions", async () => {
    const cronStore = createCronStore();
    cronStore.addJob.mockImplementation(() => {
      throw new Error('无效的 cron schedule: "70 * * * *"');
    });
    const app = new Hono();
    const engine = {
      currentAgentId: "hana",
      getAgent: vi.fn(() => ({
        id: "hana",
        cronStore,
        deskDir: "",
      })),
      deskCwd: "",
      homeCwd: "",
    };
    app.route("/api", createDeskRoute(engine, { scheduler: {} }));

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "70 * * * *",
        prompt: "broken",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("无效的 cron schedule");
  });
});
