import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createWorkspaceToolsRoute } from "../server/routes/workspace-tools.ts";

function makeApp(
  eventBus?: { request: (type: string, payload: Record<string, unknown>) => Promise<unknown> },
  listAgents?: () => Array<{ id: string; name?: string }>,
) {
  const app = new Hono();
  app.route("/api", createWorkspaceToolsRoute({ eventBus, listAgents }));
  return app;
}

describe("workspace tools route", () => {
  it("lists backend-backed workspace tools", async () => {
    const res = await makeApp().request("/api/workspace-tools");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.tools.map((tool: any) => tool.id)).toContain("research");
    expect(data.tools.find((tool: any) => tool.id === "meeting")).toMatchObject({
      title: "会议纪要",
      operation: "meeting_minutes",
      backendRoute: "/api/speech-recognition/providers",
    });
  });

  it("resolves a selected workspace tool into turn context", async () => {
    const res = await makeApp().request("/api/workspace-tools/resolve", {
      method: "POST",
      body: JSON.stringify({
        workspaceTool: { id: "workflow-market", title: "bad title" },
      }),
      headers: { "content-type": "application/json" },
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.tool).toMatchObject({
      id: "workflow-market",
      title: "工作流模板",
      operation: "workflow_templates",
    });
    expect(data.turnContext.system).toContain("Workflow Template mode is active");
    expect(data.turnContext.metadata.workspaceTool.recommendedTools).toContain("workflow");
  });

  it("rejects unknown workspace tools", async () => {
    const res = await makeApp().request("/api/workspace-tools/resolve", {
      method: "POST",
      body: JSON.stringify({ id: "browser" }),
      headers: { "content-type": "application/json" },
    });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("unknown workspace tool");
  });

  it("generates and validates a workflow draft with the existing utility model bus", async () => {
    const request = vi.fn(async (_type: string, _payload: Record<string, unknown>) => ({ text: JSON.stringify({
      title: "周报流程",
      nodes: [
        { id: "collect", title: "收集进展", prompt: "收集团队本周进展", agentId: "worker-1" },
        { id: "review", title: "风险复核", prompt: "复核风险并生成周报", agentId: "worker-2" },
      ],
      edges: [{ from: "collect", to: "review" }],
    }) }));
    const res = await makeApp({ request }).request("/api/workspace-tools/resolve", {
      method: "POST",
      body: JSON.stringify({
        workspaceTool: { id: "workflow-market" },
        action: "generate_workflow_template",
        input: {
          description: "生成团队周报",
          agents: [{ id: "worker-1", name: "工人一" }, { id: "worker-2", name: "工人二" }],
        },
      }),
      headers: { "content-type": "application/json" },
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.draft.nodes).toHaveLength(2);
    expect(data.draft.edges).toEqual([{ from: "collect", to: "review" }]);
    expect(request).toHaveBeenCalledWith("utility:call-text", expect.objectContaining({
      operation: "workflow_template_generation",
      timeoutMs: 45_000,
      signal: expect.any(AbortSignal),
    }));
  });

  it("does not trust client-supplied Agent ids when a server roster is available", async () => {
    const request = vi.fn(async (_type: string, _payload: Record<string, unknown>) => ({ text: JSON.stringify({
      title: "幽灵流程",
      nodes: [
        { id: "a", title: "A", prompt: "执行 A", agentId: "ghost" },
        { id: "b", title: "B", prompt: "执行 B", agentId: "" },
      ],
      edges: [{ from: "a", to: "b" }],
    }) }));
    const res = await makeApp({ request }, () => [{ id: "real", name: "真实 Agent" }]).request("/api/workspace-tools/resolve", {
      method: "POST",
      body: JSON.stringify({
        workspaceTool: { id: "workflow-market" },
        action: "generate_workflow_template",
        input: { description: "生成流程", agents: [{ id: "ghost", name: "伪造 Agent" }] },
      }),
      headers: { "content-type": "application/json" },
    });
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(data.error).toContain("不存在的 Agent");
    expect(request.mock.calls[0]?.[1]?.systemPrompt).not.toContain("ghost");
  });

  it("rejects invalid generated graphs", async () => {
    const request = vi.fn(async () => ({ text: JSON.stringify({
      title: "循环流程",
      nodes: [
        { id: "a", title: "A", prompt: "执行 A", agentId: "" },
        { id: "b", title: "B", prompt: "执行 B", agentId: "" },
      ],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    }) }));
    const res = await makeApp({ request }).request("/api/workspace-tools/resolve", {
      method: "POST",
      body: JSON.stringify({
        workspaceTool: { id: "workflow-market" },
        action: "generate_workflow_template",
        input: { description: "循环工作流", agents: [] },
      }),
      headers: { "content-type": "application/json" },
    });
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(data.error).toContain("循环");
  });
});
