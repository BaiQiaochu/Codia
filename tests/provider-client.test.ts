import { describe, expect, it } from "vitest";
import { buildProviderRequestHeaders } from "../lib/llm/provider-client.ts";

describe("provider client request headers", () => {
  it("adds a debranded default User-Agent for provider catalog requests", () => {
    const headers = buildProviderRequestHeaders({
      api: "openai-completions",
      apiKey: "sk-test",
    });

    expect(headers["User-Agent"]).toBe("G-SAP/1.0");
  });

  it("preserves an explicit provider User-Agent header", () => {
    const headers = buildProviderRequestHeaders({
      api: "openai-completions",
      apiKey: "sk-test",
      headers: { "User-Agent": "CustomGateway/2.0" },
    });

    expect(headers["User-Agent"]).toBe("CustomGateway/2.0");
  });

  it("uses Bearer auth for Kimi Coding Anthropic-compatible catalog requests", () => {
    const headers = buildProviderRequestHeaders({
      api: "anthropic-messages",
      apiKey: "sk-kimi",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding/",
    });

    expect(headers.Authorization).toBe("Bearer sk-kimi");
    expect(headers["x-api-key"]).toBeUndefined();
  });
});
