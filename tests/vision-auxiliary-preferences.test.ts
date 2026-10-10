// @ts-nocheck
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ConfigCoordinator } from "../core/config-coordinator.js";

describe("auxiliary vision shared preference", () => {
  it("stores and clears vision_enabled without changing runtime utility models", () => {
    let prefs = {};
    const focusAgent = {
      id: "focus",
      updateConfig: vi.fn(),
      setUtilityModel: vi.fn(),
      setMemoryModel: vi.fn(),
    };
    const coord = new ConfigCoordinator({
      codiaHome: "/tmp/test",
      agentsDir: "/tmp/test/agents",
      getAgent: () => focusAgent,
      getAgentById: () => null,
      getActiveAgentId: () => "focus",
      getAgents: () => new Map([["focus", focusAgent]]),
      getModels: () => ({ availableModels: [], defaultModel: null }),
      getPrefs: () => ({
        getPreferences: () => prefs,
        savePreferences: (next) => { prefs = { ...next }; },
      }),
      getSkills: () => ({ syncAgentSkills: vi.fn() }),
      getSession: () => null,
      getSessionCoordinator: () => null,
      getHub: () => null,
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getCurrentModel: () => null,
    });

    expect(coord.getSharedModels()).toEqual(expect.objectContaining({
      vision_enabled: false,
    }));

    coord.setSharedModels({ vision_enabled: true });
    expect(prefs.vision_auxiliary_enabled).toBe(true);
    expect(coord.getSharedModels()).toEqual(expect.objectContaining({
      vision_enabled: true,
    }));
    expect(focusAgent.setUtilityModel).not.toHaveBeenCalled();
    expect(focusAgent.setMemoryModel).not.toHaveBeenCalled();

    coord.setSharedModels({ vision_enabled: false });
    expect(prefs).not.toHaveProperty("vision_auxiliary_enabled");
    expect(coord.getSharedModels()).toEqual(expect.objectContaining({
      vision_enabled: false,
    }));
  });

  it("updates the auxiliary vision flag without refreshing the model registry", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({ vision_enabled: false })),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      resolveModelWithCredentials: vi.fn(),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      currentAgentId: "focus",
      emitEvent: vi.fn(),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          vision_enabled: true,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.setSharedModels).toHaveBeenCalledWith({ vision_enabled: true });
    expect(engine.resolveModelWithCredentials).not.toHaveBeenCalled();
    expect(engine.syncModelsAndRefresh).not.toHaveBeenCalled();
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "app_event",
      event: {
        type: "models-changed",
        payload: { agentId: "focus" },
        source: "server",
      },
    }, null);
  });
});
