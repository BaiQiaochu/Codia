import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../lib/desk/activity-store.js";

const roots: string[] = [];

describe("desk activities route", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reconciles overdue running activities before returning the activity list", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-activities-route-"));
    roots.push(root);
    const now = Date.UTC(2026, 5, 6, 12, 0, 0);
    const activityFile = path.join(root, "agents", "agent-1", "desk", "activities.json");
    fs.mkdirSync(path.dirname(activityFile), { recursive: true });
    fs.writeFileSync(activityFile, JSON.stringify([
      {
        id: "act-overdue",
        type: "beautify",
        label: "Markdown cover",
        status: "running",
        startedAt: now - 20 * 60 * 1000 - 1,
        summary: "正在生成 cover",
      },
    ]), "utf-8");
    const store = new ActivityStore(activityFile, path.join(root, "agents", "agent-1", "activity"), {
      finalizeOrphanedRunning: false,
    });
    const emit = vi.fn();
    const engine = {
      listAgents: () => [{ id: "agent-1", name: "Codia" }],
      getActivityStore: () => store,
    };
    const { createDeskRoute } = await import("../server/routes/desk.js");
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, { eventBus: { emit } }));

    vi.setSystemTime(now);
    const res = await app.request("/api/desk/activities");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activities).toEqual([
      expect.objectContaining({
        id: "act-overdue",
        status: "error",
        error: "timeout",
        agentId: "agent-1",
        agentName: "Codia",
      }),
    ]);
    expect(store.get("act-overdue")).toMatchObject({ status: "error", error: "timeout" });
    expect(emit).toHaveBeenCalledWith(
      { type: "activity_update", activity: expect.objectContaining({ id: "act-overdue", status: "error" }) },
      null,
    );
  });
});
