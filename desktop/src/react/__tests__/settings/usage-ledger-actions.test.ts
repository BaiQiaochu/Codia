import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gsapFetch: vi.fn(),
}));

vi.mock('../../settings/api', () => ({
  gsapFetch: mocks.gsapFetch,
}));

import { loadLlmUsageEntries } from '../../settings/tabs/providers/usage-ledger-actions';

describe('usage ledger actions', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests explicit date windows without the latest-entry default limit', async () => {
    mocks.gsapFetch.mockResolvedValue({
      json: async () => ({ entries: [] }),
    });

    await loadLlmUsageEntries({
      since: '2026-05-20T00:00:00.000Z',
      until: '2026-05-21T00:00:00.000Z',
    });

    expect(mocks.gsapFetch).toHaveBeenCalledWith(
      '/api/usage/llm?since=2026-05-20T00%3A00%3A00.000Z&until=2026-05-21T00%3A00%3A00.000Z',
    );
  });
});
