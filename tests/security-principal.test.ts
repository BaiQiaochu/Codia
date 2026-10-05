import { describe, expect, it } from "vitest";
import {
  normalizePrincipal,
  principalSummary,
  principalOwnsLocalConnection,
  principalHasScope,
} from "../core/security-principal.ts";

describe("security principal", () => {
  it("normalizes a local owner principal with a stable principalId", () => {
    const principal = normalizePrincipal({
      kind: "local_user",
      credentialKind: "loopback_token",
      connectionKind: "local",
      trustState: "local",
      userId: "user_1",
      studioId: "studio_1",
      serverNodeId: "node_1",
      scopes: ["chat", "resources"],
    });

    expect(principal).toMatchObject({
      schemaVersion: 1,
      principalId: "principal_local_user_user_1_studio_1_node_1",
      kind: "local_user",
      userId: "user_1",
      studioId: "studio_1",
      serverNodeId: "node_1",
      credentialKind: "loopback_token",
      connectionKind: "local",
      trustState: "local",
      scopes: ["chat", "resources"],
    });
    expect(principalOwnsLocalConnection(principal)).toBe(true);
    expect(principalHasScope(principal, "settings.write")).toBe(true);
  });

  it("sanitizes summaries without leaking scopes as mutable references", () => {
    const principal = normalizePrincipal({
      kind: "device",
      deviceId: "device_1",
      credentialId: "cred_1",
      userId: "user_1",
      studioId: "studio_1",
      serverNodeId: "node_1",
      connectionKind: "lan",
      credentialKind: "device_credential",
      trustState: "paired",
      scopes: ["chat.write"],
    });
    const summary = principalSummary(principal);
    expect(summary).toMatchObject({
      principalId: principal.principalId,
      kind: "device",
      deviceId: "device_1",
      credentialId: "cred_1",
    });
    expect(summary.scopes).toBeUndefined();
    expect(() => {
      summary.kind = "local_user";
    }).toThrow();
  });

  it("checks scoped capabilities without treating remote principals as owners", () => {
    const principal = normalizePrincipal({
      kind: "device",
      deviceId: "device_1",
      userId: "user_1",
      studioId: "studio_1",
      serverNodeId: "node_1",
      connectionKind: "lan",
      credentialKind: "device_credential",
      trustState: "lan",
      scopes: ["resources.read", "chat"],
    });

    expect(principalOwnsLocalConnection(principal)).toBe(false);
    expect(principalHasScope(principal, "resources.read")).toBe(true);
    expect(principalHasScope(principal, "chat.write")).toBe(true);
    expect(principalHasScope(principal, "settings.write")).toBe(false);
  });
});
