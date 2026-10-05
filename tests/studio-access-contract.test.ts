import { describe, expect, it } from "vitest";

import {
  deriveStudioAccessGrant,
  getStudioConnectionProfile,
  STUDIO_ACCESS_CAPABILITIES,
} from "../shared/studio-access-contract.ts";

describe("studio access contract", () => {
  it("grants full capabilities for loopback local connections", () => {
    const grant = deriveStudioAccessGrant({
      connectionId: "conn_local",
      kind: "local",
      serverId: "server_1",
      userId: "user_1",
      studioId: "studio_1",
      baseUrl: "http://127.0.0.1:14500",
      wsUrl: "ws://localhost:14500/ws",
      token: "token",
      authState: "authenticated",
      trustState: "local",
      credentialKind: "loopback_token",
      capabilities: [],
    });

    expect(grant).toMatchObject({
      grantId: "access:conn_local:studio_1",
      actorKind: "local_user",
      transport: "loopback",
      dataOwner: "user_server",
      localOnly: true,
    });
    expect(grant.capabilities).toEqual([...STUDIO_ACCESS_CAPABILITIES]);
  });

  it("narrows remote grants to requested capability groups", () => {
    const grant = deriveStudioAccessGrant({
      connectionId: "conn_lan",
      kind: "lan",
      serverId: "server_1",
      userId: "user_1",
      studioId: "studio_1",
      baseUrl: "http://192.168.1.20:14500",
      wsUrl: "ws://192.168.1.20:14500/ws",
      token: "token",
      authState: "authenticated",
      trustState: "lan",
      credentialKind: "device_credential",
      capabilities: ["chat", "resources", "files.read"],
    });

    expect(grant.actorKind).toBe("device");
    expect(grant.localOnly).toBe(false);
    expect(grant.capabilities).toEqual(["chat", "resources.read", "files.read"]);
  });

  it("keeps cloud ownership branded to G-SAP and validates platform accounts", () => {
    expect(getStudioConnectionProfile("cloud")).toMatchObject({
      dataOwner: "gsap_cloud_studio",
      officialServiceKind: "cloud_studio",
      requiresPlatformAccount: true,
    });

    expect(() => deriveStudioAccessGrant({
      connectionId: "conn_cloud",
      kind: "cloud",
      serverId: "server_1",
      studioId: "studio_1",
      baseUrl: "https://cloud.example",
      wsUrl: "wss://cloud.example/ws",
      token: "token",
      authState: "authenticated",
      trustState: "cloud",
      credentialKind: "user_session",
      officialServiceKind: "cloud_studio",
      capabilities: ["chat"],
    })).toThrow("platformAccountId");
  });
});
