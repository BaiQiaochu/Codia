import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-server-identity-route-"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeValidIdentity(root) {
  writeJson(path.join(root, "server-node.json"), {
    schemaVersion: 1,
    serverId: "server_route",
    label: "Route Server",
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  });
  writeJson(path.join(root, "users.json"), {
    schemaVersion: 1,
    defaultUserId: "user_route",
    users: [{
      userId: "user_route",
      kind: "legacy_owner",
      displayName: "Route User",
      profileSource: "legacy_user_profile",
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    }],
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  });
  writeJson(path.join(root, "spaces.json"), {
    schemaVersion: 1,
    defaultSpaceId: "space_route",
    spaces: [{
      spaceId: "space_route",
      ownerUserId: "user_route",
      label: "Route Space",
      kind: "personal",
      storage: { provider: "legacy_gsap_home", legacyRoot: true },
      membershipModel: "single_user_implicit",
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    }],
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  });
}

describe("server identity route", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("returns local G-SAP server identity metadata for the active legacy Space", async () => {
    tmpDir = makeTmpDir();
    writeValidIdentity(tmpDir);
    const { createServerIdentityRoute } = await import("../server/routes/server-identity.js");
    const app = new Hono();
    app.route("/api", createServerIdentityRoute({ gsapHome: tmpDir, appVersion: "1.2.3" }));

    const res = await app.request("/api/server/identity");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connectionKind: "local",
      serverId: "server_route",
      serverNodeId: "server_route",
      serverNodeKind: "local",
      serverNodeTransport: "loopback",
      userId: "user_route",
      spaceId: "space_route",
      studioId: "space_route",
      label: "Route Server",
      userLabel: "Route User",
      spaceLabel: "Route Space",
      studioLabel: "Route Space",
      trustState: "local",
      authState: "paired",
      credentialKind: "loopback_token",
      platformAccountId: null,
      officialServiceKind: null,
      executionBoundary: {
        schemaVersion: 1,
        boundaryId: "execb_server_route_space_route",
        kind: "local_process",
        serverNodeId: "server_route",
        studioId: "space_route",
        workbench: {
          kind: "legacy_agent_workbench",
          root: null,
        },
        sandbox: {
          kind: "legacy_session_permission",
          enforcedBy: "existing_runtime",
        },
        filesystem: {
          policy: "legacy_workbench_scope",
        },
        network: {
          policy: "local_runtime_default",
        },
      },
      capabilities: ["chat", "resources", "files", "tools"],
      version: "1.2.3",
    });
  });

  it("returns an explicit error when registry files are invalid", async () => {
    tmpDir = makeTmpDir();
    writeValidIdentity(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "spaces.json"), "{ bad json", "utf-8");
    const { createServerIdentityRoute } = await import("../server/routes/server-identity.js");
    const app = new Hono();
    app.route("/api", createServerIdentityRoute({ gsapHome: tmpDir, appVersion: "1.2.3" }));

    const res = await app.request("/api/server/identity");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "invalid server identity registry",
      detail: expect.stringContaining("invalid spaces.json"),
    });
  });
});
