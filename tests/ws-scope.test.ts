// @ts-nocheck
import { describe, expect, it } from "vitest";

describe("websocket scope filtering", () => {
  it("allows local owner to receive legacy global events and send prompts", async () => {
    const {
      createWsClientRecord,
      wsClientCanReceiveEvent,
      wsClientCanSendMessage,
    } = await import("../server/ws-scope.js");

    const client = createWsClientRecord({
      principal: {
        kind: "local_user",
        credentialKind: "loopback_token",
        connectionKind: "local",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
      },
    });

    expect(wsClientCanReceiveEvent(client, { type: "plugin_ui_changed" })).toBe(true);
    expect(wsClientCanSendMessage(client, { type: "prompt", sessionPath: "/s/a.jsonl" })).toBe(true);
  });

  it("denies remote session events outside the subscribed session", async () => {
    const {
      createWsClientRecord,
      wsClientCanReceiveEvent,
    } = await import("../server/ws-scope.js");

    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
      subscriptions: [{ kind: "session", studioId: "studio_1", sessionPath: "/s/a.jsonl" }],
    });

    expect(wsClientCanReceiveEvent(client, {
      type: "message",
      studioId: "studio_1",
      sessionPath: "/s/b.jsonl",
    })).toBe(false);
    expect(wsClientCanReceiveEvent(client, {
      type: "message",
      studioId: "studio_1",
      sessionPath: "/s/a.jsonl",
    })).toBe(true);
  });

  it("blocks remote base64 media and unknown global events", async () => {
    const {
      createWsClientRecord,
      wsClientCanReceiveEvent,
    } = await import("../server/ws-scope.js");

    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat"],
      },
      subscriptions: [{ kind: "studio", studioId: "studio_1" }],
    });

    expect(wsClientCanReceiveEvent(client, {
      type: "browser_status",
      studioId: "studio_1",
      sessionPath: "/s/a.jsonl",
      thumbnail: "data:image/png;base64,xxx",
    })).toBe(false);
    expect(wsClientCanReceiveEvent(client, { type: "plugin_ui_changed" })).toBe(false);
  });

  it("denies remote session events without explicit studioId", async () => {
    const {
      createWsClientRecord,
      wsClientCanReceiveEvent,
    } = await import("../server/ws-scope.js");

    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
      subscriptions: [{ kind: "studio", studioId: "studio_1" }],
    });

    expect(wsClientCanReceiveEvent(client, {
      type: "message",
      sessionPath: "/s/a.jsonl",
    })).toBe(false);

    const owner = createWsClientRecord({
      principal: {
        kind: "local_user",
        credentialKind: "loopback_token",
        connectionKind: "local",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
      },
    });

    expect(wsClientCanReceiveEvent(owner, {
      type: "message",
      sessionPath: "/s/a.jsonl",
    })).toBe(true);
  });
});
