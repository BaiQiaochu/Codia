import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPreferencesRoute } from "../server/routes/preferences.js";

describe("search preferences route", () => {
  it("returns provider-key map for auto search settings UI", async () => {
    const app = new Hono();
    app.route("/api", createPreferencesRoute({
      getSharedModels: () => ({}),
      getSearchConfig: () => ({
        provider: "auto",
        api_key: null,
        api_keys: { tavily: "tvly-secret", brave: "brave-secret" },
      }),
      getUtilityApi: () => ({}),
    }));

    const res = await app.request("/api/preferences/models");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      search: {
        provider: "auto",
        api_key: "",
        api_keys: { tavily: "********", brave: "********" },
      },
    });
  });

  it("passes multi-provider search keys through updates", async () => {
    const setSearchConfig = vi.fn();
    const app = new Hono();
    app.route("/api", createPreferencesRoute({
      currentAgentId: "gsap",
      getSharedModels: () => ({}),
      getSearchConfig: () => ({ provider: "auto", api_key: "", api_keys: {} }),
      getUtilityApi: () => ({}),
      setSearchConfig,
      emitEvent: vi.fn(),
    }));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        search: {
          provider: "auto",
          api_key: "",
          api_keys: { serper: "serper-secret" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(setSearchConfig).toHaveBeenCalledWith({
      provider: "auto",
      api_key: "",
      api_keys: { serper: "serper-secret" },
    });
  });
});
