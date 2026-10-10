import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

describe("MountAwareFileService", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("resolves default root and active local_fs studio mounts without exposing paths", async () => {
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    const mountRoot = path.join(tmpDir, "mount");
    fs.mkdirSync(defaultRoot, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "mounted.md"), "hello mount", "utf-8");
    upsertStudioMount(tmpDir, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });

    const service = new MountAwareFileService({
      codiaHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
    });

    expect(service.resolveRoot("default")).toMatchObject({
      id: "default",
      label: "Default",
      capabilities: ["list", "read", "write"],
    });
    expect(service.resolveRoot("default")).not.toHaveProperty("path");

    const mounted = service.resolveRoot("mount_docs");
    expect(mounted).toMatchObject({
      id: "mount_docs",
      label: "Docs",
      mountId: "mount_docs",
      capabilities: ["list", "read", "write"],
    });
    expect(mounted).not.toHaveProperty("path");
    expect(await service.listFiles("mount_docs", "")).toMatchObject({
      rootId: "mount_docs",
      files: [{ name: "mounted.md", isDir: false }],
    });
  });

  it("rejects local_fs mounts outside their resolved root", async () => {
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    fs.mkdirSync(defaultRoot, { recursive: true });
    const service = new MountAwareFileService({
      codiaHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
    });

    expect(() => service.resolveDirectory("default", "../outside")).toThrow("invalid_subdir");
  });

  it("discloses local_fs native roots only when explicitly enabled", async () => {
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    const mountRoot = path.join(tmpDir, "mount");
    fs.mkdirSync(defaultRoot, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "mounted.md"), "hello mount", "utf-8");
    upsertStudioMount(tmpDir, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });

    const disclosing = new MountAwareFileService({
      codiaHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
      discloseNativeRoot: true,
    });
    expect(disclosing.resolveRoot("mount_docs")).toMatchObject({
      mountId: "mount_docs",
      nativeRootPath: mountRoot,
    });
    expect(disclosing.resolveRoot("mount_docs")).not.toHaveProperty("path");
    expect(disclosing.resolveRoot("default")).toMatchObject({ nativeRootPath: defaultRoot });
    expect((await disclosing.listFiles("mount_docs", "")).mount).toMatchObject({
      nativeRootPath: mountRoot,
    });

    const closed = new MountAwareFileService({
      codiaHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
    });
    expect(closed.resolveRoot("mount_docs")).not.toHaveProperty("nativeRootPath");
    expect(closed.resolveRoot("default")).not.toHaveProperty("nativeRootPath");
    expect((await closed.listFiles("mount_docs", "")).mount).not.toHaveProperty("nativeRootPath");
  });
});
