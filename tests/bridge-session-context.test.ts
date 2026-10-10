import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeSessionManager } from "../core/bridge-session-manager.js";

describe("BridgeSessionManager bridge context lookup", () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function makeManager() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-bridge-context-"));
    const agent = {
      id: "agent-a",
      sessionDir: path.join(tempRoot, "sessions"),
    };
    fs.mkdirSync(path.join(agent.sessionDir, "bridge"), { recursive: true });
    const manager = new BridgeSessionManager({
      getAgent: () => agent,
      getAgentById: () => agent,
      getAgents: () => [agent],
    });
    return { manager, agent };
  }

  it("resolves owner bridge context from the bridge index", () => {
    const { manager, agent } = makeManager();
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "wechat.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    manager.writeIndex({
      "wx_dm_wx-user@agent-a": {
        file: "owner/wechat.jsonl",
        userId: "wx-user",
        chatId: "wx-user",
      },
    }, agent);

    expect(manager.getBridgeContextForSessionPath(sessionFile, { agentId: "agent-a" })).toMatchObject({
      isBridgeSession: true,
      platform: "wechat",
      chatType: "dm",
      role: "owner",
      notificationHint: {
        channels: ["bridge_owner"],
        bridgePlatforms: ["wechat"],
        contextPolicy: "record_when_delivered",
      },
    });
  });

  it("infers guest bridge context from a guest session file location", () => {
    const { manager, agent } = makeManager();
    const sessionFile = path.join(agent.sessionDir, "bridge", "guests", "telegram.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    manager.writeIndex({
      "tg_group_g1@agent-a": {
        file: "guests/telegram.jsonl",
        userId: "guest-user",
        chatId: "g1",
      },
    }, agent);

    expect(manager.getBridgeContextForSessionPath(sessionFile, { agentId: "agent-a" })).toMatchObject({
      isBridgeSession: true,
      platform: "telegram",
      chatType: "group",
      role: "guest",
      notificationHint: null,
    });
  });
});
