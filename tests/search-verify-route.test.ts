import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const searchMocks = vi.hoisted(() => ({
  verifySearchKey: vi.fn().mockResolvedValue(true),
  searchProviderRequiresApiKey: vi.fn((provider) => ["anysearch", "tavily", "brave", "serper"].includes(provider)),
}));

vi.mock("../lib/tools/web-search.js", () => searchMocks);

import { createConfigRoute } from "../server/routes/config.js";

describe("search verify route", () => {
  it("stores a verified API key without leaving auto provider mode", async () => {
    const setSearchConfig = vi.fn();
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      currentAgentId: "gsap",
      getSearchConfig: () => ({
        provider: "auto",
        api_key: null,
        api_keys: { brave: "old-brave" },
      }),
      setSearchConfig,
      updateConfig,
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/search/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "tavily",
        search_provider: "auto",
        api_key: "tvly-secret",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(searchMocks.verifySearchKey).toHaveBeenCalledWith("tavily", "tvly-secret");
    expect(setSearchConfig).toHaveBeenCalledWith({
      provider: "auto",
      api_key: "",
      api_keys: {
        brave: "old-brave",
        tavily: "tvly-secret",
      },
    });
    expect(updateConfig).toHaveBeenCalledWith({
      search: {
        provider: "auto",
        api_key: "",
        api_keys: {
          brave: "old-brave",
          tavily: "tvly-secret",
        },
      },
    });
  });

  it("stores a verified paid AnySearch API key", async () => {
    const setSearchConfig = vi.fn();
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      currentAgentId: "gsap",
      getSearchConfig: () => ({
        provider: "auto",
        api_key: null,
        api_keys: {},
      }),
      setSearchConfig,
      updateConfig,
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/search/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anysearch",
        search_provider: "anysearch",
        api_key: "any-secret",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(searchMocks.verifySearchKey).toHaveBeenCalledWith("anysearch", "any-secret");
    expect(setSearchConfig).toHaveBeenCalledWith({
      provider: "anysearch",
      api_key: "any-secret",
      api_keys: {
        anysearch: "any-secret",
      },
    });
  });
});
