import { describe, expect, it } from "vitest";

describe("ResourceEnvelope", () => {
  it("derives a path-free file resource envelope from a SessionFile", async () => {
    const { createSessionFileResourceEnvelope } = await import("../lib/resources/resource-envelope.ts");

    const resource = createSessionFileResourceEnvelope({
      id: "sf_abc123",
      sessionPath: "/Users/example/.codia/agents/codia/sessions/main.jsonl",
      filePath: "/Users/example/workspace/image.png",
      realPath: "/private/var/example/workspace/image.png",
      displayName: "Sketch",
      filename: "image.png",
      label: "Sketch",
      ext: "png",
      mime: "image/png",
      size: 12,
      kind: "image",
      isDirectory: false,
      origin: "user_upload",
      operations: ["uploaded"],
      createdAt: 1000,
      mtimeMs: 2000,
      storageKind: "managed_cache",
      status: "available",
      missingAt: null,
    }, { studioId: "studio_local" });

    expect(resource).toEqual({
      schemaVersion: 1,
      resourceId: "res_sf_abc123",
      name: "studios/studio_local/resources/res_sf_abc123",
      studioId: "studio_local",
      type: "file",
      source: "session_file",
      sourceId: "sf_abc123",
      fileId: "sf_abc123",
      displayName: "Sketch",
      filename: "image.png",
      ext: "png",
      mime: "image/png",
      size: 12,
      kind: "image",
      isDirectory: false,
      origin: "user_upload",
      operations: ["uploaded"],
      createdAt: 1000,
      mtimeMs: 2000,
      lifecycle: {
        status: "available",
        missingAt: null,
      },
      storage: {
        provider: "session_file",
        storageKind: "managed_cache",
        localOnly: true,
      },
      links: {
        self: "/api/resources/res_sf_abc123",
        content: "/api/resources/res_sf_abc123/content",
      },
    });
    expect(JSON.stringify(resource)).not.toContain("/Users/example");
    expect(JSON.stringify(resource)).not.toContain("/private/var");
  });

  it("omits content links for directory resources", async () => {
    const { createSessionFileResourceEnvelope } = await import("../lib/resources/resource-envelope.ts");

    const resource = createSessionFileResourceEnvelope({
      id: "sf_dir",
      displayName: "Folder",
      filename: "Folder",
      mime: "inode/directory",
      kind: "directory",
      isDirectory: true,
      storageKind: "external",
      status: "available",
    }, { studioId: "studio_local" });

    expect(resource.links).toEqual({
      self: "/api/resources/res_sf_dir",
    });
  });

  it("returns null when the SessionFile has no stable file id", async () => {
    const { createSessionFileResourceEnvelope } = await import("../lib/resources/resource-envelope.ts");

    expect(createSessionFileResourceEnvelope({
      filePath: "/tmp/no-id.txt",
      displayName: "no-id.txt",
    }, { studioId: "studio_local" })).toBeNull();
  });
});
