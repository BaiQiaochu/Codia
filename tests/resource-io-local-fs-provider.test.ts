import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFsProvider } from "../lib/resource-io/providers/local-fs-provider.ts";
import { ResourceAccessPolicy } from "../lib/resource-io/resource-access-policy.ts";

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

describe("LocalFsProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function makeProvider(check = vi.fn(() => ({ allowed: true }))) {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-resource-local-fs-"));
    const cwd = path.join(tempRoot, "workspace");
    const trashRoot = path.join(tempRoot, "trash");
    fs.mkdirSync(cwd, { recursive: true });
    const realCwd = fs.realpathSync(cwd);
    return {
      cwd,
      realCwd,
      trashRoot,
      check,
      provider: new LocalFsProvider({ cwd, guard: { check }, trashRoot }),
    };
  }

  it("declares the complete provider capability matrix", () => {
    const { provider } = makeProvider();

    expect(Object.keys(provider.capabilities()).sort()).toEqual(CAPABILITY_KEYS);
  });

  it("writes and stats a local file through PathGuard", async () => {
    const { cwd, realCwd, check, provider } = makeProvider();
    const result = await provider.write({ kind: "local-file", path: "notes/a.md" }, "hello");

    const target = path.join(cwd, "notes", "a.md");
    const realTarget = path.join(realCwd, "notes", "a.md");
    expect(fs.readFileSync(target, "utf-8")).toBe("hello");
    expect(check).toHaveBeenCalledWith(realTarget, "write");
    expect(result).toMatchObject({
      changeType: "created",
      resourceKey: `local_fs:${realTarget.replace(/\\/g, "/")}`,
      resource: { kind: "local-file", path: realTarget, filePath: realTarget, provider: "local_fs" },
      version: { size: 5 },
    });

    await provider.write({ kind: "local-file", path: "notes/a.md" }, "hello again");
    const stat = await provider.stat({ kind: "local-file", path: "notes/a.md" });
    expect(stat).toMatchObject({ exists: true, isDirectory: false, version: { size: 11 } });
  });

  it("denies writes outside the guard", async () => {
    const { provider } = makeProvider(vi.fn(() => ({ allowed: false, reason: "denied by test" })));

    await expect(provider.write({ kind: "local-file", path: "blocked.md" }, "x"))
      .rejects.toMatchObject({
        code: "resource_access_denied",
        status: 403,
        operation: "write",
        message: "denied by test",
      });
  });

  it("propagates typed authority denials without losing safe messages", async () => {
    const { provider } = makeProvider(vi.fn(() => ({
      allowed: false,
      code: "path_outside_authorized_roots",
      reason: "outside /secret/path",
      safeMessage: "Resource is outside authorized roots",
    })));

    await expect(provider.write({ kind: "local-file", path: "blocked.md" }, "x"))
      .rejects.toMatchObject({
        code: "resource_access_denied",
        reason: "path_outside_authorized_roots",
        safeMessage: "Resource is outside authorized roots",
      });
  });

  it("allows missing-path writes under authorized parents and rejects outside writes", async () => {
    const { cwd, provider } = makeProviderWithPolicy();

    await expect(provider.write({ kind: "local-file", path: "new/deep/note.md" }, "ok"))
      .resolves.toMatchObject({ changeType: "created" });
    expect(fs.readFileSync(path.join(cwd, "new", "deep", "note.md"), "utf-8")).toBe("ok");

    await expect(provider.write({ kind: "local-file", path: path.join(path.dirname(cwd), "outside.md") }, "no"))
      .rejects.toMatchObject({
        code: "resource_access_denied",
        reason: "path_outside_authorized_roots",
      });
  });

  it("rejects symlink writes that escape the authorized workspace", async () => {
    const { cwd, provider } = makeProviderWithPolicy();
    const outside = path.join(path.dirname(cwd), "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.md"), "secret");
    fs.symlinkSync(outside, path.join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");

    await expect(provider.write({ kind: "local-file", path: "linked/secret.md" }, "overwrite"))
      .rejects.toMatchObject({
        code: "resource_access_denied",
        reason: "path_outside_authorized_roots",
      });
    expect(fs.readFileSync(path.join(outside, "secret.md"), "utf-8")).toBe("secret");
  });

  it("reads, lists, searches, copies, deletes, and materializes local files", async () => {
    const { cwd, realCwd, provider } = makeProvider();
    await provider.write({ kind: "local-file", path: "a.md" }, "alpha");
    await provider.mkdir({ kind: "local-file", path: "nested" });
    await provider.write({ kind: "local-file", path: "nested/b.md" }, "beta alpha");

    const read = await provider.read({ kind: "local-file", path: "a.md" });
    expect(read.content.toString("utf-8")).toBe("alpha");

    const list = await provider.list({ kind: "local-file", path: "." });
    expect(list.items.map((item) => item.name)).toEqual(expect.arrayContaining(["a.md", "nested"]));

    const search = await provider.search({ kind: "local-file", path: "." }, { query: "alpha" });
    expect(search.matches.map((match) => path.relative(realCwd, match.filePath).replace(/\\/g, "/"))).toEqual([
      "a.md",
      "nested/b.md",
    ]);

    const copy = await provider.copy(
      { kind: "local-file", path: "a.md" },
      { kind: "local-file", path: "copy.md" },
    );
    expect(copy.changeType).toBe("created");
    expect(fs.readFileSync(path.join(cwd, "copy.md"), "utf-8")).toBe("alpha");

    const materialized = await provider.materialize({ kind: "local-file", path: "copy.md" });
    expect(materialized.filePath).toBe(path.join(realCwd, "copy.md"));

    const deleted = await provider.delete({ kind: "local-file", path: "copy.md" });
    expect(deleted.resourceKey).toBe(`local_fs:${path.join(realCwd, "copy.md").replace(/\\/g, "/")}`);
    expect(fs.existsSync(path.join(cwd, "copy.md"))).toBe(false);
  });

  it("maps relative file watch names back to the watched file", async () => {
    const { cwd, realCwd, provider } = makeProvider();
    const filePath = path.join(cwd, "notes", "a.md");
    const realFilePath = path.join(realCwd, "notes", "a.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "alpha");

    const target = provider.watchTarget({ kind: "local-file", path: "notes/a.md" });
    const snapshot = target.toResource("a.md");

    expect(snapshot).toMatchObject({
      resourceKey: `local_fs:${realFilePath.replace(/\\/g, "/")}`,
      resource: {
        kind: "local-file",
        provider: "local_fs",
        path: realFilePath,
        filePath: realFilePath,
      },
      filePath: realFilePath,
    });
  });

  it("supports expected-version writes, rename, move, and trash as ResourceIO authority operations", async () => {
    const { cwd, realCwd, trashRoot, provider } = makeProvider();
    const source = path.join(cwd, "draft.md");
    fs.writeFileSync(source, "old", "utf-8");
    const before = fs.statSync(source);

    const stale = await provider.writeExpectedVersion(
      { kind: "local-file", path: "draft.md" },
      "stale overwrite",
      { mtimeMs: before.mtimeMs - 1, size: before.size },
    );
    expect(stale).toMatchObject({
      ok: false,
      conflict: true,
      version: { size: before.size },
    });
    expect(fs.readFileSync(source, "utf-8")).toBe("old");

    const saved = await provider.writeExpectedVersion(
      { kind: "local-file", path: "draft.md" },
      "new",
      { mtimeMs: before.mtime.getTime(), size: before.size },
    );
    expect(saved).toMatchObject({ changeType: "modified", version: { size: 3 } });

    const rename = await provider.rename(
      { kind: "local-file", path: "draft.md" },
      { kind: "local-file", path: "renamed.md" },
    );
    expect(rename).toMatchObject({
      oldResource: { filePath: path.join(realCwd, "draft.md") },
      newResource: { filePath: path.join(realCwd, "renamed.md") },
    });
    expect(fs.existsSync(path.join(cwd, "draft.md"))).toBe(false);

    const move = await provider.move(
      { kind: "local-file", path: "renamed.md" },
      { kind: "local-file", path: "archive/renamed.md" },
    );
    expect(move.newResource).toMatchObject({ filePath: path.join(realCwd, "archive", "renamed.md") });
    expect(fs.readFileSync(path.join(cwd, "archive", "renamed.md"), "utf-8")).toBe("new");

    const trashed = await provider.trash(
      { kind: "local-file", path: "archive/renamed.md" },
      { namespace: "mobile-workbench", metadata: { originalName: "renamed.md", rootId: "default" } },
    );
    expect(trashed.trashId).toMatch(/^trash_/);
    expect(trashed.payloadPath).toBe(path.join(trashRoot, "mobile-workbench", trashed.trashId, "payload"));
    expect(fs.readFileSync(trashed.payloadPath!, "utf-8")).toBe("new");
    expect(JSON.parse(fs.readFileSync(path.join(trashRoot, "mobile-workbench", trashed.trashId, "metadata.json"), "utf-8")))
      .toMatchObject({ originalName: "renamed.md", rootId: "default" });
    expect(fs.existsSync(path.join(cwd, "archive", "renamed.md"))).toBe(false);
  });
});

function makeProviderWithPolicy() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-resource-local-fs-policy-"));
  const cwd = path.join(tempRoot, "workspace");
  const agentDir = path.join(tempRoot, "codia-home", "agents", "codia");
  const codiaHome = path.join(tempRoot, "codia-home");
  const trashRoot = path.join(tempRoot, "trash");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const guard = new ResourceAccessPolicy({
    cwd,
    agentDir,
    workspace: cwd,
    workspaceFolders: [cwd],
    codiaHome,
    getSandboxEnabled: () => true,
  });
  return {
    cwd,
    provider: new LocalFsProvider({ cwd, guard, trashRoot }),
  };
}
