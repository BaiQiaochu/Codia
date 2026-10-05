/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const gsapFetchMock = vi.fn();

vi.mock('../../../api', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
}));

import { addMcpConnector, removeMcpConnector, setMcpEnabled } from '../mcp-api';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

function mockMcpResponses(...responses: Response[]) {
  const queue = [...responses];
  gsapFetchMock.mockImplementation(() => Promise.resolve(queue.shift() ?? jsonResponse({ ok: true })));
}

afterEach(() => {
  gsapFetchMock.mockReset();
});

describe('mcp-api mutations', () => {
  it('throws when the global enabled endpoint returns a JSON error', async () => {
    mockMcpResponses(jsonResponse({ error: 'save failed' }));

    await expect(setMcpEnabled(true)).rejects.toThrow('save failed');
  });

  it('uses the plugin settings namespace for the global enabled endpoint', async () => {
    mockMcpResponses(jsonResponse({ enabled: true, connectors: [], agentConfig: { connectors: {} } }));

    await setMcpEnabled(true);

    expect(gsapFetchMock).toHaveBeenCalledWith(
      '/api/plugins/mcp/settings/enabled',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('throws when the global enabled endpoint does not return an MCP state', async () => {
    mockMcpResponses(jsonResponse({ ok: true }));

    await expect(setMcpEnabled(true)).rejects.toThrow('invalid state');
  });

  it('checks JSON errors for connector mutations too', async () => {
    gsapFetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'add failed' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'remove failed' }));

    await expect(addMcpConnector({
      name: 'GitHub',
      transport: 'remote',
      url: 'https://mcp.example.com/mcp',
      authType: 'none',
    })).rejects.toThrow('add failed');
    await expect(removeMcpConnector('github')).rejects.toThrow('remove failed');
  });
});
