import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("web_search browser providers", () => {
  beforeEach(() => {
    searchWebMock.mockReset();
    resetWebSearchRateLimiterForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not require API keys for browser-backed providers", async () => {
    expect(searchProviderRequiresApiKey("auto")).toBe(false);
    expect(searchProviderRequiresApiKey("anysearch")).toBe(true);
    expect(searchProviderRequiresApiKey("anysearch_free")).toBe(false);
    expect(searchProviderRequiresApiKey("bing_browser")).toBe(false);
    expect(searchProviderRequiresApiKey("google_browser")).toBe(false);
    expect(searchProviderRequiresApiKey("duckduckgo_browser")).toBe(false);
    await expect(verifySearchKey("auto", "")).resolves.toBe(true);
    await expect(verifySearchKey("bing_browser", "")).resolves.toBe(true);
  });

  it("uses a Bearer token for paid AnySearch API requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        code: 0,
        data: {
          results: [
            { title: "Paid AnySearch", url: "https://example.com/paid", content: "Paid result" },
          ],
          metadata: { request_id: "req-paid" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "anysearch", api_key: "paid-key" }),
    });
    const result = await tool.execute("call-anysearch-paid", {
      query: "codia paid anysearch",
      maxResults: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer paid-key",
    });
    expect(result.details).toMatchObject({
      provider: "anysearch",
      source_type: "api",
      diagnostics: {
        anonymous: false,
        request_id: "req-paid",
      },
    });
  });

  it("returns Tavily-like structured details from a browser provider", async () => {
    searchWebMock.mockResolvedValue({
      query: "codia search",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Result",
          url: "https://example.com",
          content: "Snippet",
          rank: 1,
          score: null,
          metadata: { display_url: "example.com", engine: "bing" },
        },
      ],
      diagnostics: {
        final_url: "https://www.bing.com/search?q=codia+search",
        blocked: false,
        captcha: false,
        elapsed_ms: 1234,
      },
    });

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "bing_browser", api_key: "" }),
    });
    const result = await tool.execute("call-1", { query: "codia search", maxResults: 3 });

    expect(searchWebMock).toHaveBeenCalledWith({
      provider: "bing_browser",
      query: "codia search",
      maxResults: 3,
      locale: "zh",
    });
    expect(result.details).toMatchObject({
      query: "codia search",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Result",
          url: "https://example.com",
          content: "Snippet",
          rank: 1,
          metadata: { engine: "bing" },
        },
      ],
      diagnostics: {
        blocked: false,
        captcha: false,
      },
    });
    expect(result.content[0].type).toBe("text");
  });

  it("routes provider execution through the injected rate limiter", async () => {
    searchWebMock.mockResolvedValue({
      query: "codia limited",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Limited Result",
          url: "https://example.com/limited",
          content: "Limited snippet",
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
      searchConfigResolver: () => ({ provider: "bing_browser", api_key: "" }),
      rateLimiter,
    });
    const result = await tool.execute("call-limited", { query: "codia limited", maxResults: 1 });

    expect(result.details.results).toHaveLength(1);
    expect(rateLimiter.run).toHaveBeenCalledWith(
      "bing_browser",
      "browser",
      expect.any(Function),
    );
  });

  it("surfaces API 429 responses as rate limit errors with Retry-After", async () => {
    let capturedError = null;
    const rateLimiter = {
      run: vi.fn(async (_provider, _sourceType, operation) => {
        try {
          return await operation();
        } catch (err) {
          capturedError = err;
          throw err;
        }
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "too many requests" }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "3" },
      },
    )));

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "brave", api_key: "test-key" }),
      rateLimiter,
    });
    await tool.execute("call-429", { query: "codia limited", maxResults: 1 });

    expect(rateLimiter.run).toHaveBeenCalledWith("brave", "api", expect.any(Function));
    expect(capturedError).toMatchObject({
      name: "SearchRateLimitError",
      status: 429,
      retryAfterMs: 3_000,
    });
  });

  it("fetches a broader AnySearch candidate set by default while formatting ten results", async () => {
    const anySearchResults = Array.from({ length: 20 }, (_, index) => ({
      title: `AnySearch Result ${index + 1}`,
      url: `https://example.com/anysearch-${index + 1}`,
      description: `AnySearch description ${index + 1}`,
      content: `AnySearch content ${index + 1}`,
      score: 100 - index,
      quality_score: 90 - index,
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: {
          results: anySearchResults,
          metadata: {
            total_results: 20,
            search_time_ms: 123,
            request_id: "req-anysearch-broad",
            cached: false,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "auto", api_keys: {} }),
    });
    const result = await tool.execute("call-anysearch-broad-default", {
      query: "codia broad default",
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      query: "codia broad default",
      max_results: 20,
    });
    expect(result.details.results).toHaveLength(20);
    expect(result.content[0].text).toContain("10. **AnySearch Result 10**");
    expect(result.content[0].text).not.toContain("11. **AnySearch Result 11**");
  });

  it("clamps Tavily requests to its official result ceiling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        results: [
          { title: "Tavily Result", url: "https://example.com/tavily", content: "Tavily snippet" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "tavily", api_key: "tvly-key" }),
    });
    await tool.execute("call-tavily-clamp", {
      query: "codia tavily clamp",
      maxResults: 50,
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      query: "codia tavily clamp",
      max_results: 20,
      search_depth: "basic",
    });
  });

  it("defaults to auto search and uses AnySearch free before browser providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: {
          results: [
            {
              title: "AnySearch Result",
              url: "https://example.com/anysearch",
              description: "AnySearch description",
              content: "AnySearch content",
              score: 68.5,
              quality_score: 68.5,
            },
          ],
          metadata: {
            total_results: 1,
            search_time_ms: 123,
            request_id: "req-anysearch",
            cached: false,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    searchWebMock.mockResolvedValue({
      query: "codia default",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Default Result",
          url: "https://example.com/default",
          content: "Default snippet",
          rank: 1,
          score: null,
          metadata: { engine: "bing" },
        },
      ],
      diagnostics: {
        final_url: "https://www.bing.com/search?q=codia+default",
        blocked: false,
        captcha: false,
      },
    });

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "", api_key: "" }),
    });
    const result = await tool.execute("call-2", { query: "codia default", maxResults: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(searchWebMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      query: "codia default",
      provider: "anysearch_free",
      source_type: "api",
      diagnostics: {
        strategy: "auto",
        request_id: "req-anysearch",
        attempts: [
          {
            provider: "anysearch_free",
            status: "ok",
          },
        ],
      },
      results: [
        {
          title: "AnySearch Result",
          url: "https://example.com/anysearch",
          content: "AnySearch content",
          score: 68.5,
          metadata: { quality_score: 68.5 },
        },
      ],
    });
  });

  it("auto search tries configured paid AnySearch before AnySearch free", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          code: 0,
          data: {
            results: [
              {
                title: "Paid AnySearch Result",
                url: "https://example.com/paid-anysearch",
                content: "Paid AnySearch content",
              },
            ],
            metadata: { request_id: "req-paid-auto" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({
        provider: "auto",
        api_keys: { anysearch: "paid-key" },
      }),
    });
    const result = await tool.execute("call-anysearch-paid-auto", {
      query: "codia paid auto",
      maxResults: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer paid-key",
    });
    expect(result.details).toMatchObject({
      provider: "anysearch",
      diagnostics: {
        strategy: "auto",
        attempts: [
          {
            provider: "anysearch",
            status: "ok",
          },
        ],
      },
    });
  });

  it("auto search falls back from exhausted AnySearch free quota to browser providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 402, message: "free quota exhausted" }),
      {
        status: 402,
        headers: { "Content-Type": "application/json" },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);
    searchWebMock.mockResolvedValue({
      query: "codia quota fallback",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Browser Result",
          url: "https://example.com/browser",
          content: "Browser snippet",
          rank: 1,
          score: null,
          metadata: { engine: "bing" },
        },
      ],
      diagnostics: { blocked: false, captcha: false },
    });

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "auto", api_keys: {} }),
    });
    const result = await tool.execute("call-anysearch-fallback", {
      query: "codia quota fallback",
      maxResults: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(searchWebMock).toHaveBeenCalledWith({
      provider: "bing_browser",
      query: "codia quota fallback",
      maxResults: 1,
      locale: "zh",
    });
    expect(result.details).toMatchObject({
      provider: "bing_browser",
      source_type: "browser",
      diagnostics: {
        strategy: "auto",
        attempts: [
          {
            provider: "anysearch_free",
            status: "error",
            error_type: "rate_limited",
          },
          {
            provider: "bing_browser",
            status: "ok",
          },
        ],
      },
    });
  });
});
