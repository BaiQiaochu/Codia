import { describe, expect, it } from "vitest";
import { repairRestoredToolSnapshot } from "../core/tool-snapshot-repair.js";

describe("repairRestoredToolSnapshot", () => {
  it("deduplicates restored snapshots and restores available core tools", () => {
    const repaired = repairRestoredToolSnapshot(
      ["todo_write", "read", "retired_tool", "todo_write"],
      ["read", "bash", "edit", "todo_write", "browser"],
      { coreToolNames: ["read", "bash", "edit"] },
    );

    expect(repaired).toEqual(["todo_write", "read", "bash", "edit"]);
  });

  it("does not resurrect unavailable or globally gated tools", () => {
    const repaired = repairRestoredToolSnapshot(
      ["browser", "dm", "bash"],
      ["read", "bash", "todo_write"],
      { coreToolNames: ["read", "bash"] },
    );

    expect(repaired).toEqual(["bash", "read"]);
  });
});
