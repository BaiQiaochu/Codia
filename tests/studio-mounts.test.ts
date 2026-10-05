import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-studio-mounts-"));
}

describe("studio mounts", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("creates an empty registry when missing", async () => {
    tmpDir = makeTmpDir();
    const { loadStudioMountRegistry } = await import("../core/studio-mounts.ts");

    expect(loadStudioMountRegistry(tmpDir)).toMatchObject({
      schemaVersion: 1,
      mounts: [],
    });
  });

  it("validates a local storage mount", async () => {
    tmpDir = makeTmpDir();
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");

    const mount = upsertStudioMount(tmpDir, {
      mountId: "mount_projects",
      hostStudioId: "studio_host",
      sourceKind: "storage",
      provider: "local_fs",
      label: "Projects",
      presentation: "folder",
      capabilities: ["read", "list", "read"],
      status: "active",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    });

    expect(mount).toMatchObject({
      mountId: "mount_projects",
      hostStudioId: "studio_host",
      sourceKind: "storage",
      provider: "local_fs",
      capabilities: ["list", "read"],
    });
  });

  it("validates a Studio-to-Studio mount without transferring ownership", async () => {
    tmpDir = makeTmpDir();
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");

    const mount = upsertStudioMount(tmpDir, {
      mountId: "mount_design_assets",
      hostStudioId: "studio_cloud",
      sourceKind: "studio",
      sourceStudioId: "studio_home_mac",
      sourceResourceId: "res_collection_design",
      grantId: "grant_design_read",
      label: "Design Assets",
      presentation: "linked_studio",
      capabilities: ["list", "read", "materialize"],
      status: "active",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    });

    expect(mount).toMatchObject({
      hostStudioId: "studio_cloud",
      sourceKind: "studio",
      sourceStudioId: "studio_home_mac",
      sourceResourceId: "res_collection_design",
      grantId: "grant_design_read",
      capabilities: ["list", "read", "materialize"],
    });
    expect(mount).not.toHaveProperty("ownerStudioId");
  });

  it("rejects a self-cycle Studio mount", async () => {
    tmpDir = makeTmpDir();
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");

    expect(() => upsertStudioMount(tmpDir, {
      mountId: "mount_self",
      hostStudioId: "studio_same",
      sourceKind: "studio",
      sourceStudioId: "studio_same",
      sourceResourceId: "res_same",
      grantId: "grant_same",
      label: "Self",
      presentation: "linked_studio",
      capabilities: ["list"],
    })).toThrow("Studio mount cannot point at its own hostStudioId");
  });

  it("rejects unknown capabilities", async () => {
    tmpDir = makeTmpDir();
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");

    expect(() => upsertStudioMount(tmpDir, {
      mountId: "mount_bad",
      hostStudioId: "studio_host",
      sourceKind: "storage",
      provider: "local_fs",
      label: "Bad",
      presentation: "folder",
      capabilities: ["list", "sudo"],
    })).toThrow("unknown mount capability: sudo");
  });

  it("disables an existing mount without deleting the registry entry", async () => {
    tmpDir = makeTmpDir();
    const { disableStudioMount, listStudioMountsForStudio, upsertStudioMount } = await import("../core/studio-mounts.ts");
    upsertStudioMount(tmpDir, {
      mountId: "mount_projects",
      hostStudioId: "studio_host",
      sourceKind: "storage",
      provider: "local_fs",
      label: "Projects",
      presentation: "folder",
      capabilities: ["list", "read"],
    }, { now: "2026-06-17T00:00:00.000Z" });

    const disabled = disableStudioMount(tmpDir, "mount_projects", {
      hostStudioId: "studio_host",
      now: "2026-06-17T01:00:00.000Z",
    });

    expect(disabled).toMatchObject({
      mountId: "mount_projects",
      status: "disabled",
      updatedAt: "2026-06-17T01:00:00.000Z",
    });
    expect(listStudioMountsForStudio(tmpDir, "studio_host")).toEqual([
      expect.objectContaining({ mountId: "mount_projects", status: "disabled" }),
    ]);
  });
});
