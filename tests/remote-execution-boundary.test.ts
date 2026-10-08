import { describe, expect, it } from "vitest";

describe("remote execution boundary", () => {
  it("validates a Studio link to a local execution node", async () => {
    const { validateServerNodeLink } = await import("../core/remote-execution-boundary.js");

    expect(validateServerNodeLink({
      schemaVersion: 1,
      linkId: "link_home_node",
      studioId: "studio_cloud",
      serverNodeId: "node_home",
      nodeRole: "execution_node",
      transportKind: "relay",
      capabilities: ["resources.read", "execution.command", "resources.read"],
      status: "active",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    })).toMatchObject({
      studioId: "studio_cloud",
      serverNodeId: "node_home",
      capabilities: ["resources.read", "execution.command"],
    });
  });

  it("rejects unknown server node capabilities", async () => {
    const { validateServerNodeLink } = await import("../core/remote-execution-boundary.js");

    expect(() => validateServerNodeLink({
      schemaVersion: 1,
      linkId: "link_bad",
      studioId: "studio_cloud",
      serverNodeId: "node_home",
      nodeRole: "execution_node",
      transportKind: "relay",
      capabilities: ["resources.read", "shell.root"],
      status: "active",
    })).toThrow("unknown server node capability: shell.root");
  });

  it("validates leases and requires backup policy for write-capable leases", async () => {
    const { validateExecutionLease } = await import("../core/remote-execution-boundary.js");

    expect(validateExecutionLease({
      schemaVersion: 1,
      leaseId: "lease_read",
      studioId: "studio_cloud",
      targetServerNodeId: "node_home",
      agentId: "agent_writer",
      sessionId: "session_1",
      actorPrincipalId: "device_phone",
      commandClass: "read_only",
      sandboxProfile: "read_only",
      backupPolicy: "none",
      expiresAt: "2026-05-16T00:05:00.000Z",
      createdAt: "2026-05-16T00:00:00.000Z",
    }, { now: "2026-05-16T00:01:00.000Z" })).toMatchObject({
      leaseId: "lease_read",
      commandClass: "read_only",
    });

    expect(() => validateExecutionLease({
      schemaVersion: 1,
      leaseId: "lease_write",
      studioId: "studio_cloud",
      targetServerNodeId: "node_home",
      agentId: "agent_writer",
      sessionId: "session_1",
      actorPrincipalId: "device_phone",
      commandClass: "write_files",
      sandboxProfile: "workspace_write",
      backupPolicy: "none",
      expiresAt: "2026-05-16T00:05:00.000Z",
      createdAt: "2026-05-16T00:00:00.000Z",
    }, { now: "2026-05-16T00:01:00.000Z" })).toThrow("write-capable execution lease requires backup policy");
  });
});
