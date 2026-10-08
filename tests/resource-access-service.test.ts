import { describe, expect, it } from "vitest";
import { ResourceAccessService } from "../core/resource-access-service.js";

function localContext() {
  return {
    studioId: "studio_1",
    authPrincipal: {
      kind: "local_user",
      principalId: "principal_local",
      connectionKind: "local",
      credentialKind: "loopback_token",
      studioId: "studio_1",
    },
  };
}

function remoteContext() {
  return {
    studioId: "studio_1",
    authPrincipal: {
      kind: "device",
      principalId: "principal_device",
      connectionKind: "lan",
      credentialKind: "device_credential",
      studioId: "studio_1",
    },
  };
}

function resourceService() {
  return {
    getResource: () => ({
      schemaVersion: 1,
      resourceId: "res_sf_1",
      studioId: "studio_1",
      filePath: "/Users/example/private.txt",
      realPath: "/private/var/private.txt",
      links: { self: "/api/resources/res_sf_1", content: "/api/resources/res_sf_1/content" },
    }),
    resolveContent: () => ({
      resourceId: "res_sf_1",
      resource: {
        schemaVersion: 1,
        resourceId: "res_sf_1",
        studioId: "studio_1",
        filePath: "/Users/example/private.txt",
        realPath: "/private/var/private.txt",
      },
      filePath: "/private/var/private.txt",
      mime: "text/plain",
      size: 10,
      filename: "private.txt",
    }),
  };
}

describe("ResourceAccessService", () => {
  it("keeps local-owner metadata compatible", () => {
    const service = new ResourceAccessService({ resourceService: resourceService() });
    expect(service.getMetadata("res_sf_1", localContext())).toMatchObject({
      resourceId: "res_sf_1",
      filePath: "/Users/example/private.txt",
      realPath: "/private/var/private.txt",
    });
  });

  it("sanitizes remote metadata without exposing local paths", () => {
    const service = new ResourceAccessService({
      resourceService: resourceService(),
      authorizeCapability: () => ({ allowed: true, reason: "allowed", capability: "resources.read" }),
    });
    const metadata = service.getMetadata("res_sf_1", remoteContext());
    expect(metadata.resourceId).toBe("res_sf_1");
    expect(metadata.filePath).toBeUndefined();
    expect(metadata.realPath).toBeUndefined();
  });

  it("denies remote content when policy denies access", () => {
    const service = new ResourceAccessService({
      resourceService: resourceService(),
      authorizeCapability: () => ({ allowed: false, reason: "missing_grant", capability: "resources.content" }),
    });
    expect(() => service.resolveContent("res_sf_1", remoteContext())).toThrow("resource content access denied");
  });

  it("keeps content compatible with existing resources.read grants", () => {
    const calls = [];
    const service = new ResourceAccessService({
      resourceService: resourceService(),
      authorizeCapability: ({ capability }) => {
        calls.push(capability);
        return { allowed: capability === "resources.read", reason: "allowed", capability };
      },
    });
    expect(service.resolveContent("res_sf_1", remoteContext())).toMatchObject({
      resourceId: "res_sf_1",
      filePath: "/private/var/private.txt",
      resource: { resourceId: "res_sf_1" },
    });
    expect(calls).toEqual(["resources.content", "resources.read"]);
  });

  it("blocks remote base64-like media events unless they are local-owner events", () => {
    const service = new ResourceAccessService({ resourceService: resourceService() });
    expect(service.classifyMediaEventPayload({
      type: "browser_status",
      thumbnail: "data:image/png;base64,xxx",
    }, remoteContext())).toMatchObject({
      allowed: false,
      reason: "remote_base64_media_event",
    });
    expect(service.classifyMediaEventPayload({
      type: "browser_status",
      thumbnail: "data:image/png;base64,xxx",
    }, localContext())).toMatchObject({ allowed: true });
  });

  it("audits resource authorization decisions without leaking local paths", () => {
    const events = [];
    const allowedService = new ResourceAccessService({
      resourceService: resourceService(),
      authorizeCapability: ({ capability }) => ({ allowed: true, reason: "allowed", capability }),
      audit: (event) => events.push(event),
    });

    allowedService.getMetadata("res_sf_1", remoteContext());

    expect(events[0]).toMatchObject({
      action: "resources.metadata",
      result: "success",
      target: { kind: "resource", studioId: "studio_1", resourceId: "res_sf_1" },
      actor: { principalId: "principal_device" },
      decision: { allowed: true, capability: "resources.read" },
    });

    const deniedService = new ResourceAccessService({
      resourceService: resourceService(),
      authorizeCapability: ({ capability }) => ({ allowed: false, reason: "missing_grant", capability }),
      audit: (event) => events.push(event),
    });

    expect(() => deniedService.resolveContent("res_sf_1", remoteContext()))
      .toThrow("resource content access denied");

    expect(events[1]).toMatchObject({
      action: "resources.content",
      result: "denied",
      target: { kind: "resource", studioId: "studio_1", resourceId: "res_sf_1" },
      actor: { principalId: "principal_device" },
      decision: { allowed: false, reason: "missing_grant" },
    });
    expect(JSON.stringify(events)).not.toContain("/Users/example/private.txt");
    expect(JSON.stringify(events)).not.toContain("/private/var/private.txt");
  });
});
