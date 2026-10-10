/**
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  codiaFetch: vi.fn<(path: string, opts?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
    skills: [{ name: 'mio_skill', description: 'Mio skill', hidden: false, enabled: true }],
  }), { status: 200 })),
}));

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: (path: string, opts?: RequestInit) => mocks.codiaFetch(path, opts),
}));

describe('useSkillSlashItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentAgentId: 'codia',
      selectedAgentId: 'mio',
    } as never);
  });

  it('fetches skills for the explicit target agent instead of the current focused agent', async () => {
    const { useSkillSlashItems } = await import('../../hooks/use-slash-items');

    const { result } = renderHook(() => useSkillSlashItems({ enabled: true, agentId: 'mio' }));

    await waitFor(() => expect(result.current.map(item => item.name)).toEqual(['mio_skill']));
    expect(mocks.codiaFetch.mock.calls[0]?.[0]).toBe('/api/skills?agentId=mio&runtime=1');
    expect(mocks.codiaFetch.mock.calls.map(call => call[0])).not.toContain('/api/skills?agentId=codia&runtime=1');
  });
});
