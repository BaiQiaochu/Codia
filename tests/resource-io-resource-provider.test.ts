import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";
import { ResourceService } from "../core/resource-service.ts";
import { ResourceProvider } from "../lib/resource-io/providers/resource-provider.ts";

const CAPABILITY_KEYS = [
  "stat",
  "read",
  "write",
  "writeExpectedVersion",
  "edit",
  "list",
  "search",
  "watch",
  "materialize",
  "copy",
  "rename",
  "move",
  "trash",
  "delete",
  "mkdir",
].sort();

describe("ResourceProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function setup() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resource-provider-"));
    const agentsDir = path.join(tempRoot, "agents");
    const sessionPath = path.join(agentsDir, "gsap", "sessions", "a.jsonl");
    const filePath = path.join(tempRoot, "files", "note.txt");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");
    fs.writeFileSync(filePath, "resource text\n", "utf-8");
    const sessionFiles = new SessionFileRegistry();
    const entry = sessionFiles.registerFile({ sessionPath, filePath, label: "note.txt", origin: "test" });
    const service = new ResourceService({
      agentsDir,
      sessionFiles,
      runtimeContext: { studioId: "studio_resource" },
    });
    return {
      entry,
      provider: new ResourceProvider({ resourceService: service }),
    };
  }

  it("reads, stats, and materializes ResourceService file envelopes", async () => {
    const { entry, provider } = setup();
    const resourceId = `res_${entry.id}`;

    const stat = await provider.stat({ kind: "resource", resourceId });
    expect(stat).toMatchObject({
      exists: true,
      isDirectory: false,
      resourceKey: `resource:${resourceId}`,
      resource: {
        kind: "resource",
        resourceId,
        provider: "resource",
        displayName: "note.txt",
      },
      version: { size: 14 },
    });

    const read = await provider.read({ kind: "resource", resourceId });
    expect(read.content.toString("utf-8")).toBe("resource text\n");

    const materialized = await provider.materialize({ kind: "resource", resourceId });
    expect(materialized.filePath).toBe(read.filePath);

    await expect(provider.write({ kind: "resource", resourceId }, "changed"))
      .rejects.toMatchObject({ code: "capability_denied" });
  });

  it("declares complete read-only capabilities and denies direct mutations", async () => {
    const { entry, provider } = setup();
    const ref = { kind: "resource" as const, resourceId: `res_${entry.id}` };

    expect(Object.keys(provider.capabilities()).sort()).toEqual(CAPABILITY_KEYS);
    await expect(provider.write(ref, "x")).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.writeExpectedVersion(ref, "x", { mtimeMs: 1, size: 1 })).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.edit(ref, [{ oldText: "a", newText: "b" }])).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.rename(ref, ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.move(ref, ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.trash(ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.delete(ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.mkdir(ref)).rejects.toMatchObject({ code: "capability_denied" });
  });
});
