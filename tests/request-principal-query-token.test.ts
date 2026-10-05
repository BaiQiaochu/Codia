import { describe, expect, it, vi } from "vitest";
import { resolveHttpRequestPrincipal } from "../server/http/request-principal.js";

function makeContext(url: string, headers: Record<string, string> = {}) {
  const parsed = new URL(url);
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    req: {
      url,
      method: "GET",
      header: (name: string) => normalizedHeaders.get(name.toLowerCase()),
      query: (name: string) => parsed.searchParams.get(name) ?? undefined,
    },
  };
}

function makeAuthService() {
  return {
    authenticateRequestDetailed: vi.fn(() => ({
      principal: { kind: "device", scopes: ["chat"], connectionKind: "lan" },
      denied: null,
    })),
  };
}

describe("resolveHttpRequestPrincipal query token policy", () => {
  it("does not forward URL query tokens for non-local HTTP transports", () => {
    const authService = makeAuthService();
    const result = resolveHttpRequestPrincipal(
      makeContext("http://example.test/api/health?token=leaked"),
      {},
      {
        serverAuthService: authService,
        connectionKind: "lan",
      },
    );

    expect(result.ok).toBe(true);
    expect(authService.authenticateRequestDetailed).toHaveBeenCalledWith(expect.objectContaining({
      queryToken: null,
      allowQueryToken: false,
      connectionKind: "lan",
    }));
  });

  it("only forwards query tokens for local loopback transports", () => {
    const authService = makeAuthService();
    const result = resolveHttpRequestPrincipal(
      makeContext("http://127.0.0.1:8123/api/health?token=local-ticket"),
      {},
      {
        serverAuthService: authService,
        connectionKind: "local",
      },
    );

    expect(result.ok).toBe(true);
    expect(authService.authenticateRequestDetailed).toHaveBeenCalledWith(expect.objectContaining({
      queryToken: "local-ticket",
      allowQueryToken: true,
      connectionKind: "local",
    }));
  });
});
