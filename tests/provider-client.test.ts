import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { buildProviderRequestHeaders, probeProvider } from "../lib/llm/provider-client.ts";

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

afterEach(() => { vi.unstubAllGlobals(); });

const probeInput = (api: string, baseUrl = 'http://127.0.0.1/v1') => ({
  baseUrl, api, apiKey: 'synthetic-unused', modelId: 'synthetic-model', provider: '', headers: {},
});

describe('provider probe upstream availability', () => {
  it.each([
    ['openai-completions', 500], ['openai-completions', 502], ['openai-completions', 503],
    ['anthropic-messages', 500], ['anthropic-messages', 503], ['anthropic-messages', 529],
  ])('does not report connection success for a real loopback %s HTTP %s response', async (api, status) => {
    const requests: Array<{ method: string; url: string }> = [];
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      request.resume();
      response.writeHead(Number(status), { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'private upstream diagnostic must not be reflected' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing loopback address');
      const result = await probeProvider(probeInput(String(api), `http://127.0.0.1:${address.port}/v1`));
      expect(result).toMatchObject({ ok: false, status });
      expect(result).toHaveProperty('error', `Provider unavailable (HTTP ${status})`);
      expect(JSON.stringify(result)).not.toContain('private upstream diagnostic');
      expect(requests).toEqual([{ method: api === 'anthropic-messages' ? 'POST' : 'GET', url: api === 'anthropic-messages' ? '/v1/messages' : '/v1/models' }]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['openai-completions', 'anthropic-messages'])('retains the existing %s auth-probe compatibility statuses', async api => {
    for (const status of [200, 400, 404, 429]) {
      const fetch = vi.fn(async () => new Response('{}', { status }));
      vi.stubGlobal('fetch', fetch);
      expect(await probeProvider(probeInput(api))).toEqual({ ok: true, status });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it.each(['openai-completions', 'anthropic-messages'])('still rejects %s authentication failures', async api => {
    for (const status of [401, 403]) {
      const fetch = vi.fn(async () => new Response('{}', { status }));
      vi.stubGlobal('fetch', fetch);
      expect(await probeProvider(probeInput(api))).toEqual({ ok: false, status });
      expect(fetch).toHaveBeenCalledTimes(api === 'anthropic-messages' ? 2 : 1);
    }
  });

  it('retains successful Anthropic bearer fallback but rejects a failing upstream retry', async () => {
    for (const status of [200, 503]) {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response('{}', { status: 401 }))
        .mockResolvedValueOnce(new Response('{}', { status }));
      vi.stubGlobal('fetch', fetch);
      expect(await probeProvider(probeInput('anthropic-messages'))).toMatchObject({ ok: status === 200, status });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0][1].headers['x-api-key']).toBe('synthetic-unused');
      expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-unused');
    }
  });

  it('preserves the explicit skipped-health contract without issuing a Codex request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await probeProvider(probeInput('openai-codex-responses'))).toMatchObject({ ok: true, status: 0, skipped: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });
});
