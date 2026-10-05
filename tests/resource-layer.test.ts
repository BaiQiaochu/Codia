// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.js";

describe("resource layer", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeTmpDir(prefix = "gsap-resource-layer-") {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return tmpDir;
  }

  function writeSessionFileSidecar({
    fileId = "sf_legacy",
    status = "available",
    fileExists = true,
    missingAt = null,
  } = {}) {
    const root = makeTmpDir();
    const agentsDir = path.join(root, "agents");
    const sessionPath = path.join(agentsDir, "assistant", "sessions", "main.jsonl");
    const filePath = path.join(root, "workspace", "note.txt");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");
    if (fileExists) fs.writeFileSync(filePath, "hello resources\n", "utf-8");
    fs.writeFileSync(`${sessionPath}.files.json`, `${JSON.stringify({
      version: 1,
      sessionPath,
      files: {
        [fileId]: {
          id: fileId,
          sessionPath,
          filePath,
          realPath: filePath,
          displayName: "Resource Note",
          filename: "note.txt",
          label: "Resource Note",
          ext: "txt",
          mime: "text/plain",
          size: 16,
          kind: "document",
          isDirectory: false,
          origin: "stage_files",
          operations: ["staged"],
          createdAt: 111,
          mtimeMs: 222,
          storageKind: "external",
          status,
          missingAt: missingAt ?? (status === "expired" ? 333 : null),
        },
      },
      refs: [],
      createdAt: 111,
      updatedAt: 222,
    }, null, 2)}\n`, "utf-8");
    return { agentsDir, filePath, fileId };
  }

  it("resolves session file resources from existing sidecars without migration", async () => {
    const { ResourceService } = await import("../core/resource-service.js");
    const { agentsDir } = writeSessionFileSidecar({ fileId: "sf_existing" });
    const service = new ResourceService({
      agentsDir,
      sessionFiles: new SessionFileRegistry(),
      runtimeContext: { studioId: "studio_local" },
    });

    const resource = service.getResource("res_sf_existing");

    expect(resource).toMatchObject({
      resourceId: "res_sf_existing",
      name: "studios/studio_local/resources/res_sf_existing",
      studioId: "studio_local",
      type: "file",
      source: "session_file",
      fileId: "sf_existing",
      displayName: "Resource Note",
      lifecycle: { status: "available", missingAt: null },
      links: {
        self: "/api/resources/res_sf_existing",
        content: "/api/resources/res_sf_existing/content",
      },
    });
  });

  it("marks missing resource files in metadata instead of exposing broken content links", async () => {
    const { ResourceService } = await import("../core/resource-service.js");
    const { agentsDir } = writeSessionFileSidecar({
      fileId: "sf_missing",
      fileExists: false,
    });
    const service = new ResourceService({
      agentsDir,
      sessionFiles: new SessionFileRegistry(),
      runtimeContext: { studioId: "studio_local" },
      now: () => 999,
    });

    const resource = service.getResource("res_sf_missing");

    expect(resource).toMatchObject({
      resourceId: "res_sf_missing",
      lifecycle: { status: "missing", missingAt: 999 },
      links: { self: "/api/resources/res_sf_missing" },
    });
    expect(resource.links.content).toBeUndefined();
  });

  it("signs short-lived content tickets bound to a single resource", async () => {
    const {
      issueResourceTicket,
      verifyResourceTicket,
      resourceTicketKeyPath,
    } = await import("../core/resource-ticket-service.js");
    const gsapHome = makeTmpDir("gsap-resource-ticket-");

    const issued = issueResourceTicket({
      gsapHome,
      resourceId: "res_sf_1",
      studioId: "studio_1",
      principalId: "principal_local_1",
      now: "2026-05-17T00:00:00.000Z",
      ttlMs: 60_000,
    });

    expect(issued).toMatchObject({
      resourceId: "res_sf_1",
      studioId: "studio_1",
      principalId: "principal_local_1",
      expiresAt: "2026-05-17T00:01:00.000Z",
    });
    expect(fs.existsSync(resourceTicketKeyPath(gsapHome))).toBe(true);
    expect(verifyResourceTicket({
      gsapHome,
      ticket: issued.ticket,
      resourceId: "res_sf_1",
      now: "2026-05-17T00:00:30.000Z",
    })).toMatchObject({
      resourceId: "res_sf_1",
      action: "resources.content",
    });
    expect(() => verifyResourceTicket({
      gsapHome,
      ticket: issued.ticket,
      resourceId: "res_other",
      now: "2026-05-17T00:00:30.000Z",
    })).toThrow("resource ticket resource mismatch");
  });

  it("serves resource content with range, head, non-ASCII disposition, and ticket access", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    const root = makeTmpDir();
    const filePath = path.join(root, "粘贴图片.png");
    fs.writeFileSync(filePath, "image-bytes", "utf-8");
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      gsapHome: root,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
      getResource: () => ({
        resourceId: "res_sf_image",
        studioId: "studio_1",
        type: "file",
        lifecycle: { status: "available", missingAt: null },
      }),
      resolveResourceContent: () => ({
        resourceId: "res_sf_image",
        resource: { resourceId: "res_sf_image", studioId: "studio_1" },
        filePath,
        mime: "image/png",
        size: Buffer.byteLength("image-bytes"),
        filename: "粘贴图片.png",
      }),
    }));

    const head = await app.request("/api/resources/res_sf_image/content", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength("image-bytes")));

    const range = await app.request("/api/resources/res_sf_image/content", {
      headers: { Range: "bytes=0-4" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 0-4/11");
    expect(await range.text()).toBe("image");

    const disposition = range.headers.get("content-disposition") || "";
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain("%E7%B2%98%E8%B4%B4%E5%9B%BE%E7%89%87");
    expect(Array.from(disposition).every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true);

    const ticketRes = await app.request("/api/resources/res_sf_image/ticket", { method: "POST" });
    expect(ticketRes.status).toBe(200);
    const ticketBody = await ticketRes.json();
    const contentRes = await app.request(ticketBody.contentUrl);
    expect(contentRes.status).toBe(200);
    expect(await contentRes.text()).toBe("image-bytes");

    const wrongRes = await app.request(`/api/resources/res_other/content?ticket=${encodeURIComponent(ticketBody.ticket)}`);
    expect(wrongRes.status).toBe(403);
    expect(await wrongRes.json()).toMatchObject({ error: "resource_ticket_invalid" });
  });
});
