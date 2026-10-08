import { describe, expect, it } from 'vitest';
import { buildItemsFromHistory } from '../../utils/history-builder';

type HistoryBuilderInput = Parameters<typeof buildItemsFromHistory>[0];

describe('buildItemsFromHistory assistant meta blocks', () => {
  it('renders leaked reasoning and plain MOOD as collapsible blocks', () => {
    const content = [
      'The user is asking me to think deeply, but no actual topic was given.',
      'I should ask for the missing topic.',
      '',
      'MOOD. Waiting for a concrete subject.',
      '',
      'What topic should I think about?',
    ].join('\n');

    const items = buildItemsFromHistory({
      messages: [{ role: 'assistant', content }],
    });

    expect(items).toHaveLength(1);
    const msg = items[0].type === 'message' ? items[0].data : null;
    expect(msg?.blocks?.[0]).toMatchObject({ type: 'thinking' });
    expect(msg?.blocks?.[1]).toMatchObject({
      type: 'mood',
      yuan: 'gsap',
      text: 'Waiting for a concrete subject.',
    });
    expect(msg?.blocks?.[2]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(msg?.blocks?.[2])).not.toContain('The user is asking me');
  });

  it('renders a bare MOOD heading with the upstream compact block layout', () => {
    const content = [
      'MOOD',
      '',
      '核心材料齐全，门禁通过。开始执行完整工作流。',
      '',
      '这里是正式回答。',
    ].join('\n');

    const items = buildItemsFromHistory({
      messages: [{ role: 'assistant', content }],
    });

    expect(items).toHaveLength(1);
    const msg = items[0].type === 'message' ? items[0].data : null;
    expect(msg?.blocks?.[0]).toMatchObject({
      type: 'mood',
      yuan: 'gsap',
      text: '核心材料齐全，门禁通过。开始执行完整工作流。',
    });
    expect(msg?.blocks?.[1]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(msg?.blocks?.[1])).not.toContain('<h1>MOOD</h1>');
  });

  it('renders reflect tags as a sealed thinking block instead of mood', () => {
    const items = buildItemsFromHistory({
      messages: [{ role: 'assistant', content: '<reflect>hidden reflection</reflect>\nvisible answer' }],
    });

    expect(items).toHaveLength(1);
    const msg = items[0].type === 'message' ? items[0].data : null;
    expect(msg?.blocks?.[0]).toMatchObject({
      type: 'thinking',
      content: 'hidden reflection',
      sealed: true,
    });
    expect(msg?.blocks?.[1]).toMatchObject({ type: 'text' });
    expect(msg?.blocks?.some(block => block.type === 'mood')).toBe(false);
  });

  it('keeps untagged internal tool planning out of visible assistant text', () => {
    const content = [
      '`office-documents` skill... wait, did the system prompt say only use specific tools?',
      'Actually, many environments handle `.docx` and `.xlsx` through a backend reader.',
      'Current files:',
      '1. C:\\Users\\root\\.gsap\\uploads\\test.xlsx',
      'I will attempt to read both now using their verified paths.',
    ].join('\n');

    const items = buildItemsFromHistory({
      messages: [{ role: 'assistant', content }],
    });

    expect(items).toHaveLength(1);
    const msg = items[0].type === 'message' ? items[0].data : null;
    expect(msg?.blocks?.[0]).toMatchObject({ type: 'thinking' });
    expect(msg?.blocks?.some(block => block.type === 'text')).toBe(false);
  });

  it('renders bash invoke tags as collapsed invoke blocks and keeps visible text', () => {
    const items = buildItemsFromHistory({
      messages: [{
        role: 'assistant',
        content: 'Before\n<invoke name=“bash”>npm run typecheck</invoke>\nAfter',
      }],
    });

    const msg = items[0].type === 'message' ? items[0].data : null;
    expect(msg?.blocks?.[0]).toMatchObject({ type: 'text' });
    expect(msg?.blocks?.[1]).toMatchObject({
      type: 'invoke',
      name: 'bash',
      content: 'npm run typecheck',
    });
    expect(msg?.blocks?.[2]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(msg?.blocks)).not.toContain('<invoke');
  });

  it('drops malformed sideband blocks before they reach the chat renderer', () => {
    const items = buildItemsFromHistory({
      messages: [{ role: 'assistant', content: 'Visible answer' }],
      blocks: [
        null,
        {},
        { type: '', afterIndex: 0 },
        { type: 'file', afterIndex: 0, label: 'missing-path.png', ext: 'png' },
        { type: 'plugin_card', afterIndex: 0, card: { pluginId: 'missing-route' } },
        { type: 'text', afterIndex: 0, html: '<p>valid sideband text</p>' },
      ],
    } as unknown as HistoryBuilderInput);

    const msg = items[0].type === 'message' ? items[0].data : null;
    expect(msg?.blocks?.map(block => block.type)).toEqual(['text', 'text']);
    expect(msg?.blocks?.[1]).toMatchObject({ type: 'text', html: '<p>valid sideband text</p>' });
  });

  it('drops failed deferred-result interludes when the same image task already has a failed media card', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'a1',
        role: 'assistant',
        content: '来了，薄雾古桥那一张。',
      }],
      blocks: [
        {
          afterIndex: 0,
          type: 'media_generation',
          taskId: 'img-failed-1',
          kind: 'image',
          status: 'failed',
          reason: 'API error 524',
        },
        {
          afterIndex: 0,
          type: 'interlude',
          id: 'deferred:img-failed-1:failed',
          variant: 'deferred_result',
          taskId: 'img-failed-1',
          status: 'failed',
          sourceKind: 'tool',
          sourceLabel: 'image generation',
          text: 'G-SAP did not receive a result from image generation',
          detailMarkdown: 'API error 524',
        },
      ],
    } as unknown as HistoryBuilderInput);

    expect(items).toHaveLength(1);
    expect(items.some((item) => item.type === 'interlude')).toBe(false);
    const msg = items[0].type === 'message' ? items[0].data : null;
    expect(msg?.blocks?.filter((block) => block.type === 'media_generation')).toHaveLength(1);
    expect(msg?.blocks?.find((block) => block.type === 'media_generation')).toMatchObject({
      type: 'media_generation',
      taskId: 'img-failed-1',
      status: 'failed',
      reason: 'API error 524',
    });
  });

  it('drops duplicate assistant messages that replay the same completed media task', () => {
    const items = buildItemsFromHistory({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'Submitted image generation.',
        },
        {
          id: 'a2',
          role: 'assistant',
          content: 'Submitted image generation.',
        },
      ],
      blocks: [
        {
          afterIndex: 0,
          type: 'file',
          replacesTaskId: 'img-task-duplicate',
          fileId: 'sf-duplicate',
          filePath: 'E:/generated/cat.png',
          label: 'cat.png',
          ext: 'png',
          mime: 'image/png',
          kind: 'image',
        },
        {
          afterIndex: 1,
          type: 'file',
          replacesTaskId: 'img-task-duplicate',
          fileId: 'sf-duplicate',
          filePath: 'E:/generated/cat.png',
          label: 'cat.png',
          ext: 'png',
          mime: 'image/png',
          kind: 'image',
        },
      ],
    } as unknown as HistoryBuilderInput);

    const assistantItems = items
      .filter((item) => item.type === 'message' && item.data.role === 'assistant');
    expect(assistantItems).toHaveLength(1);
    const assistant = assistantItems[0];
    expect(assistant?.type).toBe('message');
    if (!assistant || assistant.type !== 'message') return;
    expect(assistant.data.id).toBe('a1');
    expect(assistant.data.blocks?.filter((block) => block.type === 'file')).toHaveLength(1);
    expect(assistant.data.blocks?.find((block) => block.type === 'file')).toMatchObject({
      type: 'file',
      fileId: 'sf-duplicate',
      replacesTaskId: 'img-task-duplicate',
    });
  });
});
