// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

describe("resources route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeFile() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resources-route-"));
    const filePath = path.join(tmpDir, "asset.txt");
    fs.writeFileSync(filePath, "hello resources\n", "utf-8");
    return filePath;
  }

  function makeMissingSessionFileSidecar({ fileId = "sf_route_missing" } = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resources-route-"));
    const agentsDir = path.join(tmpDir, "agents");
    const sessionPath = path.join(agentsDir, "gsap", "sessions", "main.jsonl");
    const filePath = path.join(tmpDir, "workspace", "missing.txt");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");
    fs.writeFileSync(`${sessionPath}.files.json`, JSON.stringify({
      version: 1,
      sessionPath,
      files: {
        [fileId]: {
          id: fileId,
          sessionPath,
          filePath,
          realPath: filePath,
          displayName: "Missing",
          filename: "missing.txt",
          mime: "text/plain",
          size: 12,
          kind: "document",
          isDirectory: false,
          storageKind: "external",
          status: "available",
          missingAt: null,
        },
      },
      refs: [],
      createdAt: 1,
      updatedAt: 1,
    }), "utf-8");
    return { agentsDir, fileId };
  }

  it("returns resource metadata from the engine resource service", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      getResource: () => ({
        schemaVersion: 1,
        resourceId: "res_sf_route",
        name: "studios/studio_route/resources/res_sf_route",
        studioId: "studio_route",
        type: "file",
        source: "session_file",
        fileId: "sf_route",
        displayName: "route.txt",
        lifecycle: { status: "available", missingAt: null },
        links: {
          self: "/api/resources/res_sf_route",
          content: "/api/resources/res_sf_route/content",
        },
      }),
    }));

    const res = await app.request("/api/resources/res_sf_route");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resourceId: "res_sf_route",
      name: "studios/studio_route/resources/res_sf_route",
      fileId: "sf_route",
    });
  });

  it("passes request context into the resource service", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    let seenContext = null;
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      getRuntimeContext: () => ({
        serverId: "server_ctx",
        serverNodeId: "node_ctx",
        userId: "user_ctx",
        studioId: "studio_ctx",
        connectionKind: "local",
        credentialKind: "loopback_token",
        platformAccountId: null,
        officialServiceKind: null,
        executionBoundary: {
          schemaVersion: 1,
          boundaryId: "execb_node_ctx_studio_ctx",
          kind: "local_process",
          serverNodeId: "node_ctx",
          studioId: "studio_ctx",
        },
      }),
      getResource: (_resourceId, options = {}) => {
        seenContext = options.requestContext;
        return {
          schemaVersion: 1,
          resourceId: "res_sf_ctx",
          name: "studios/studio_ctx/resources/res_sf_ctx",
          studioId: "studio_ctx",
          type: "file",
          source: "session_file",
          fileId: "sf_ctx",
          displayName: "ctx.txt",
          lifecycle: { status: "available", missingAt: null },
          links: {
            self: "/api/resources/res_sf_ctx",
            content: "/api/resources/res_sf_ctx/content",
          },
        };
      },
    }));

    const res = await app.request("/api/resources/res_sf_ctx");

    expect(res.status).toBe(200);
    expect(seenContext).toMatchObject({
      serverId: "server_ctx",
      serverNodeId: "node_ctx",
      userId: "user_ctx",
      studioId: "studio_ctx",
      connectionKind: "local",
      credentialKind: "loopback_token",
      executionBoundary: {
        boundaryId: "execb_node_ctx_studio_ctx",
        kind: "local_process",
        serverNodeId: "node_ctx",
      },
      authPrincipal: {
        kind: "local_user",
        userId: "user_ctx",
        serverNodeId: "node_ctx",
        credentialKind: "loopback_token",
      },
    });
    expect(seenContext.request.method).toBe("GET");
  });

  it("fails explicitly when request context cannot be created", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      getRuntimeContext: () => {
        throw new Error("identity context not initialized");
      },
      getResource: () => {
        throw new Error("should not be called");
      },
    }));

    const res = await app.request("/api/resources/res_sf_no_context");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "resource_error",
      detail: "identity context not initialized",
    });
  });

  it("returns reconciled missing metadata through the real resource service", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    const { ResourceService } = await import("../core/resource-service.js");
    const { SessionFileRegistry } = await import("../lib/session-files/session-file-registry.js");
    const { agentsDir, fileId } = makeMissingSessionFileSidecar();
    const service = new ResourceService({
      agentsDir,
      sessionFiles: new SessionFileRegistry(),
      runtimeContext: { studioId: "studio_route" },
      now: () => 999,
    });
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      getRuntimeContext: () => ({
        serverId: "server_route",
        userId: "user_route",
        studioId: "studio_route",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
      resources: service,
    }));

    const res = await app.request(`/api/resources/res_${fileId}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resourceId: `res_${fileId}`,
      studioId: "studio_route",
      lifecycle: { status: "missing", missingAt: 999 },
      links: { self: `/api/resources/res_${fileId}` },
    });
  });

  it("streams local resource content and supports HEAD metadata", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    const filePath = makeFile();
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      resolveResourceContent: () => ({
        resourceId: "res_sf_content",
        filePath,
        mime: "text/plain",
        size: Buffer.byteLength("hello resources\n"),
        filename: "asset.txt",
      }),
    }));

    const head = await app.request("/api/resources/res_sf_content/content", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/plain");
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength("hello resources\n")));

    const res = await app.request("/api/resources/res_sf_content/content");
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("hello resources\n");
  });

  it("serves local content whose filename contains non-ASCII characters", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resources-route-"));
    const filePath = path.join(tmpDir, "粘贴图片_mp0qkfvq_eb2b8042.png");
    fs.writeFileSync(filePath, "png-bytes", "utf-8");
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      resolveResourceContent: () => ({
        resourceId: "res_sf_cjk",
        filePath,
        mime: "image/png",
        size: Buffer.byteLength("png-bytes"),
        filename: "粘贴图片_mp0qkfvq_eb2b8042.png",
      }),
    }));

    const res = await app.request("/api/resources/res_sf_cjk/content");

    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition") || "";
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain("%E7%B2%98%E8%B4%B4%E5%9B%BE%E7%89%87");
    expect(Array.from(disposition).every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true);
    expect(await res.text()).toBe("png-bytes");
  });

  it("serves a byte range for local resource content", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    const filePath = makeFile();
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      resolveResourceContent: () => ({
        resourceId: "res_sf_range",
        filePath,
        mime: "text/plain",
        size: Buffer.byteLength("hello resources\n"),
        filename: "asset.txt",
      }),
    }));

    const res = await app.request("/api/resources/res_sf_range/content", {
      headers: { Range: "bytes=6-14" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 6-14/16");
    expect(await res.text()).toBe("resources");
  });

  it("issues a short-lived content ticket and serves content without auth context when ticket is valid", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resources-ticket-"));
    const filePath = path.join(tmpDir, "asset.txt");
    fs.writeFileSync(filePath, "ticket content", "utf-8");
    const app = new Hono();
    app.use("/api/resources/*", async (c, next) => {
      if (c.req.path.endsWith("/ticket")) {
        c.set("authPrincipal", Object.freeze({
          kind: "device",
          credentialKind: "device_credential",
          connectionKind: "lan",
          trustState: "paired",
          userId: "user_1",
          studioId: "studio_1",
          serverNodeId: "node_1",
          deviceId: "device_1",
          scopes: ["resources.content"],
        }));
      }
      await next();
    });
    app.route("/api", createResourcesRoute({
      gsapHome: tmpDir,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
      }),
      resolveResourceContent: () => ({
        resourceId: "res_ticket",
        resource: { resourceId: "res_ticket", studioId: "studio_1" },
        filePath,
        mime: "text/plain",
        size: Buffer.byteLength("ticket content"),
        filename: "asset.txt",
      }),
    }));

    const ticketRes = await app.request("/api/resources/res_ticket/ticket", { method: "POST" });
    expect(ticketRes.status).toBe(200);
    const ticketBody = await ticketRes.json();
    expect(ticketBody).toMatchObject({
      resourceId: "res_ticket",
      contentUrl: expect.stringContaining("/api/resources/res_ticket/content?ticket="),
      expiresAt: expect.any(String),
    });

    const contentRes = await app.request(ticketBody.contentUrl);
    expect(contentRes.status).toBe(200);
    expect(await contentRes.text()).toBe("ticket content");

    const wrongRes = await app.request(`/api/resources/res_other/content?ticket=${encodeURIComponent(ticketBody.ticket)}`);
    expect(wrongRes.status).toBe(403);
    expect(await wrongRes.json()).toMatchObject({ error: "resource_ticket_invalid" });
  });
});
