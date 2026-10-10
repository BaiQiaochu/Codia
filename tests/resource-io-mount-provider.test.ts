import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertStudioMount } from "../core/studio-mounts.ts";
import { LocalFsProvider } from "../lib/resource-io/providers/local-fs-provider.ts";
import { MountProvider } from "../lib/resource-io/providers/mount-provider.ts";

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

describe("MountProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function setup() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-resource-mount-"));
    const codiaHome = path.join(tempRoot, "codia");
    const mountRoot = path.join(tempRoot, "mounted");
    fs.mkdirSync(mountRoot, { recursive: true });
    const studioId = "studio_mount";
    upsertStudioMount(codiaHome, {
      schemaVersion: 1,
      mountId: "mount_local",
      hostStudioId: studioId,
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Mounted",
      presentation: "folder",
      capabilities: ["list", "read", "write", "watch", "materialize"],
      grantId: null,
    });
    upsertStudioMount(codiaHome, {
      schemaVersion: 1,
      mountId: "mount_s3",
      hostStudioId: studioId,
      sourceKind: "storage",
      provider: "s3",
      rootLocator: { bucket: "codia" },
      label: "Remote",
      presentation: "folder",
      capabilities: ["list", "read"],
      grantId: null,
    });
    return {
      mountRoot,
      provider: new MountProvider({
        codiaHome,
        studioId,
        localFsProviderFactory: ({ cwd, guard }) => new LocalFsProvider({ cwd, guard }),
      }),
    };
  }

  it("declares the complete provider capability matrix", () => {
    const { provider } = setup();

    expect(Object.keys(provider.capabilities({ kind: "mount", mountId: "mount_local", path: "docs/a.md" })).sort())
      .toEqual(CAPABILITY_KEYS);
  });

  it("dispatches local_fs mounts through local path scoping and mount resource keys", async () => {
    const { mountRoot, provider } = setup();
    const result = await provider.write({ kind: "mount", mountId: "mount_local", path: "docs/a.md" }, "hello");

    const target = path.join(mountRoot, "docs", "a.md");
    const realTarget = fs.realpathSync(target);
    expect(fs.readFileSync(target, "utf-8")).toBe("hello");
    expect(result).toMatchObject({
      changeType: "created",
      resourceKey: "mount:mount_local:docs/a.md",
      resource: {
        kind: "mount",
        mountId: "mount_local",
        path: "docs/a.md",
        provider: "mount",
        filePath: realTarget,
      },
      filePath: realTarget,
    });

    const read = await provider.read({ kind: "mount", mountId: "mount_local", path: "docs/a.md" });
    expect(read.content.toString("utf-8")).toBe("hello");
  });

  it("resolves local_fs watch targets and maps native child paths back to mount resources", () => {
    const { mountRoot, provider } = setup();
    const target = provider.watchTarget({ kind: "mount", mountId: "mount_local", path: "docs" });
    const expectedRoot = path.join(fs.realpathSync(mountRoot), "docs");
    const changedPath = path.join(expectedRoot, "notes", "a.md");

    expect(target).toMatchObject({
      filePath: expectedRoot,
      resourceKey: "mount:mount_local:docs",
      resource: {
        kind: "mount",
        mountId: "mount_local",
        path: "docs",
        provider: "mount",
        filePath: expectedRoot,
      },
    });

    expect(target.toResource(changedPath)).toMatchObject({
      resourceKey: "mount:mount_local:docs/notes/a.md",
      resource: {
        kind: "mount",
        mountId: "mount_local",
        path: "docs/notes/a.md",
        provider: "mount",
        filePath: changedPath,
      },
    });
  });

  it("maps relative file watch names back to the watched mount file", () => {
    const { mountRoot, provider } = setup();
    const filePath = path.join(mountRoot, "docs", "a.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "alpha");
    const realFilePath = fs.realpathSync(filePath);

    const target = provider.watchTarget({ kind: "mount", mountId: "mount_local", path: "docs/a.md" });
    const snapshot = target.toResource("a.md");

    expect(snapshot).toMatchObject({
      resourceKey: "mount:mount_local:docs/a.md",
      resource: {
        kind: "mount",
        mountId: "mount_local",
        path: "docs/a.md",
        provider: "mount",
        filePath: realFilePath,
      },
      filePath: realFilePath,
    });
  });

  it("rejects path escapes and unsupported remote mounts explicitly", async () => {
    const { provider } = setup();

    await expect(provider.read({ kind: "mount", mountId: "mount_local", path: "../secret.md" }))
      .rejects.toMatchObject({ code: "invalid_path" });
    await expect(provider.read({ kind: "mount", mountId: "mount_s3", path: "a.md" }))
      .rejects.toMatchObject({ code: "provider_not_available" });
  });
});
