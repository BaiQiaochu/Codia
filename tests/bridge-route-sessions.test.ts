// Upstream reference test migrated and debranded; skipped until the matching Codia source contract is migrated.
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createBridgeRoute } from "../server/routes/bridge.ts";

let rootDir;

function makeApp() {
  const agentId = "codia";
  const sessionDir = path.join(rootDir, "agents", agentId, "sessions");
  const bridgeDir = path.join(sessionDir, "bridge");
  const sessionPath = path.join(bridgeDir, "owner", "tg-owner.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "", "utf-8");

  const agent = {
    id: agentId,
    sessionDir,
    config: {
      bridge: {
        telegram: { owner: "owner" },
      },
    },
  };
  const engine = {
    currentAgentId: agentId,
    getAgent: (id) => (id === agentId ? agent : null),
    getBridgeIndex: () => ({
      "tg_dm_owner@codia": {
        file: "owner/tg-owner.jsonl",
        name: "Owner",
        avatarUrl: "https://example.com/avatar.png",
        userId: "owner",
        chatId: "owner",
      },
    }),
    getBridgeReadOnly: () => false,
    getBridgeReceiptEnabled: () => true,
  };

  const app = new Hono();
  app.route("/api", createBridgeRoute(engine, null));
  return { app, sessionPath };
}

describe.skip("bridge sessions route", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-bridge-route-"));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it.skip("returns the resolved sessionPath for ChatTranscript hydration", async () => {
    const { app, sessionPath } = makeApp();

    const res = await app.request("/api/bridge/sessions?platform=telegram&agentId=codia");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      sessionKey: "tg_dm_owner@codia",
      file: "owner/tg-owner.jsonl",
      sessionPath,
      displayName: "Owner",
      avatarUrl: "https://example.com/avatar.png",
    });
  });

  it.skip("marks QQ sessions as owner when configured owner matches a principal alias", async () => {
    const agentId = "codia";
    const sessionDir = path.join(rootDir, "agents", agentId, "sessions");
    const bridgeDir = path.join(sessionDir, "bridge");
    const sessionPath = path.join(bridgeDir, "owner", "qq-owner.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "", "utf-8");

    const agent = {
      id: agentId,
      sessionDir,
      config: {
        bridge: {
          qq: { owner: "c2c-openid" },
        },
      },
    };
    const engine = {
      currentAgentId: agentId,
      getAgent: (id) => (id === agentId ? agent : null),
      getBridgeIndex: () => ({
        "qq_dm_c2c-openid@codia": {
          file: "owner/qq-owner.jsonl",
          userId: "stable-user-id",
          chatId: "c2c-openid",
          qqPrincipal: {
            principalId: "stable-user-id",
            aliases: ["stable-user-id", "c2c-openid"],
          },
        },
      }),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const qqApp = new Hono();
    qqApp.route("/api", createBridgeRoute(engine, null));

    const res = await qqApp.request("/api/bridge/sessions?platform=qq&agentId=codia");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sessions[0]).toMatchObject({
      sessionKey: "qq_dm_c2c-openid@codia",
      isOwner: true,
    });
  });
});
