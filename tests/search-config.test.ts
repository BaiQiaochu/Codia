import { describe, expect, it, vi } from "vitest";
import { ConfigCoordinator } from "../core/config-coordinator.js";
import {
  isBrowserSearchProvider,
  isFreeSearchApiProvider,
  isKnownSearchProvider,
  isSearchApiProvider,
  normalizeSearchApiKeys,
} from "../shared/search-providers.ts";

function makeCoordinator(initialPrefs = {}) {
  let prefs = { ...initialPrefs };
  const savePreferences = vi.fn((next) => {
    prefs = { ...next };
  });
  const coord = new ConfigCoordinator({
    gsapHome: "/tmp/test",
    agentsDir: "/tmp/test/agents",
    getAgent: () => null,
    getAgentById: () => null,
    getActiveAgentId: () => null,
    getAgents: () => new Map(),
    getModels: () => ({ availableModels: [] }),
    getPrefs: () => ({
      getPreferences: () => prefs,
      savePreferences,
    }),
    getSkills: () => null,
    getSession: () => null,
    getSessionCoordinator: () => null,
    getHub: () => null,
    emitEvent: vi.fn(),
    emitDevLog: vi.fn(),
    getCurrentModel: () => null,
  });
  return {
    coord,
    savePreferences,
    get prefs() {
      return prefs;
    },
  };
}

describe("search config preferences", () => {
  it("treats AnySearch free as a known keyless search provider", () => {
    expect(isKnownSearchProvider("anysearch_free")).toBe(true);
    expect(isSearchApiProvider("anysearch_free")).toBe(false);
    expect(isFreeSearchApiProvider("anysearch_free")).toBe(true);
    expect(isBrowserSearchProvider("anysearch_free")).toBe(false);
  });

  it("treats paid AnySearch as an API-key search provider", () => {
    expect(isKnownSearchProvider("anysearch")).toBe(true);
    expect(isSearchApiProvider("anysearch")).toBe(true);
    expect(isFreeSearchApiProvider("anysearch")).toBe(false);
    expect(normalizeSearchApiKeys({ anysearch: " any-key ", anysearch_free: "ignored" })).toEqual({
      anysearch: "any-key",
    });
  });

  it("defaults to auto search when no provider is configured", () => {
    const { coord } = makeCoordinator();

    expect(coord.getSearchConfig()).toEqual({
      provider: "auto",
      api_key: null,
      api_keys: {},
    });
  });

  it("exposes legacy single API keys through the provider-key map", () => {
    const { coord } = makeCoordinator({
      search_provider: "brave",
      search_api_key: "brave-secret",
    });

    expect(coord.getSearchConfig()).toEqual({
      provider: "brave",
      api_key: "brave-secret",
      api_keys: { brave: "brave-secret" },
    });
  });

  it("stores multiple search API keys without losing unrelated providers", () => {
    const state = makeCoordinator({
      search_provider: "tavily",
      search_api_key: "old-tvly",
      search_api_keys: { brave: "old-brave" },
    });

    state.coord.setSearchConfig({
      provider: "auto",
      api_keys: { tavily: "new-tvly" },
    });

    expect(state.prefs).toMatchObject({
      search_provider: "auto",
      search_api_keys: {
        tavily: "new-tvly",
        brave: "old-brave",
      },
    });
    expect(state.prefs).not.toHaveProperty("search_api_key");
  });

  it("keeps legacy api_key only for an explicitly selected API provider", () => {
    const state = makeCoordinator({
      search_provider: "auto",
      search_api_keys: { tavily: "tvly-secret", brave: "brave-secret" },
    });

    state.coord.setSearchConfig({ provider: "brave" });

    expect(state.prefs).toMatchObject({
      search_provider: "brave",
      search_api_key: "brave-secret",
      search_api_keys: {
        tavily: "tvly-secret",
        brave: "brave-secret",
      },
    });
  });
});
