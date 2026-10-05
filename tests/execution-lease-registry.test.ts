// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

function baseLease(overrides = {}) {
  return {
    schemaVersion: 1,
    leaseId: overrides.leaseId || "lease_read",
    studioId: "studio_1",
    targetServerNodeId: "node_1",
    agentId: "agent_1",
    sessionId: "session_1",
    actorPrincipalId: "principal_device_1",
    capabilityDecisionId: "decision_1",
    commandClass: "read_only",
    sandboxProfile: "read_only",
    backupPolicy: "none",
    expiresAt: "2026-05-16T00:05:00.000Z",
    createdAt: "2026-05-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("execution lease registry", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("creates an empty registry and consumes an issued lease", async () => {
    const {
      ensureExecutionLeaseRegistry,
      issueExecutionLease,
      consumeExecutionLease,
    } = await import("../core/execution-lease-registry.js");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-leases-"));

    expect(ensureExecutionLeaseRegistry(tmpDir)).toMatchObject({ schemaVersion: 1, leases: [] });
    const issued = issueExecutionLease(tmpDir, baseLease(), {
      now: "2026-05-16T00:01:00.000Z",
    });
    expect(issued).toMatchObject({ leaseId: "lease_read", status: "issued" });
    expect(consumeExecutionLease(tmpDir, "lease_read", {
      now: "2026-05-16T00:02:00.000Z",
    })).toMatchObject({ leaseId: "lease_read", status: "consumed" });
    expect(() => consumeExecutionLease(tmpDir, "lease_read", {
      now: "2026-05-16T00:03:00.000Z",
    })).toThrow("execution lease is consumed");
  });

  it("rejects unsafe, expired, and revoked leases", async () => {
    const {
      issueExecutionLease,
      consumeExecutionLease,
      revokeExecutionLease,
    } = await import("../core/execution-lease-registry.js");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-leases-"));

    expect(() => issueExecutionLease(tmpDir, baseLease({
      leaseId: "lease_write",
      commandClass: "write_files",
      sandboxProfile: "workspace_write",
      backupPolicy: "none",
    }), { now: "2026-05-16T00:01:00.000Z" })).toThrow("write-capable execution lease requires backup policy");

    issueExecutionLease(tmpDir, baseLease({
      leaseId: "lease_short",
      expiresAt: "2026-05-16T00:01:30.000Z",
    }), { now: "2026-05-16T00:01:00.000Z" });
    expect(() => consumeExecutionLease(tmpDir, "lease_short", {
      now: "2026-05-16T00:02:00.000Z",
    })).toThrow("execution lease expired");

    issueExecutionLease(tmpDir, baseLease({ leaseId: "lease_revoke" }), {
      now: "2026-05-16T00:01:00.000Z",
    });
    revokeExecutionLease(tmpDir, "lease_revoke", { now: "2026-05-16T00:01:10.000Z" });
    expect(() => consumeExecutionLease(tmpDir, "lease_revoke", {
      now: "2026-05-16T00:01:20.000Z",
    })).toThrow("execution lease is revoked");
  });
});
