import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityStore } from "../lib/desk/activity-store.js";

const roots: string[] = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-activity-store-"));
  roots.push(root);
  return root;
}

function writeActivities(root: string, entries: any[]) {
  const filePath = path.join(root, "desk", "activities.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
  return filePath;
}

describe("ActivityStore lifecycle reconciliation", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks persisted running entries interrupted when a store is rehydrated after restart", () => {
    const root = makeRoot();
    const now = Date.UTC(2026, 5, 6, 12, 0, 0);
    const filePath = writeActivities(root, [
      {
        id: "act-running",
        type: "beautify",
        label: "Markdown cover",
        status: "running",
        startedAt: now - 60_000,
        summary: "正在生成",
      },
      {
        id: "act-done",
        type: "cron",
        label: "Done",
        status: "done",
        startedAt: now - 10_000,
        finishedAt: now - 5_000,
      },
    ]);

    const store = new ActivityStore(filePath, path.join(root, "activity"), { now });

    expect(store.list()).toEqual([
      expect.objectContaining({
        id: "act-running",
        status: "error",
        finishedAt: now,
        error: "interrupted",
        summary: expect.stringContaining("中断"),
      }),
      expect.objectContaining({
        id: "act-done",
        status: "done",
      }),
    ]);
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(persisted[0]).toMatchObject({ id: "act-running", status: "error", error: "interrupted" });
  });

  it("marks only overdue running entries timed out during list reconciliation", () => {
    const root = makeRoot();
    const now = Date.UTC(2026, 5, 6, 12, 0, 0);
    const timeoutMs = 20 * 60 * 1000;
    const filePath = writeActivities(root, [
      {
        id: "act-old",
        type: "beautify",
        label: "Markdown cover",
        status: "running",
        startedAt: now - timeoutMs - 1,
        summary: "旧任务",
      },
      {
        id: "act-fresh",
        type: "beautify",
        label: "Markdown cover",
        status: "running",
        startedAt: now - timeoutMs + 1,
        summary: "新任务",
      },
    ]);
    const store = new ActivityStore(filePath, path.join(root, "activity"), {
      finalizeOrphanedRunning: false,
      executionTimeoutMs: timeoutMs,
    });

    const changed = store.reconcileOverdueRunning({ now });

    expect(changed).toEqual([
      expect.objectContaining({
        id: "act-old",
        status: "error",
        finishedAt: now,
        error: "timeout",
        summary: expect.stringContaining("超时"),
      }),
    ]);
    expect(store.get("act-fresh")).toMatchObject({ status: "running", summary: "新任务" });
  });
});
