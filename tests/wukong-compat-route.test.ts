import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { createWukongRoute } from "../server/routes/wukong.ts";

function createApp(engine: any) {
  const app = new Hono();
  app.route("/api", createWukongRoute(engine));
  return app;
}

describe("Wukong compatibility route", () => {
  it("exposes an external-runtime compatibility manifest without registering a native bridge platform", async () => {
    const app = createApp({
      currentAgentId: "codia",
      getAgent: vi.fn(() => ({ id: "codia", agentName: "Codia" })),
    });

    const res = await app.request("/api/wukong/capabilities");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      platform: "wukong",
      runtime: {
        nativeExecution: false,
        mode: "external_runtime_gateway",
      },
      integrationModes: expect.arrayContaining(["mcp_service", "skill_gateway", "dingtalk_bridge_relay"]),
      hostRequirements: expect.arrayContaining(["stable_user_identity", "async_task_result_callback"]),
      bridge: {
        nativeBridgePlatform: false,
        recommendedRelayPlatform: "dingtalk",
      },
      capabilities: {
        agents: { run: true, continueSession: true },
        workflows: { run: true },
        subagents: { dispatch: true },
        media: { generate: true },
      },
    });
  });

  it("runs Wukong tasks through the existing bridge session manager", async () => {
    const executeExternalMessage = vi.fn(async () => ({ text: "done", toolMedia: ["file:///tmp/a.png"] }));
    const app = createApp({
      currentAgentId: "agent-a",
      getAgent: vi.fn((id: string) => id === "agent-a" ? { id, agentName: "Agent A" } : null),
      bridgeSessionManager: { executeExternalMessage },
    });

    const res = await app.request("/api/wukong/tasks/run?agentId=agent-a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "审批合同并总结风险",
        userId: "manager-001",
        conversationId: "conv-99",
        userName: "Manager",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      platform: "wukong",
      agentId: "agent-a",
      sessionKey: "wk_conv_conv-99@agent-a",
      result: { text: "done", toolMedia: ["file:///tmp/a.png"] },
    });
    expect(executeExternalMessage).toHaveBeenCalledWith(
      "审批合同并总结风险",
      "wk_conv_conv-99@agent-a",
      expect.objectContaining({
        platform: "wukong",
        userId: "manager-001",
        chatId: "conv-99",
        senderName: "Manager",
      }),
      expect.objectContaining({
        agentId: "agent-a",
        guest: false,
        contextTag: expect.stringContaining("Wukong"),
      }),
    );
  });

  it("runs an outbound Wukong runtime task for an agent configured to run on Wukong", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://wukong.example.com/tasks/run");
      expect(init.method).toBe("POST");
      expect(init.headers.authorization).toBe("Bearer runtime-token");
      expect(JSON.parse(init.body)).toMatchObject({
        text: "route this to Wukong",
        agentId: "agent-wk",
        agentName: "Wukong Agent",
        skillId: "skill-123",
        workspaceId: "workspace-9",
        source: { subsystem: "codia", surface: "api" },
      });
      return new Response(JSON.stringify({
        taskId: "wk-task-1",
        reply: "Wukong finished",
        media: ["https://cdn.example.com/a.png"],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const app = createApp({
      getAgent: (id: string) => id === "agent-wk" ? {
        id: "agent-wk",
        agentName: "Wukong Agent",
        config: {
          runtime: { target: "wukong" },
          wukong: {
            gatewayUrl: "https://wukong.example.com",
            token: "runtime-token",
            skillId: "skill-123",
            workspaceId: "workspace-9",
          },
        },
      } : null,
      getWukongRuntimeFetch: () => fetchImpl,
    });

    const res = await app.request("/api/wukong/runtime/tasks/run?agentId=agent-wk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "route this to Wukong" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      direction: "codia_to_wukong",
      platform: "wukong",
      agentId: "agent-wk",
      result: {
        text: "Wukong finished",
        externalTaskId: "wk-task-1",
        toolMedia: ["https://cdn.example.com/a.png"],
      },
    });
  });

  it("rejects task execution when required identity or text is missing", async () => {
    const app = createApp({
      currentAgentId: "agent-a",
      getAgent: vi.fn(() => ({ id: "agent-a", agentName: "Agent A" })),
      bridgeSessionManager: { executeExternalMessage: vi.fn() },
    });

    const res = await app.request("/api/wukong/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "", userId: "" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "text and userId are required",
    });
  });
});
