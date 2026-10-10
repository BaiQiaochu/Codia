// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPinnedMemoryTools } from "../lib/tools/pinned-memory.js";

describe("pinned memory tools", () => {
  const tempRoots = [];

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeAgentDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-pinned-memory-"));
    tempRoots.push(dir);
    return dir;
  }

  function getTools(agentDir) {
    const [pin, unpin] = createPinnedMemoryTools(agentDir);
    return { pin, unpin };
  }

  it("removes a newly pinned multiline memory as one entity without leaving continuation lines", async () => {
    const agentDir = makeAgentDir();
    const { pin, unpin } = getTools(agentDir);
    const content = "first line\nsecond line";

    const pinResult = await pin.execute("pin-1", { content });
    expect(pinResult.details.item).toMatchObject({ content });

    const unpinResult = await unpin.execute("unpin-1", { keyword: "first line" });

    expect(unpinResult.details.removedCount).toBe(1);
    expect(unpinResult.details.removedItems).toEqual([
      expect.objectContaining({ content }),
    ]);
    expect(fs.readFileSync(path.join(agentDir, "pinned.md"), "utf-8")).not.toContain("second line");
  });

  it("migrates legacy pinned.md continuation lines into the preceding bullet entity", async () => {
    const agentDir = makeAgentDir();
    fs.writeFileSync(
      path.join(agentDir, "pinned.md"),
      "- alpha line\ncontinued line\n- beta line\n",
      "utf-8",
    );
    const { unpin } = getTools(agentDir);

    const result = await unpin.execute("unpin-legacy", { keyword: "continued" });

    expect(result.details.removedCount).toBe(1);
    expect(result.details.removedItems).toEqual([
      expect.objectContaining({ content: "alpha line\ncontinued line" }),
    ]);
    expect(fs.readFileSync(path.join(agentDir, "pinned.md"), "utf-8")).toBe("- beta line\n");
  });

  it("keeps single-line legacy bullets compatible with keyword unpin", async () => {
    const agentDir = makeAgentDir();
    fs.writeFileSync(path.join(agentDir, "pinned.md"), "- alpha line\n- beta line\n", "utf-8");
    const { unpin } = getTools(agentDir);

    const result = await unpin.execute("unpin-single", { keyword: "alpha" });

    expect(result.details.removedCount).toBe(1);
    expect(result.details.removedItems).toEqual([
      expect.objectContaining({ content: "alpha line" }),
    ]);
    expect(fs.readFileSync(path.join(agentDir, "pinned.md"), "utf-8")).toBe("- beta line\n");
  });

  it("unpins by the entity id returned from pin_memory", async () => {
    const agentDir = makeAgentDir();
    const { pin, unpin } = getTools(agentDir);
    const pinResult = await pin.execute("pin-id", { content: "remove by id\nwith continuation" });
    const id = pinResult.details.item.id;

    const result = await unpin.execute("unpin-id", { id });

    expect(result.details.removedCount).toBe(1);
    expect(fs.readFileSync(path.join(agentDir, "pinned.md"), "utf-8")).toBe("");
  });
});
