import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeSessionManager } from "../core/bridge-session-manager.ts";
import { SessionCoordinator } from "../core/session-coordinator.ts";

const tempDirs: string[] = [];

function tempAgentDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-wukong-runtime-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Wukong runtime routing", () => {
  it("routes bridge messages to Wukong when the target agent uses the Wukong runtime", async () => {
    const agentDir = tempAgentDir();
    const agent = {
      id: "agent-wk",
      agentName: "Wukong Agent",
      agentDir,
      sessionDir: path.join(agentDir, "sessions"),
      config: {
        runtime: { target: "wukong" },
        wukong: {
          gatewayUrl: "https://wukong.example.com/api",
          token: "runtime-token",
          skillId: "skill-123",
          workspaceId: "workspace-9",
        },
      },
    };
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://wukong.example.com/api/tasks/run");
      expect(init.method).toBe("POST");
      expect(init.headers.authorization).toBe("Bearer runtime-token");
      expect(JSON.parse(init.body)).toMatchObject({
        text: "from DingTalk",
        agentId: "agent-wk",
        agentName: "Wukong Agent",
        conversation: {
          sessionKey: "dt_dm_user-1@agent-wk",
          platform: "dingtalk",
          userId: "user-1",
          chatId: "user-1",
        },
        source: { subsystem: "bridge", surface: "dingtalk" },
      });
      return new Response(JSON.stringify({ taskId: "wk-bridge-1", text: "reply from Wukong" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const manager = new BridgeSessionManager({
      getAgent: () => agent,
      getAgentById: (id: string) => id === agent.id ? agent : null,
      getWukongRuntimeFetch: () => fetchImpl,
    });

    const result = await manager.executeExternalMessage(
      "from DingTalk",
      "dt_dm_user-1@agent-wk",
      { platform: "dingtalk", userId: "user-1", chatId: "user-1" },
      { agentId: "agent-wk" },
    );

    expect(result).toMatchObject({
      text: "reply from Wukong",
      externalTaskId: "wk-bridge-1",
      runtime: "wukong",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("routes isolated workflow and subagent execution to Wukong for Wukong runtime agents", async () => {
    const agent = {
      id: "agent-wk",
      agentName: "Wukong Agent",
      config: {
        runtime: { target: "wukong" },
        wukong: {
          gatewayUrl: "https://wukong.example.com",
          token: "runtime-token",
          skillId: "skill-123",
        },
      },
    };
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://wukong.example.com/tasks/run");
      expect(JSON.parse(init.body)).toMatchObject({
        text: "workflow node task",
        agentId: "agent-wk",
        source: { subsystem: "workflow", surface: "isolated" },
      });
      return new Response(JSON.stringify({ output: "workflow result from Wukong" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const coordinator = new SessionCoordinator({
      getAgent: () => agent,
      getAgentById: (id: string) => id === agent.id ? agent : null,
      getActiveAgentId: () => agent.id,
      getWukongRuntimeFetch: () => fetchImpl,
    });

    const result = await coordinator.executeIsolated("workflow node task", {
      agentId: "agent-wk",
      workflowContext: true,
    });

    expect(result).toMatchObject({
      sessionPath: null,
      replyText: "workflow result from Wukong",
      error: null,
      runtime: "wukong",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
