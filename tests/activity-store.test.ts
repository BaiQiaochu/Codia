import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

import { ActivityStore } from "../lib/desk/activity-store.js";

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-store-"));
  return {
    filePath: path.join(dir, "desk", "activities.json"),
    activityDir: path.join(dir, "activity"),
  };
}

describe("ActivityStore", () => {
  it("persists added, updated, and removed entries", () => {
    const { filePath, activityDir } = makeStore();
    const store = new ActivityStore(filePath, activityDir);

    store.add({ id: "a1", status: "running", summary: "Research" });

    expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toEqual([
      expect.objectContaining({ id: "a1", status: "running" }),
    ]);

    store.update("a1", { status: "done" });
    expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))[0].status).toBe("done");

    store.remove("a1");
    expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toEqual([]);
  });
});
