import { describe, expect, it } from 'vitest';
import { buildProcessFoldSummary, buildTranscriptRenderItems } from '../../components/chat/process-fold';
import type { ChatListItem } from '../../stores/chat-types';

describe('process fold summary fallback', () => {
  it('uses Chinese fallback copy when runtime i18n is unavailable', () => {
    const text = buildProcessFoldSummary(
      { toolCount: 13, thinkingCount: 5, unsuccessfulCount: 1 },
      'G-SAP',
    );

    expect(text).toBe('G-SAP忙活了一阵子 · 13 个工具 · 5 次思考 · 1 次尝试未成功');
    expect(text).not.toMatch(/worked through|tools|thinking blocks|unsuccessful attempts/);
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

  it('excludes card-backed tools from process fold stats', () => {
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
                { id: 't1', name: 'hana_card_guide', args: {}, done: true, success: true },
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
      expect(rendered[0].stats.toolCount).toBe(1);
    }
  });
});
