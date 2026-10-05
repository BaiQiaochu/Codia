import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gsapFetch } from '../../hooks/use-gsap-fetch';
import { requestPromptOptimization } from '../../utils/prompt-optimizer';

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: vi.fn(),
}));

const gsapFetchMock = vi.mocked(gsapFetch);

describe('requestPromptOptimization', () => {
  beforeEach(() => {
    gsapFetchMock.mockReset();
  });

  it('posts the current draft and returns the optimized prompt', async () => {
    gsapFetchMock.mockResolvedValue(new Response(JSON.stringify({
      optimizedPrompt: 'A precise cinematic rainy ramen shop prompt.',
    })));

    const result = await requestPromptOptimization({
      prompt: '  rainy ramen shop cat  ',
      sessionPath: 'C:/tmp/session.jsonl',
      agentId: 'agent-1',
      locale: 'zh',
    });

    expect(result).toBe('A precise cinematic rainy ramen shop prompt.');
    expect(gsapFetchMock).toHaveBeenCalledWith('/api/prompts/optimize', expect.objectContaining({
      method: 'POST',
      timeout: 90_000,
      headers: { 'content-type': 'application/json' },
    }));
    expect(JSON.parse(String(gsapFetchMock.mock.calls[0][1]?.body))).toEqual({
      prompt: 'rainy ramen shop cat',
      sessionPath: 'C:/tmp/session.jsonl',
      agentId: 'agent-1',
      locale: 'zh',
    });
  });

  it('does not call the backend for empty drafts', async () => {
    await expect(requestPromptOptimization({ prompt: '   ' })).rejects.toThrow('empty_prompt');
    expect(gsapFetchMock).not.toHaveBeenCalled();
  });

  it('throws when the backend returns no optimized prompt', async () => {
    gsapFetchMock.mockResolvedValue(new Response(JSON.stringify({ optimizedPrompt: '' })));

    await expect(requestPromptOptimization({ prompt: 'hello' })).rejects.toThrow('empty_optimized_prompt');
  });
});
