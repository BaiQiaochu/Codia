// @ts-nocheck
import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-server-runtime-context-"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeValidIdentity(root) {
  writeJson(path.join(root, "server-node.json"), {
    schemaVersion: 1,
    serverId: "server_runtime",
    label: "Runtime Server",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  writeJson(path.join(root, "users.json"), {
    schemaVersion: 1,
    defaultUserId: "user_runtime",
    users: [{
      userId: "user_runtime",
      kind: "legacy_owner",
      displayName: "Runtime User",
      profileSource: "legacy_user_profile",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  writeJson(path.join(root, "spaces.json"), {
    schemaVersion: 1,
    defaultSpaceId: "space_runtime",
    spaces: [{
      spaceId: "space_runtime",
      ownerUserId: "user_runtime",
      label: "Runtime Space",
      kind: "personal",
      storage: { provider: "legacy_gsap_home", legacyRoot: true },
      membershipModel: "single_user_implicit",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
}

describe("server runtime context", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("creates a frozen local runtime context from stable identity registries", async () => {
    tmpDir = makeTmpDir();
    writeValidIdentity(tmpDir);
    const { createServerRuntimeContext } = await import("../core/server-runtime-context.js");

    const context = createServerRuntimeContext({ gsapHome: tmpDir, appVersion: "2.3.4" });

    expect(context).toEqual({
      schemaVersion: 1,
      serverId: "server_runtime",
      serverNodeId: "server_runtime",
      serverNodeKind: "local",
      serverNodeTransport: "loopback",
      userId: "user_runtime",
      spaceId: "space_runtime",
      studioId: "space_runtime",
      label: "Runtime Server",
      userLabel: "Runtime User",
      spaceLabel: "Runtime Space",
      studioLabel: "Runtime Space",
      userKind: "legacy_owner",
      spaceKind: "personal",
      studioKind: "personal",
      membershipModel: "single_user_implicit",
      storage: { provider: "legacy_gsap_home", legacyRoot: true },
      connectionKind: "local",
      authState: "paired",
      trustState: "local",
      credentialKind: "loopback_token",
      platformAccountId: null,
      officialServiceKind: null,
      executionBoundary: {
        schemaVersion: 1,
        boundaryId: "execb_server_runtime_space_runtime",
        kind: "local_process",
        serverNodeId: "server_runtime",
        studioId: "space_runtime",
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
      appVersion: "2.3.4",
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.storage)).toBe(true);
    expect(Object.isFrozen(context.executionBoundary)).toBe(true);
  });

  it("fails explicitly when identity registries are invalid", async () => {
    tmpDir = makeTmpDir();
    writeValidIdentity(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "users.json"), "{ bad json", "utf-8");
    const { createServerRuntimeContext } = await import("../core/server-runtime-context.js");

    expect(() => createServerRuntimeContext({ gsapHome: tmpDir }))
      .toThrow("invalid users.json");
  });
});
