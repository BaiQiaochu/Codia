import { beforeEach, describe, expect, it, vi } from 'vitest';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import { requestResearchReport } from '../../utils/research-mode';

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: vi.fn(),
}));

const codiaFetchMock = vi.mocked(codiaFetch);

describe('requestResearchReport', () => {
  beforeEach(() => {
    codiaFetchMock.mockReset();
  });

  it('posts the current topic and returns the research report', async () => {
    codiaFetchMock.mockResolvedValue(new Response(JSON.stringify({
      report: 'A cited research report.',
      mode: 'academic',
      generatedAt: '2026-06-27T00:00:00.000Z',
    })));

    const result = await requestResearchReport({
      topic: '  mainland china ai search products  ',
      mode: 'academic',
      sessionPath: 'C:/tmp/session.jsonl',
      agentId: 'agent-1',
      locale: 'zh',
      exportFormats: ['word', 'pdf'],
    });

    expect(result).toEqual({
      report: 'A cited research report.',
      mode: 'academic',
      generatedAt: '2026-06-27T00:00:00.000Z',
    });
    expect(codiaFetchMock).toHaveBeenCalledWith('/api/prompts/research', expect.objectContaining({
      method: 'POST',
      timeout: 180_000,
      headers: { 'content-type': 'application/json' },
    }));
    expect(JSON.parse(String(codiaFetchMock.mock.calls[0][1]?.body))).toEqual({
      topic: 'mainland china ai search products',
      mode: 'academic',
      exportFormats: ['word', 'pdf'],
      sessionPath: 'C:/tmp/session.jsonl',
      agentId: 'agent-1',
      locale: 'zh',
    });
  });

  it('does not call the backend for empty topics', async () => {
    await expect(requestResearchReport({ topic: '   ' })).rejects.toThrow('empty_research_topic');
    expect(codiaFetchMock).not.toHaveBeenCalled();
  });

  it('throws when the backend returns no report', async () => {
    codiaFetchMock.mockResolvedValue(new Response(JSON.stringify({ report: '', error: 'search unavailable' })));

    await expect(requestResearchReport({ topic: 'ai search' })).rejects.toThrow('search unavailable');
  });
});
