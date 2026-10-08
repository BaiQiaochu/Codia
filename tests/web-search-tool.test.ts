import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocale } from "../server/i18n.js";

const searchWebMock = vi.fn();

vi.mock("../lib/browser/browser-manager.js", () => ({
  BrowserManager: {
    instance: () => ({
      searchWeb: searchWebMock,
    }),
  },
}));

import {
  createWebSearchTool,
  resetWebSearchRateLimiterForTests,
  searchProviderRequiresApiKey,
  verifySearchKey,
} from "../lib/tools/web-search.js";

describe("web_search tool", () => {
  beforeEach(() => {
    loadLocale("en");
    searchWebMock.mockReset();
    resetWebSearchRateLimiterForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not require API keys for browser-backed providers", async () => {
    expect(searchProviderRequiresApiKey("auto")).toBe(false);
    expect(searchProviderRequiresApiKey("bing_browser")).toBe(false);
    expect(searchProviderRequiresApiKey("google_browser")).toBe(false);
    expect(searchProviderRequiresApiKey("duckduckgo_browser")).toBe(false);
    await expect(verifySearchKey("auto", "")).resolves.toBe(true);
    await expect(verifySearchKey("bing_browser", "")).resolves.toBe(true);
  });

  it("auto search tries configured API providers and AnySearch before browser fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "too many requests" }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      },
    )));
    searchWebMock.mockResolvedValue({
      query: "fallback search",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Browser Result",
          url: "https://example.com/fallback",
          content: "Browser snippet",
          rank: 1,
          score: null,
          metadata: { engine: "bing" },
        },
      ],
      diagnostics: { blocked: false, captcha: false },
    });
    const rateLimiter = {
      run: vi.fn(async (_provider, _sourceType, operation) => operation()),
    };

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({
        provider: "auto",
        api_key: "",
        api_keys: { brave: "brave-secret" },
      }),
      rateLimiter,
    });
    const result = await tool.execute("call-auto", { query: "fallback search", maxResults: 2 });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(searchWebMock).toHaveBeenCalledWith({
      provider: "bing_browser",
      query: "fallback search",
      maxResults: 2,
      locale: "en",
    });
    expect(result.details).toMatchObject({
      provider: "bing_browser",
      source_type: "browser",
      diagnostics: {
        strategy: "auto",
        attempts: [
          { provider: "brave", status: "error", error_type: "rate_limited" },
          { provider: "anysearch_free", status: "error", error_type: "rate_limited" },
          { provider: "bing_browser", status: "ok", result_count: 1 },
        ],
      },
    });
  });

  it("defaults to AnySearch free when no search provider is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: {
          results: [
            {
              title: "AnySearch Result",
              url: "https://example.com",
              content: "Example snippet",
              rank: 1,
            },
          ],
          metadata: {
            request_id: "req-test",
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    searchWebMock.mockResolvedValue({
      query: "example search",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Example Result",
          url: "https://example.com",
          content: "Example snippet",
          rank: 1,
          score: null,
          metadata: { engine: "bing" },
        },
      ],
      diagnostics: {
        final_url: "https://www.bing.com/search?q=example+search",
        blocked: false,
        captcha: false,
      },
    });

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "", api_key: "" }),
    });
    const result = await tool.execute("call-1", { query: "example search", maxResults: 3 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(searchWebMock).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("via anysearch_free");
    expect(result.content[0].text).toContain("https://example.com");
  });

  it("supports explicit browser provider without API key", async () => {
    searchWebMock.mockResolvedValue({
      query: "duck query",
      provider: "duckduckgo_browser",
      source_type: "browser",
      results: [
        {
          title: "Duck Result",
          url: "https://duck.example.com",
          content: "Duck snippet",
          rank: 1,
          score: null,
          metadata: { engine: "duckduckgo" },
        },
      ],
      diagnostics: { blocked: false, captcha: false },
    });

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "duckduckgo_browser", api_key: "" }),
    });

    const result = await tool.execute("call-2", { query: "duck query" });

    expect(searchWebMock).toHaveBeenCalledOnce();
    expect(searchWebMock).toHaveBeenCalledWith({
      provider: "duckduckgo_browser",
      query: "duck query",
      maxResults: 10,
      locale: "en",
    });
    expect(result.content[0].text).toContain("Duck Result");
  });

  it("still requires API key for paid search providers", async () => {
    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "tavily", api_key: "" }),
    });

    const result = await tool.execute("call-3", { query: "needs key" });

    expect(result.content[0].text).toContain("missing API Key");
    expect(searchWebMock).not.toHaveBeenCalled();
  });
});
