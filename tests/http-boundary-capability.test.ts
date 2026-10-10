import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizePrincipal } from "../core/security-principal.js";

describe("HTTP request capability boundary", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("authorizes remote principals through persisted grants", async () => {
    const { createGrant } = await import("../core/grant-registry.js");
    const { createRequestContext } = await import("../server/http/boundary.js");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-http-boundary-"));
    const principal = normalizePrincipal({
      kind: "device",
      userId: "user_1",
      studioId: "studio_1",
      serverNodeId: "node_1",
      deviceId: "phone",
      connectionKind: "lan",
      credentialKind: "device_credential",
      trustState: "lan",
    });
    createGrant(tmpDir, {
      principalId: principal.principalId,
      subjectKind: "device",
      scope: { studioId: "studio_1", mountId: "default" },
      capabilities: ["files.read"],
      constraints: { transportKinds: ["lan"] },
      now: "2026-05-17T00:00:00.000Z",
    });

    const context = createRequestContext({
      req: { method: "GET", url: "http://codia.local/api/mobile/workbench/files" },
      get: (key) => key === "authPrincipal" ? principal : null,
    }, {
      codiaHome: tmpDir,
      getRuntimeContext: () => ({ studioId: "studio_1", serverNodeId: "node_1" }),
    });

    expect(context.authorize("files.read", {
      kind: "mount",
      mountId: "default",
    })).toMatchObject({ allowed: true, reason: "allowed" });
    expect(context.authorize("files.write", {
      kind: "mount",
      mountId: "default",
    })).toMatchObject({ allowed: false, reason: "insufficient_capability" });
  });

  it("expands scoped PWA principals into implicit read/write grants", async () => {
    const { createRequestContext } = await import("../server/http/boundary.js");
    const principal = normalizePrincipal({
      kind: "device",
      userId: "user_1",
      studioId: "studio_1",
      serverNodeId: "node_1",
      deviceId: "phone",
      connectionKind: "lan",
      credentialKind: "device_credential",
      trustState: "lan",
      scopes: ["files"],
    });

    const context = createRequestContext({
      req: { method: "GET", url: "http://codia.local/api/mobile/workbench/files" },
      get: (key) => key === "authPrincipal" ? principal : null,
    }, {
      codiaHome: null,
      getRuntimeContext: () => ({ studioId: "studio_1", serverNodeId: "node_1" }),
    });

    expect(context.authorize("files.write", {
      kind: "mount",
      mountId: "default",
    })).toMatchObject({ allowed: true, reason: "allowed" });
  });
});
