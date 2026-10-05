import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("background runtime sync wiring", () => {
  it("engine config updates trigger background runtime sync", () => {
    const source = read("core/engine.ts");

    expect(source).toContain("syncBackgroundExecution");
    expect(source).toContain("await this._hubCallbacks?.syncBackgroundExecution?.();");
  });

  it("scheduler and channel router guard background work behind runnable models", () => {
    const schedulerSource = read("hub/scheduler.ts");
    const routerSource = read("hub/channel-router.ts");

    expect(schedulerSource).toContain("canRunBackgroundTask");
    expect(schedulerSource).toContain("syncAvailability()");
    expect(routerSource).toContain("canRunBackgroundTask");
    expect(routerSource).toContain("syncAvailability()");
  });
});
