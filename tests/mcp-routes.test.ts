import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import registerMcpRoutes from "../plugins/mcp/routes/api.js";

function createApp({ initialEnabled = false } = {}) {
  let enabled = initialEnabled;
  const runtime = {
    getState: vi.fn((agentConfig = {}) => ({
      enabled,
      connectors: [],
      servers: [],
      agentConfig,
    })),
    setEnabled: vi.fn(async (nextEnabled) => {
      enabled = nextEnabled === true;
      return { enabled, connectors: [], servers: [] };
    }),
    updateAgentMcpConnector: vi.fn(async (agentId, connectorId, patch) => ({
      mcp: {
        connectors: {
          [connectorId]: patch,
        },
      },
    })),
  };
  const ctx = {
    _mcpRuntime: runtime,
    bus: {
      request: vi.fn(async (type, payload) => {
        if (type === "agent:config") {
          return { config: { id: payload.agentId, mcp: { connectors: {} } } };
        }
        return {};
      }),
    },
    log: { error: vi.fn(), warn: vi.fn() },
  };
  const mcp = new Hono();
  registerMcpRoutes(mcp, ctx);
  const app = new Hono();
  app.route("/api/plugins/mcp", mcp);
  return { app, runtime, ctx };
}

describe("mcp plugin routes", () => {
  it("persists the global connector switch through the settings endpoint", async () => {
    const { app, runtime, ctx } = createApp();

    const res = await app.request("/api/plugins/mcp/settings/enabled?agentId=codia", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true });
    expect(runtime.setEnabled).toHaveBeenCalledWith(true);
    expect(ctx.bus.request).toHaveBeenCalledWith("agent:config", { agentId: "codia" });
  });

  it("keeps the legacy global enabled route working", async () => {
    const { app, runtime } = createApp({ initialEnabled: true });

    const res = await app.request("/api/plugins/mcp/enabled", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false });
    expect(runtime.setEnabled).toHaveBeenCalledWith(false);
  });

  it("updates an agent connector switch through the backend", async () => {
    const { app, runtime } = createApp();

    const res = await app.request("/api/plugins/mcp/agents/codia/connectors/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      config: { mcp: { connectors: { github: { enabled: true } } } },
    });
    expect(runtime.updateAgentMcpConnector).toHaveBeenCalledWith("codia", "github", { enabled: true });
  });
});
