import { describe, expect, it } from "vitest";

describe("serializeSessionFile", () => {
  it("keeps legacy fields while adding a resource envelope when studioId is available", async () => {
    const { serializeSessionFile } = await import("../lib/session-files/session-file-response.js");

    const serialized = serializeSessionFile({
      id: "sf_response",
      sessionPath: "/tmp/agents/gsap/sessions/main.jsonl",
      filePath: "/tmp/work/report.md",
      realPath: "/private/tmp/work/report.md",
      label: "report.md",
      displayName: "Report",
      filename: "report.md",
      ext: "md",
      mime: "text/markdown",
      size: 42,
      kind: "document",
      origin: "agent_write",
      operations: ["created"],
      storageKind: "external",
      status: "available",
      missingAt: null,
      createdAt: 123,
    }, { studioId: "studio_response" });

    expect(serialized).toMatchObject({
      id: "sf_response",
      fileId: "sf_response",
      sessionPath: "/tmp/agents/gsap/sessions/main.jsonl",
      filePath: "/tmp/work/report.md",
      realPath: "/private/tmp/work/report.md",
      label: "report.md",
      operations: ["created"],
      resource: {
        resourceId: "res_sf_response",
        name: "studios/studio_response/resources/res_sf_response",
        studioId: "studio_response",
        type: "file",
        source: "session_file",
        fileId: "sf_response",
        links: {
          self: "/api/resources/res_sf_response",
          content: "/api/resources/res_sf_response/content",
        },
      },
    });
  });

  it("does not add a resource envelope when studio identity is unavailable", async () => {
    const { serializeSessionFile } = await import("../lib/session-files/session-file-response.js");

    const serialized = serializeSessionFile({
      id: "sf_no_studio",
      filePath: "/tmp/work/report.md",
    });

    expect(serialized.resource).toBeUndefined();
  });
});
