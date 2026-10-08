import { describe, expect, it } from "vitest";
import { normalizePrincipal } from "../core/security-principal.js";

function devicePrincipal(overrides = {}) {
  return normalizePrincipal({
    kind: "device",
    userId: "user_1",
    studioId: "studio_1",
    serverNodeId: "node_1",
    deviceId: "device_1",
    connectionKind: "lan",
    credentialKind: "device_credential",
    trustState: "lan",
    scopes: ["chat"],
    ...overrides,
  });
}

function grant(overrides = {}) {
  return {
    schemaVersion: 1,
    grantId: "grant_1",
    principalId: devicePrincipal().principalId,
    subjectKind: "device",
    scope: { studioId: "studio_1" },
    capabilities: ["chat.read", "resources.read"],
    constraints: { transportKinds: ["lan"] },
    status: "active",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("capability policy", () => {
  it("allows the local owner without a grant", async () => {
    const { authorizeCapability } = await import("../core/capability-policy.js");

    const decision = authorizeCapability({
      principal: normalizePrincipal({
        kind: "local_user",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
        trustState: "local",
      }),
      capability: "settings.write",
      target: { kind: "settings", studioId: "studio_1" },
      connectionKind: "local",
    });

    expect(decision).toMatchObject({ allowed: true, reason: "local_owner" });
  });

  it("requires active grants for remote principals", async () => {
    const { authorizeCapability } = await import("../core/capability-policy.js");

    expect(authorizeCapability({
      principal: devicePrincipal(),
      grants: [],
      capability: "chat.read",
      target: { kind: "session", studioId: "studio_1", sessionPath: "/s/a.jsonl" },
      connectionKind: "lan",
    })).toMatchObject({ allowed: false, reason: "missing_grant" });

    expect(authorizeCapability({
      principal: devicePrincipal(),
      grants: [grant()],
      capability: "resources.read",
      target: { kind: "resource", studioId: "studio_1", resourceId: "res_1" },
      connectionKind: "lan",
    })).toMatchObject({ allowed: true, reason: "allowed", grantId: "grant_1" });
  });

  it("denies studio and transport mismatches", async () => {
    const { authorizeCapability } = await import("../core/capability-policy.js");

    expect(authorizeCapability({
      principal: devicePrincipal(),
      grants: [grant()],
      capability: "chat.read",
      target: { kind: "session", studioId: "studio_2", sessionPath: "/s/a.jsonl" },
      connectionKind: "lan",
    })).toMatchObject({ allowed: false, reason: "insufficient_capability" });

    expect(authorizeCapability({
      principal: devicePrincipal({ connectionKind: "custom_remote" }),
      grants: [grant()],
      capability: "chat.read",
      target: { kind: "session", studioId: "studio_1", sessionPath: "/s/a.jsonl" },
      connectionKind: "custom_remote",
    })).toMatchObject({ allowed: false, reason: "transport_not_allowed" });
  });

  it("summarizes decisions without exposing mutable grant state", async () => {
    const { authorizeCapability, capabilityDecisionSummary } = await import("../core/capability-policy.js");
    const decision = authorizeCapability({
      principal: devicePrincipal(),
      grants: [grant()],
      capability: "resources.read",
      target: { kind: "resource", studioId: "studio_1", resourceId: "res_1" },
      connectionKind: "lan",
    });

    expect(capabilityDecisionSummary(decision)).toMatchObject({
      allowed: true,
      reason: "allowed",
      capability: "resources.read",
      principalId: devicePrincipal().principalId,
      grantId: "grant_1",
    });
  });
});
