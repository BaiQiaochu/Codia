import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";
import { SessionFileResolver } from "../lib/resource-io/session-file-resolver.ts";
import { SessionFileResolverProvider } from "../lib/resource-io/providers/session-file-resolver.ts";

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

describe("SessionFileResolverProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function setup() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resource-session-file-"));
    const sessionPath = path.join(tempRoot, "agents", "gsap", "sessions", "a.jsonl");
    const filePath = path.join(tempRoot, "files", "note.md");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");
    fs.writeFileSync(filePath, "# hello\n", "utf-8");
    const registry = new SessionFileRegistry({
      managedCacheRoot: path.join(tempRoot, "session-files"),
    });
    const entry = registry.registerFile({
      sessionPath,
      filePath,
      label: "note.md",
      origin: "test",
      storageKind: "external",
    });
    return {
      entry,
      filePath,
      provider: new SessionFileResolverProvider({ sessionFiles: registry }),
    };
  }

  it("resolves SessionFile entries through one resolver service", () => {
    const { entry, filePath } = setup();
    const resolver = new SessionFileResolver({
      sessionFiles: {
        get: (fileId: string) => fileId === entry.id ? entry : null,
      },
    });

    const resolved = resolver.resolve({ kind: "session-file", fileId: entry.id });

    expect(resolved).toMatchObject({
      ref: { kind: "session-file", fileId: entry.id },
      entry,
      filePath: fs.realpathSync(filePath),
      displayName: "note.md",
      storageKind: "external",
    });
  });

  it("returns typed not-found errors from the SessionFile resolver", () => {
    const resolver = new SessionFileResolver({
      sessionFiles: { get: () => null },
    });

    expect(() => resolver.resolve({ kind: "session-file", fileId: "sf_missing" }))
      .toThrow(expect.objectContaining({ code: "resource_not_found", status: 404 }));
  });

  it("resolves SessionFile stat, read, and materialize without exposing it as writable", async () => {
    const { entry, filePath, provider } = setup();
    const realPath = fs.realpathSync(filePath);
    const ref = { kind: "session-file" as const, fileId: entry.id };

    expect(Object.keys(provider.capabilities()).sort()).toEqual(CAPABILITY_KEYS);

    const stat = await provider.stat(ref);
    expect(stat).toMatchObject({
      exists: true,
      isDirectory: false,
      resourceKey: `session_file:${entry.id}`,
      resource: {
        kind: "session-file",
        fileId: entry.id,
        provider: "session_file",
        filePath: realPath,
      },
      version: { size: 8 },
    });

    const read = await provider.read(ref);
    expect(read.content.toString("utf-8")).toBe("# hello\n");

    const materialized = await provider.materialize(ref);
    expect(materialized.filePath).toBe(realPath);

    await expect(provider.write(ref, "changed")).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.writeExpectedVersion(ref, "changed", { mtimeMs: 1, size: 1 })).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.edit(ref, [{ oldText: "hello", newText: "bye" }])).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.rename(ref, ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.move(ref, ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.trash(ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.delete(ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.mkdir(ref)).rejects.toMatchObject({ code: "capability_denied" });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("# hello\n");
  });
});
