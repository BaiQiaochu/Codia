import { Hono } from "hono";
import { routeError, strictJson } from "../hono-helpers.ts";
import {
  WORKSPACE_TOOL_CONTRACTS,
  getWorkspaceToolContract,
  buildWorkspaceToolTurnContext,
} from "../../shared/workspace-tools.ts";
import { validateWorkflowTemplateDraft } from "../../shared/workflow-template-draft.ts";

type WorkspaceToolsEventBus = {
  request: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
};

type WorkspaceToolsAgent = { id?: unknown; name?: unknown };

function workflowTemplateSystemPrompt(agentIds: string[]) {
  return [
    "Generate a practical directed acyclic workflow from the user's description.",
    "Return strict JSON only, without markdown or commentary.",
    "Schema: {\"title\":\"...\",\"nodes\":[{\"id\":\"short-id\",\"title\":\"...\",\"prompt\":\"clear executable instruction\",\"agentId\":\"...\"}],\"edges\":[{\"from\":\"node-id\",\"to\":\"node-id\"}]}",
    "Create 2 to 8 nodes, use unique ASCII ids, no self links, duplicate links, or cycles.",
    agentIds.length > 0
      ? `agentId must be empty or one of these exact ids: ${agentIds.join(", ")}`
      : "Use an empty string for every agentId because no Agent is available.",
  ].join("\n");
}

export function createWorkspaceToolsRoute({
  eventBus,
  listAgents,
}: {
  eventBus?: WorkspaceToolsEventBus | null;
  listAgents?: (() => readonly WorkspaceToolsAgent[]) | null;
} = {}) {
  const route = new Hono();

  route.get("/workspace-tools", (c) => c.json({
    ok: true,
    tools: WORKSPACE_TOOL_CONTRACTS,
  }));

  route.post("/workspace-tools/resolve", async (c) => {
    try {
      const body = await strictJson(c);
      const rawTool = body?.workspaceTool ?? body?.tool ?? body?.id;
      const contract = getWorkspaceToolContract(rawTool);
      if (!contract) {
        return c.json({ error: "unknown workspace tool" }, 400);
      }
      if (body?.action === "generate_workflow_template") {
        if (contract.id !== "workflow-market") {
          return c.json({ error: "workflow template generation requires workflow-market" }, 400);
        }
        const description = typeof body?.input?.description === "string"
          ? body.input.description.trim()
          : "";
        if (!description) return c.json({ error: "workflow description is required" }, 400);
        if (description.length > 4_000) return c.json({ error: "workflow description is too long" }, 400);
        if (!eventBus || typeof eventBus.request !== "function") {
          return c.json({ error: "workflow template model is unavailable" }, 503);
        }
        const requestedAgents: Array<{ id: string; name: string }> = Array.isArray(body?.input?.agents)
          ? body.input.agents
            .filter((agent: unknown) => agent && typeof agent === "object")
            .map((agent: { id?: unknown; name?: unknown }) => ({
              id: String(agent.id || "").trim(),
              name: String(agent.name || agent.id || "").trim(),
            }))
            .filter((agent: { id: string }) => agent.id)
            .slice(0, 100)
          : [];
        const knownAgents = typeof listAgents === "function"
          ? new Map(listAgents()
            .map((agent) => ({
              id: String(agent?.id || "").trim(),
              name: String(agent?.name || agent?.id || "").trim(),
            }))
            .filter((agent) => agent.id)
            .map((agent) => [agent.id, agent] as const))
          : null;
        const agents = knownAgents
          ? requestedAgents
            .filter((agent) => knownAgents.has(agent.id))
            .map((agent) => ({ ...agent, name: knownAgents.get(agent.id)?.name || agent.name }))
          : requestedAgents;
        const agentIds: string[] = Array.from(new Set(agents.map((agent) => agent.id)));
        const result = await eventBus.request("utility:call-text", {
          agentId: typeof body.agentId === "string" ? body.agentId : null,
          operation: "workflow_template_generation",
          systemPrompt: [
            buildWorkspaceToolTurnContext(contract)?.system || "",
            workflowTemplateSystemPrompt(agentIds),
          ].filter(Boolean).join("\n\n"),
          messages: [{
            role: "user",
            content: [
              `Workflow description:\n${description}`,
              agents.length > 0
                ? `Available Agents:\n${agents.map((agent: { id: string; name: string }) => `- ${agent.id}: ${agent.name}`).join("\n")}`
                : "Available Agents: none",
            ].join("\n\n"),
          }],
          temperature: 0.2,
          maxTokens: 1800,
          timeoutMs: 45_000,
          signal: c.req.raw.signal,
        });
        const modelText = typeof result === "string"
          ? result
          : result && typeof result === "object" && "text" in result
            ? (result as { text?: unknown }).text
            : null;
        const validation = validateWorkflowTemplateDraft(modelText, { allowedAgentIds: agentIds });
        if (validation.ok === false) {
          return c.json({ error: validation.error }, 422);
        }
        return c.json({ ok: true, tool: contract, draft: validation.draft });
      }
      return c.json({
        ok: true,
        tool: contract,
        turnContext: buildWorkspaceToolTurnContext(contract),
      });
    } catch (err) {
      return routeError(c, err);
    }
  });

  return route;
}
