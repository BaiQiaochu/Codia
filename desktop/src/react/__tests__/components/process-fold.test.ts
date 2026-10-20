import { describe, expect, it } from 'vitest';
import { buildProcessFoldSummary, buildTranscriptRenderItems } from '../../components/chat/process-fold';
import type { ChatListItem } from '../../stores/chat-types';

describe('process fold summary fallback', () => {
  it('keeps one process card across explicit continuations with the same run ID', () => {
    const process = (id: string): ChatListItem => ({ type: 'message', data: {
      id, role: 'assistant', runId: 'run-1',
      blocks: [{ type: 'tool_group', collapsed: true, tools: [{ id, name: 'read', done: true, success: true }] }],
    } });
    const items: ChatListItem[] = [process('a'), { type: 'message', data: { id: 'continue', role: 'user', text: 'Continue' } }, process('b')];
    const cards = buildTranscriptRenderItems(items, { isStreaming: true }).filter(item => item.type === 'process_fold');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 'process-run-run-1', active: true, stats: { toolCount: 2 } });
  });
  it('uses Chinese fallback copy when runtime i18n is unavailable', () => {
    const text = buildProcessFoldSummary(
      { toolCount: 13, thinkingCount: 5, unsuccessfulCount: 1 },
      'Codia',
    );

    expect(text).toBe('执行过程 · 13 个工具 · 5 次思考 · 1 次尝试未成功');
    expect(text).not.toMatch(/worked through|tools|thinking blocks|unsuccessful attempts/);
  });

  it('summarizes the active action, affected files, and tool duration', () => {
    const items = [{
      type: 'message' as const,
      data: {
        id: 'assistant-active',
        role: 'assistant' as const,
        blocks: [{
          type: 'tool_group' as const,
          collapsed: false,
          tools: [
            { id: 'a', name: 'read', args: { file_path: 'src/a.ts' }, done: true, success: true, durationMs: 800 },
            { id: 'b', name: 'apply_patch', args: { path: 'src/b.ts' }, done: false, success: false },
          ],
        }],
      },
    }] as unknown as ChatListItem[];

    const rendered = buildTranscriptRenderItems(items, { isStreaming: true });
    expect(rendered[0].type).toBe('process_fold');
    if (rendered[0].type !== 'process_fold') return;
    expect(buildProcessFoldSummary(rendered[0].stats, 'Codia'))
      .toBe('执行过程 · 正在执行 修改文件 · 已完成 1 项 · 涉及 2 个文件 · 耗时 800ms');
  });

  it('ignores malformed tool groups instead of folding them', () => {
    const malformedItems = [
      {
        type: 'message' as const,
        data: {
          id: 'assistant-1',
          role: 'assistant' as const,
          blocks: [
            { type: 'tool_group', tools: null, collapsed: false },
          ],
        },
      },
      {
        type: 'message' as const,
        data: {
          id: 'assistant-2',
          role: 'assistant' as const,
          blocks: [
            { type: 'tool_group', tools: null, collapsed: false },
          ],
        },
      },
      {
        type: 'message' as const,
        data: {
          id: 'assistant-3',
          role: 'assistant' as const,
          blocks: [
            { type: 'tool_group', tools: null, collapsed: false },
          ],
        },
      },
    ] as unknown as ChatListItem[];

    expect(() => buildTranscriptRenderItems(malformedItems, { isStreaming: false })).not.toThrow();
    expect(buildTranscriptRenderItems(malformedItems, { isStreaming: false }))
      .toEqual(malformedItems.map((item, index) => ({ type: 'source', item, originalIndex: index })));
  });

  it('ignores malformed text blocks without throwing during fold checks', () => {
    const malformedItems = [
      {
        type: 'message' as const,
        data: {
          id: 'assistant-1',
          role: 'assistant' as const,
          blocks: [{ type: 'text' }],
        },
      },
      {
        type: 'message' as const,
        data: {
          id: 'assistant-2',
          role: 'assistant' as const,
          blocks: [{ type: 'text', html: '<p>final answer</p>' }],
        },
      },
    ] as unknown as ChatListItem[];

    expect(() => buildTranscriptRenderItems(malformedItems, { isStreaming: false })).not.toThrow();
    expect(buildTranscriptRenderItems(malformedItems, { isStreaming: false }))
      .toEqual(malformedItems.map((item, index) => ({ type: 'source', item, originalIndex: index })));
  });

  it('includes card-backed tools in process fold stats', () => {
    const items = [
      {
        type: 'message' as const,
        data: {
          id: 'assistant-1',
          role: 'assistant' as const,
          blocks: [
            {
              type: 'tool_group',
              collapsed: false,
              tools: [
                { id: 't1', name: 'codia_card_guide', args: {}, done: true, success: true },
                { id: 't2', name: 'show_card', args: {}, done: true, success: true },
                { id: 't3', name: 'read', args: { file_path: 'a.md' }, done: true, success: true },
              ],
            },
          ],
        },
      },
      {
        type: 'message' as const,
        data: {
          id: 'assistant-2',
          role: 'assistant' as const,
          blocks: [
            {
              type: 'tool_group',
              collapsed: false,
              tools: [{ id: 't4', name: 'media_generate-image', args: {}, done: true, success: true }],
            },
          ],
        },
      },
      {
        type: 'message' as const,
        data: {
          id: 'assistant-3',
          role: 'assistant' as const,
          blocks: [
            {
              type: 'tool_group',
              collapsed: false,
              tools: [{ id: 't5', name: 'workflow', args: {}, done: true, success: true }],
            },
          ],
        },
      },
    ] as unknown as ChatListItem[];

    const rendered = buildTranscriptRenderItems(items, { isStreaming: false });

    expect(rendered).toHaveLength(1);
    expect(rendered[0].type).toBe('process_fold');
    if (rendered[0].type === 'process_fold') {
      expect(rendered[0].stats.toolCount).toBe(5);
    }
  });
});
