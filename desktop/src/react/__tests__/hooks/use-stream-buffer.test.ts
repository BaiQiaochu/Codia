import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamBufferManager, streamFlushIntervalForLength } from '../../hooks/use-stream-buffer';
import { useStore } from '../../stores';
import type { ContentBlock } from '../../stores/chat-types';

const SESSION_PATH = 'sessions/thinking-stream.jsonl';

function getThinkingBlock(): Extract<ContentBlock, { type: 'thinking' }> | undefined {
  const item = useStore.getState().chatSessions[SESSION_PATH]?.items[0];
  if (!item || item.type !== 'message') return undefined;
  return item.data.blocks?.find((block): block is Extract<ContentBlock, { type: 'thinking' }> =>
    block.type === 'thinking',
  );
}

function getToolGroups(): Array<Extract<ContentBlock, { type: 'tool_group' }>> {
  const item = useStore.getState().chatSessions[SESSION_PATH]?.items[0];
  if (!item || item.type !== 'message') return [];
  return (item.data.blocks || []).filter((block): block is Extract<ContentBlock, { type: 'tool_group' }> =>
    block.type === 'tool_group',
  );
}

describe('streamBufferManager thinking streaming', () => {
  it('reduces update frequency as streamed replies grow without dropping the final flush', () => {
    expect(streamFlushIntervalForLength(1_000)).toBeLessThan(streamFlushIntervalForLength(40_000));
    expect(streamFlushIntervalForLength(40_000)).toBeLessThan(streamFlushIntervalForLength(600_000));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:00:00Z'));
    streamBufferManager.clearAll();
    useStore.setState({
      chatSessions: {
        [SESSION_PATH]: { items: [], hasMore: false, loadingMore: false },
      },
      sessions: [],
      agents: [],
      agentYuan: 'codia',
      runtimeTimelineByTrace: {},
      runtimeTimelineTraceIdsBySession: {},
      runtimeDiagnosticsById: {},
      runtimeDiagnosticIds: [],
      runtimeRecords: [],
      toasts: [],
    });
  });

  afterEach(() => {
    streamBufferManager.clearAll();
    vi.useRealTimers();
  });

  it('keeps sequential completed tools in one group during a turn', () => {
    streamBufferManager.handle({ type: 'tool_start', sessionPath: SESSION_PATH, name: 'read', args: { path: 'a.md' } });
    streamBufferManager.handle({ type: 'tool_end', sessionPath: SESSION_PATH, name: 'read', success: true });
    streamBufferManager.handle({ type: 'tool_start', sessionPath: SESSION_PATH, name: 'search', args: { query: 'needle' } });
    streamBufferManager.handle({ type: 'tool_end', sessionPath: SESSION_PATH, name: 'search', success: true });

    const groups = getToolGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].tools.map(tool => tool.name)).toEqual(['read', 'search']);
    expect(groups[0].collapsed).toBe(true);
  });

  it('starts a new assistant message when a new stream arrives before the previous turn_end', () => {
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      streamId: 'stream-a',
      delta: '第一轮回复',
    });
    vi.advanceTimersByTime(250);

    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      streamId: 'stream-b',
      delta: '第二轮回复',
    });
    vi.advanceTimersByTime(250);

    const messages = useStore.getState().chatSessions[SESSION_PATH].items
      .filter((item) => item.type === 'message')
      .map((item) => item.type === 'message' ? item.data : null)
      .filter(Boolean);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.blocks?.[0]).toMatchObject({ type: 'text', source: '第一轮回复' });
    expect(messages[1]?.blocks?.[0]).toMatchObject({ type: 'text', source: '第二轮回复' });
  });

  it('keeps in-flight buffers on the stable session id when the locator path changes', () => {
    useStore.setState({
      currentSessionId: 'sess-moved',
      currentSessionPath: 'sessions/moved.jsonl',
      sessions: [{ path: 'sessions/moved.jsonl', sessionId: 'sess-moved' }],
      sessionLocatorsById: { 'sess-moved': { path: 'sessions/moved.jsonl' } },
      chatSessions: {
        'sess-moved': { items: [], hasMore: false, loadingMore: false },
      },
    } as never);

    streamBufferManager.handle({
      type: 'text_delta',
      sessionId: 'sess-moved',
      sessionPath: 'sessions/original.jsonl',
      delta: 'answer after move',
    });
    vi.advanceTimersByTime(250);
    streamBufferManager.finishTurn('sessions/moved.jsonl', 'sess-moved');

    const items = useStore.getState().chatSessions['sess-moved']?.items || [];
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.type).toBe('message');
    if (item.type !== 'message') return;
    expect(item.data.blocks?.[0]).toMatchObject({
      type: 'text',
      source: 'answer after move',
    });
    expect(useStore.getState().chatSessions['sessions/original.jsonl']).toBeUndefined();
  });

  it('starts a new assistant message after a new user message even when streamId is missing', () => {
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      delta: '第一轮回复',
    });
    vi.advanceTimersByTime(250);

    useStore.getState().appendItem(SESSION_PATH, {
      type: 'message',
      data: { id: 'user-next', role: 'user', text: '继续处理' },
    });
    streamBufferManager.beginUserTurn(SESSION_PATH);

    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      delta: '第二轮回复',
    });
    vi.advanceTimersByTime(250);

    const messages = useStore.getState().chatSessions[SESSION_PATH].items
      .filter((item) => item.type === 'message')
      .map((item) => item.type === 'message' ? item.data : null)
      .filter(Boolean);

    expect(messages.map((message) => message?.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(messages[0]?.blocks?.[0]).toMatchObject({ type: 'text', source: '第一轮回复' });
    expect(messages[2]?.blocks?.[0]).toMatchObject({ type: 'text', source: '第二轮回复' });
  });

  it('folds untagged internal tool-planning deltas into a thinking block', () => {
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      delta: [
        '`office-documents` skill... wait, did the system prompt say only use specific tools?',
        'Actually, many environments handle `.docx` through a backend reader.',
        'Current files:',
        '1. C:\\Users\\root\\.codia\\uploads\\test.xlsx',
        'I will attempt to read both now using their verified paths.',
      ].join('\n'),
    });
    vi.advanceTimersByTime(250);

    const item = useStore.getState().chatSessions[SESSION_PATH].items[0];
    expect(item.type).toBe('message');
    if (item.type !== 'message') return;
    expect(item.data.blocks?.[0]).toMatchObject({
      type: 'thinking',
      sealed: true,
    });
    expect(item.data.blocks?.some((block) => block.type === 'text')).toBe(false);
  });

  it('does not continue an older assistant message after a later user message is appended', () => {
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      delta: 'first answer',
    });
    vi.advanceTimersByTime(250);

    useStore.getState().appendItem(SESSION_PATH, {
      type: 'message',
      data: { id: 'user-next-without-reset', role: 'user', text: 'continue' },
    });

    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      delta: 'second answer',
    });
    vi.advanceTimersByTime(250);

    const messages = useStore.getState().chatSessions[SESSION_PATH].items
      .filter((item) => item.type === 'message')
      .map((item) => item.type === 'message' ? item.data : null)
      .filter(Boolean);

    expect(messages.map((message) => message?.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(messages[0]?.blocks?.[0]).toMatchObject({ type: 'text', source: 'first answer' });
    expect(messages[2]?.blocks?.[0]).toMatchObject({ type: 'text', source: 'second answer' });
  });

  it('does not append a new turn to the previous assistant after status false finishes the target', () => {
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      delta: 'first answer',
    });
    vi.advanceTimersByTime(250);

    streamBufferManager.finishTurn(SESSION_PATH);
    useStore.getState().appendItem(SESSION_PATH, {
      type: 'message',
      data: { id: 'user-after-status-false', role: 'user', text: 'next prompt' },
    });

    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      delta: 'second answer',
    });
    vi.advanceTimersByTime(250);

    const messages = useStore.getState().chatSessions[SESSION_PATH].items
      .filter((item) => item.type === 'message')
      .map((item) => item.type === 'message' ? item.data : null)
      .filter(Boolean);

    expect(messages.map((message) => message?.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(messages[0]?.blocks?.[0]).toMatchObject({ type: 'text', source: 'first answer' });
    expect(messages[2]?.blocks?.[0]).toMatchObject({ type: 'text', source: 'second answer' });
  });

  it('does not attach later content blocks to an older empty assistant shell after a user turn', () => {
    streamBufferManager.handle({
      type: 'generation_start',
      sessionPath: SESSION_PATH,
      turnTraceId: 'turn-empty',
    });

    useStore.getState().appendItem(SESSION_PATH, {
      type: 'message',
      data: { id: 'user-after-empty-shell', role: 'user', text: 'new request' },
    });
    streamBufferManager.beginUserTurn(SESSION_PATH);

    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: SESSION_PATH,
      block: {
        type: 'file',
        filePath: 'E:/generated/report.md',
        label: 'report.md',
        ext: 'md',
      },
    });

    const messages = useStore.getState().chatSessions[SESSION_PATH].items
      .filter((item) => item.type === 'message')
      .map((item) => item.type === 'message' ? item.data : null)
      .filter(Boolean);

    expect(messages.map((message) => message?.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(messages[0]?.blocks || []).toHaveLength(0);
    expect(messages[2]?.blocks?.[0]).toMatchObject({
      type: 'file',
      filePath: 'E:/generated/report.md',
    });
  });

  it('starts a new assistant message when turnTraceId changes even without streamId', () => {
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      turnTraceId: 'turn-a',
      delta: 'first answer',
    });
    vi.advanceTimersByTime(250);

    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: SESSION_PATH,
      turnTraceId: 'turn-b',
      delta: 'second answer',
    });
    vi.advanceTimersByTime(250);

    const messages = useStore.getState().chatSessions[SESSION_PATH].items
      .filter((item) => item.type === 'message')
      .map((item) => item.type === 'message' ? item.data : null)
      .filter(Boolean);

    expect(messages.map((message) => message?.turnTraceId)).toEqual(['turn-a', 'turn-b']);
    expect(messages[0]?.blocks?.[0]).toMatchObject({ type: 'text', source: 'first answer' });
    expect(messages[1]?.blocks?.[0]).toMatchObject({ type: 'text', source: 'second answer' });
  });

  it('flushes thinking deltas before thinking_end so long thoughts do not appear interrupted', () => {
    streamBufferManager.handle({ type: 'thinking_start', sessionPath: SESSION_PATH });
    streamBufferManager.handle({
      type: 'thinking_delta',
      sessionPath: SESSION_PATH,
      delta: '第一段很长的思考内容，还没有收到结束事件。',
    });

    vi.advanceTimersByTime(250);

    const block = getThinkingBlock();
    expect(block?.content).toContain('第一段很长的思考内容');
    expect(block?.sealed).toBe(false);
  });

  it('attaches turnTraceId to the streamed assistant message and records timeline events', () => {
    streamBufferManager.handle({ type: 'turn_queued', sessionPath: SESSION_PATH, turnTraceId: 'turn-a' });
    streamBufferManager.handle({
      type: 'model_route',
      sessionPath: SESSION_PATH,
      turnTraceId: 'turn-a',
      provider: 'openai',
      model: 'gpt-5.5',
    });
    streamBufferManager.handle({ type: 'thinking_start', sessionPath: SESSION_PATH, turnTraceId: 'turn-a' });
    streamBufferManager.handle({ type: 'tool_start', sessionPath: SESSION_PATH, turnTraceId: 'turn-a', name: 'read' });
    streamBufferManager.handle({ type: 'tool_end', sessionPath: SESSION_PATH, turnTraceId: 'turn-a', name: 'read', success: true });
    streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH, turnTraceId: 'turn-a' });

    const item = useStore.getState().chatSessions[SESSION_PATH].items[0];
    expect(item.type).toBe('message');
    if (item.type !== 'message') return;
    expect(item.data.turnTraceId).toBe('turn-a');
    expect(useStore.getState().runtimeTimelineByTrace['turn-a'].status).toBe('completed');
    expect(useStore.getState().runtimeTimelineByTrace['turn-a'].events.map(event => event.type)).toEqual([
      'queued',
      'model_route',
      'thinking',
      'tool_call',
      'completed',
    ]);
  });

  it('records failed turns from stream errors and auto-generates a trace id when legacy events omit one', () => {
    streamBufferManager.handle({ type: 'thinking_start', sessionPath: SESSION_PATH });
    streamBufferManager.handle({ type: 'error', sessionPath: SESSION_PATH, message: 'model call failed' });

    const item = useStore.getState().chatSessions[SESSION_PATH].items[0];
    expect(item.type).toBe('message');
    if (item.type !== 'message') return;
    expect(item.data.turnTraceId).toMatch(/^turn-/);
    const trace = useStore.getState().runtimeTimelineByTrace[item.data.turnTraceId!];
    expect(trace.status).toBe('failed');
    expect(trace.events[trace.events.length - 1]?.type).toBe('failed');
    const diagnostics = Object.values(useStore.getState().runtimeDiagnosticsById);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      traceId: item.data.turnTraceId,
      category: 'model',
      severity: 'error',
      userMessage: '模型调用失败，已保留诊断信息。',
    });
    expect(useStore.getState().toasts[0]).toMatchObject({
      text: '模型调用失败，已保留诊断信息。',
      type: 'error',
      diagnosticId: diagnostics[0].id,
    });
  });

  it('replaces pending media generation placeholders with resolved file blocks', () => {
    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: SESSION_PATH,
      block: {
        type: 'media_generation',
        taskId: 'img-task-1',
        kind: 'image',
        status: 'pending',
        prompt: 'Generate a mockup',
      },
    });

    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: SESSION_PATH,
      block: {
        type: 'file',
        filePath: 'E:/generated/mockup.png',
        label: 'mockup.png',
        ext: 'png',
        replacesTaskId: 'img-task-1',
      },
    });

    const item = useStore.getState().chatSessions[SESSION_PATH]?.items[0];
    expect(item?.type).toBe('message');
    if (!item || item.type !== 'message') return;

    expect(item.data.blocks).toEqual([
      expect.objectContaining({
        type: 'file',
        filePath: 'E:/generated/mockup.png',
        replacesTaskId: 'img-task-1',
      }),
    ]);
  });

    it('replaces pending media generation placeholders from deferred_result events', () => {
    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: SESSION_PATH,
      block: {
        type: 'media_generation',
        taskId: 'img-task-deferred',
        kind: 'image',
        status: 'pending',
        prompt: 'Generate a portrait',
      },
    });

    streamBufferManager.handle({
      type: 'deferred_result',
      sessionPath: SESSION_PATH,
      taskId: 'img-task-deferred',
      status: 'success',
      meta: { type: 'image-generation', mediaKind: 'image' },
      result: {
        sessionFiles: [{
          id: 'sf-generated',
          filePath: 'E:/generated/portrait.png',
          label: 'portrait.png',
          ext: 'png',
          mime: 'image/png',
          kind: 'image',
        }],
      },
    });

    const item = useStore.getState().chatSessions[SESSION_PATH]?.items[0];
    expect(item?.type).toBe('message');
    if (!item || item.type !== 'message') return;

      expect(item.data.blocks).toEqual([
        expect.objectContaining({
          type: 'file',
          fileId: 'sf-generated',
          filePath: 'E:/generated/portrait.png',
          replacesTaskId: 'img-task-deferred',
        }),
      ]);
      expect(useStore.getState().sessionRegistryFilesByPath[SESSION_PATH]?.[0]).toMatchObject({
        fileId: 'sf-generated',
        filePath: 'E:/generated/portrait.png',
        label: 'portrait.png',
      });
    });

    it('replaces pending media generation placeholders from media_generation_end events with result files', () => {
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-end',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a card',
        },
      });

      streamBufferManager.handle({
        type: 'media_generation_end',
        sessionPath: SESSION_PATH,
        kind: 'image',
        taskId: 'img-task-end',
        success: true,
        result: {
          sessionFiles: [{
            id: 'sf-end',
            filePath: 'E:/generated/card.png',
            label: 'card.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
          }],
        },
      });

      const item = useStore.getState().chatSessions[SESSION_PATH]?.items[0];
      expect(item?.type).toBe('message');
      if (!item || item.type !== 'message') return;

      expect(item.data.blocks).toEqual([
        expect.objectContaining({
          type: 'file',
          fileId: 'sf-end',
          filePath: 'E:/generated/card.png',
          replacesTaskId: 'img-task-end',
        }),
      ]);
    });

    it('replaces pending media generation placeholders when deferred result only has files', () => {
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-files',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a fallback file',
        },
      });

      streamBufferManager.handle({
        type: 'deferred_result',
        sessionPath: SESSION_PATH,
        taskId: 'img-task-files',
        status: 'success',
        meta: { type: 'image-generation', mediaKind: 'image' },
        result: {
          files: ['E:/generated/fallback.png'],
        },
      });

      const item = useStore.getState().chatSessions[SESSION_PATH]?.items[0];
      expect(item?.type).toBe('message');
      if (!item || item.type !== 'message') return;

      expect(item.data.blocks).toEqual([
        expect.objectContaining({
          type: 'file',
          filePath: 'E:/generated/fallback.png',
          label: 'fallback.png',
          replacesTaskId: 'img-task-files',
        }),
      ]);
    });

    it('keeps deferred interlude beside resolved media files without duplicating the interlude', () => {
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-interlude',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a visual',
        },
      });

      const interlude = {
        type: 'interlude' as const,
        id: 'deferred:img-task-interlude:success',
        variant: 'deferred_result',
        taskId: 'img-task-interlude',
        status: 'success',
        sourceKind: 'tool',
        sourceLabel: 'image generation',
        text: 'Codia received a result from image generation',
        detailMarkdown: 'Generated files:\n- visual.png (image)',
      };

      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: interlude,
      });
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: interlude,
      });
      streamBufferManager.handle({
        type: 'deferred_result',
        sessionPath: SESSION_PATH,
        taskId: 'img-task-interlude',
        status: 'success',
        meta: { type: 'image-generation', mediaKind: 'image' },
        result: {
          sessionFiles: [{
            id: 'sf-interlude',
            filePath: 'E:/generated/visual.png',
            label: 'visual.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
          }],
        },
      });

      const items = useStore.getState().chatSessions[SESSION_PATH]?.items || [];
      expect(items.map((item) => item.type)).toEqual(['message', 'interlude']);
      expect(items[1]).toMatchObject({
        type: 'interlude',
        data: {
          taskId: 'img-task-interlude',
        },
      });
      const item = items[0];
      expect(item?.type).toBe('message');
      if (!item || item.type !== 'message') return;

      expect(item.data.blocks?.map((block) => block.type)).toEqual(['file']);
      expect(item.data.blocks?.[0]).toMatchObject({
        type: 'file',
        fileId: 'sf-interlude',
        filePath: 'E:/generated/visual.png',
        replacesTaskId: 'img-task-interlude',
      });
    });

    it('inserts late deferred interludes next to media results after the turn has ended', () => {
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-late-interlude',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a quiet card',
        },
      });
      streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH });

      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'interlude',
          id: 'deferred:img-task-late-interlude:success',
          variant: 'deferred_result',
          taskId: 'img-task-late-interlude',
          status: 'success',
          sourceKind: 'tool',
          sourceLabel: 'image generation',
          text: 'Codia received a result from image generation',
          detailMarkdown: 'Generated files:\n- quiet.png',
        },
      });
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'file',
          replacesTaskId: 'img-task-late-interlude',
          fileId: 'sf-late-interlude',
          filePath: 'E:/generated/quiet.png',
          label: 'quiet.png',
          ext: 'png',
          mime: 'image/png',
          kind: 'image',
        },
      });

      const items = useStore.getState().chatSessions[SESSION_PATH]?.items || [];
      expect(items.map((item) => item.type)).toEqual(['message', 'interlude']);
      expect(items[1]).toMatchObject({
        type: 'interlude',
        data: {
          taskId: 'img-task-late-interlude',
        },
      });
      const assistantItems = items
        .filter((item) => item.type === 'message' && item.data.role === 'assistant');
      expect(assistantItems).toHaveLength(1);
      const assistant = assistantItems?.[0];
      expect(assistant?.type).toBe('message');
      if (!assistant || assistant.type !== 'message') return;

      expect(assistant.data.blocks?.map((block) => block.type)).toEqual(['file']);
      expect(assistant.data.blocks?.[0]).toMatchObject({
        type: 'file',
        fileId: 'sf-late-interlude',
        filePath: 'E:/generated/quiet.png',
        replacesTaskId: 'img-task-late-interlude',
      });
    });

    it('does not show both failed media card and failed deferred-result interlude for the same image task', () => {
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-failed-interlude',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a watercolor scene',
        },
      });
      streamBufferManager.handle({
        type: 'text_delta',
        sessionPath: SESSION_PATH,
        delta: '来了一张水墨风。',
      });
      vi.advanceTimersByTime(250);
      streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH });

      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'interlude',
          id: 'deferred:img-task-failed-interlude:failed',
          variant: 'deferred_result',
          taskId: 'img-task-failed-interlude',
          status: 'failed',
          sourceKind: 'tool',
          sourceLabel: 'image generation',
          text: 'Codia did not receive a result from image generation',
          detailMarkdown: 'API error 524',
        },
      });
      streamBufferManager.handle({
        type: 'deferred_result',
        sessionPath: SESSION_PATH,
        taskId: 'img-task-failed-interlude',
        status: 'failed',
        reason: 'API error 524',
        meta: { type: 'image-generation', mediaKind: 'image' },
      });

      const items = useStore.getState().chatSessions[SESSION_PATH]?.items || [];
      expect(items.filter((item) => item.type === 'interlude')).toHaveLength(0);
      const assistantItems = items
        .filter((item) => item.type === 'message' && item.data.role === 'assistant');
      expect(assistantItems).toHaveLength(1);
      const assistant = assistantItems[0];
      expect(assistant?.type).toBe('message');
      if (!assistant || assistant.type !== 'message') return;
      expect(assistant.data.blocks?.filter((block) => block.type === 'media_generation')).toHaveLength(1);
      expect(assistant.data.blocks?.find((block) => block.type === 'media_generation')).toMatchObject({
        type: 'media_generation',
        taskId: 'img-task-failed-interlude',
        status: 'failed',
        reason: 'API error 524',
      });
    });

    it('drops replayed media generation placeholders after the task already resolved', () => {
      streamBufferManager.handle({
        type: 'text_delta',
        sessionPath: SESSION_PATH,
        delta: 'Submitted image generation.',
      });
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-replayed',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a cat',
        },
      });
      vi.advanceTimersByTime(250);
      streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH });

      const resultEvent = {
        type: 'deferred_result',
        sessionPath: SESSION_PATH,
        taskId: 'img-task-replayed',
        status: 'success',
        meta: { type: 'image-generation', mediaKind: 'image' },
        result: {
          sessionFiles: [{
            id: 'sf-replayed',
            filePath: 'E:/generated/cat.png',
            label: 'cat.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
          }],
        },
      };
      streamBufferManager.handle(resultEvent);

      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-replayed',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a cat',
        },
      });
      streamBufferManager.handle(resultEvent);

      const assistantItems = (useStore.getState().chatSessions[SESSION_PATH]?.items || [])
        .filter((item) => item.type === 'message' && item.data.role === 'assistant');
      expect(assistantItems).toHaveLength(1);
      const assistant = assistantItems[0];
      expect(assistant?.type).toBe('message');
      if (!assistant || assistant.type !== 'message') return;
      expect(assistant.data.blocks?.filter((block) => block.type === 'file')).toHaveLength(1);
      expect(assistant.data.blocks?.find((block) => block.type === 'file')).toMatchObject({
        type: 'file',
        fileId: 'sf-replayed',
        replacesTaskId: 'img-task-replayed',
      });
    });

    it('reuses the resolved media message when a trailing deferred interlude is followed by replayed assistant text', () => {
      const assistantText = 'Image generation has been submitted.';
      streamBufferManager.handle({
        type: 'text_delta',
        sessionPath: SESSION_PATH,
        delta: assistantText,
      });
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-trailing-replay',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a fantasy scene',
        },
      });
      vi.advanceTimersByTime(250);
      streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH });

      streamBufferManager.handle({
        type: 'deferred_result',
        sessionPath: SESSION_PATH,
        taskId: 'img-task-trailing-replay',
        status: 'success',
        meta: { type: 'image-generation', mediaKind: 'image' },
        result: {
          sessionFiles: [{
            id: 'sf-trailing-replay',
            filePath: 'E:/generated/fantasy.png',
            label: 'fantasy.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
          }],
        },
      });

      useStore.getState().appendItem(SESSION_PATH, {
        type: 'interlude',
        id: 'deferred:img-task-trailing-replay:success',
        data: {
          type: 'interlude',
          id: 'deferred:img-task-trailing-replay:success',
          variant: 'deferred_result',
          taskId: 'img-task-trailing-replay',
          status: 'success',
          sourceKind: 'tool',
          sourceLabel: 'image generation',
          text: 'Codia received a result from image generation',
          detailMarkdown: 'Generated files:\n- fantasy.png',
        },
      });

      streamBufferManager.handle({
        type: 'text_delta',
        sessionPath: SESSION_PATH,
        delta: assistantText,
      });
      vi.advanceTimersByTime(250);
      streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH });

      const assistantItems = (useStore.getState().chatSessions[SESSION_PATH]?.items || [])
        .filter((item) => item.type === 'message' && item.data.role === 'assistant');
      expect(assistantItems).toHaveLength(1);
      const assistant = assistantItems[0];
      expect(assistant?.type).toBe('message');
      if (!assistant || assistant.type !== 'message') return;
      expect(assistant.data.blocks?.filter((block) => block.type === 'file')).toHaveLength(1);
      expect(assistant.data.blocks?.filter((block) => block.type === 'text')).toHaveLength(1);
      expect(assistant.data.blocks?.find((block) => block.type === 'file')).toMatchObject({
        type: 'file',
        fileId: 'sf-trailing-replay',
        replacesTaskId: 'img-task-trailing-replay',
      });
    });

    it('reuses the resolved media message when a leading deferred interlude is followed by replayed assistant text', () => {
      const assistantText = 'Image generation has been submitted.';
      streamBufferManager.handle({
        type: 'text_delta',
        sessionPath: SESSION_PATH,
        delta: assistantText,
      });
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-leading-replay',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a fantasy scene',
        },
      });
      vi.advanceTimersByTime(250);
      streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH });

      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'interlude',
          id: 'deferred:img-task-leading-replay:success',
          variant: 'deferred_result',
          taskId: 'img-task-leading-replay',
          status: 'success',
          sourceKind: 'tool',
          sourceLabel: 'image generation',
          text: 'Codia received a result from image generation',
          detailMarkdown: 'Generated files:\n- fantasy.png',
        },
      });
      streamBufferManager.handle({
        type: 'deferred_result',
        sessionPath: SESSION_PATH,
        taskId: 'img-task-leading-replay',
        status: 'success',
        meta: { type: 'image-generation', mediaKind: 'image' },
        result: {
          sessionFiles: [{
            id: 'sf-leading-replay',
            filePath: 'E:/generated/fantasy.png',
            label: 'fantasy.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
          }],
        },
      });

      expect((useStore.getState().chatSessions[SESSION_PATH]?.items || []).map((item) => item.type))
        .toEqual(['message', 'interlude']);

      streamBufferManager.handle({
        type: 'text_delta',
        sessionPath: SESSION_PATH,
        delta: assistantText,
      });
      vi.advanceTimersByTime(250);
      streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH });

      const assistantItems = (useStore.getState().chatSessions[SESSION_PATH]?.items || [])
        .filter((item) => item.type === 'message' && item.data.role === 'assistant');
      expect(assistantItems).toHaveLength(1);
      const assistant = assistantItems[0];
      expect(assistant?.type).toBe('message');
      if (!assistant || assistant.type !== 'message') return;
      expect(assistant.data.blocks?.filter((block) => block.type === 'file')).toHaveLength(1);
      expect(assistant.data.blocks?.filter((block) => block.type === 'text')).toHaveLength(1);
      expect(assistant.data.blocks?.find((block) => block.type === 'file')).toMatchObject({
        type: 'file',
        fileId: 'sf-leading-replay',
        replacesTaskId: 'img-task-leading-replay',
      });
    });

    it('drops replayed assistant text that arrives after a media result but before the deferred interlude', () => {
      const assistantText = 'The image generation task is running.';
      streamBufferManager.handle({
        type: 'text_delta',
        sessionPath: SESSION_PATH,
        delta: assistantText,
      });
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-text-before-interlude',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a rainy street',
        },
      });
      vi.advanceTimersByTime(250);
      streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH });

      streamBufferManager.handle({
        type: 'deferred_result',
        sessionPath: SESSION_PATH,
        taskId: 'img-task-text-before-interlude',
        status: 'success',
        meta: { type: 'image-generation', mediaKind: 'image' },
        result: {
          sessionFiles: [{
            id: 'sf-text-before-interlude',
            filePath: 'E:/generated/rainy-street.png',
            label: 'rainy-street.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
          }],
        },
      });

      streamBufferManager.handle({
        type: 'text_delta',
        sessionPath: SESSION_PATH,
        delta: assistantText,
      });
      vi.advanceTimersByTime(250);
      streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH });

      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'interlude',
          id: 'deferred:img-task-text-before-interlude:success',
          variant: 'deferred_result',
          taskId: 'img-task-text-before-interlude',
          status: 'success',
          sourceKind: 'tool',
          sourceLabel: 'image generation',
          text: 'Codia received a result from image generation',
          detailMarkdown: 'Generated files:\n- rainy-street.png',
        },
      });

      const assistantItems = (useStore.getState().chatSessions[SESSION_PATH]?.items || [])
        .filter((item) => item.type === 'message' && item.data.role === 'assistant');
      expect(assistantItems).toHaveLength(1);
      const assistant = assistantItems[0];
      expect(assistant?.type).toBe('message');
      if (!assistant || assistant.type !== 'message') return;
      expect(assistant.data.blocks?.filter((block) => block.type === 'text')).toHaveLength(1);
      expect(assistant.data.blocks?.filter((block) => block.type === 'file')).toHaveLength(1);
      expect(assistant.data.blocks?.find((block) => block.type === 'file')).toMatchObject({
        type: 'file',
        fileId: 'sf-text-before-interlude',
        replacesTaskId: 'img-task-text-before-interlude',
      });
    });

    it('drops replayed assistant text and file block after the same media task already resolved', () => {
      const assistantText = 'The image generation task is running.';
      streamBufferManager.handle({
        type: 'text_delta',
        sessionPath: SESSION_PATH,
        delta: assistantText,
      });
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'media_generation',
          taskId: 'img-task-text-and-file-replay',
          kind: 'image',
          status: 'pending',
          prompt: 'Generate a rainy street',
        },
      });
      vi.advanceTimersByTime(250);
      streamBufferManager.handle({ type: 'turn_end', sessionPath: SESSION_PATH });

      streamBufferManager.handle({
        type: 'deferred_result',
        sessionPath: SESSION_PATH,
        taskId: 'img-task-text-and-file-replay',
        status: 'success',
        meta: { type: 'image-generation', mediaKind: 'image' },
        result: {
          sessionFiles: [{
            id: 'sf-text-and-file-replay',
            filePath: 'E:/generated/rainy-street.png',
            label: 'rainy-street.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
          }],
        },
      });

      streamBufferManager.handle({
        type: 'text_delta',
        sessionPath: SESSION_PATH,
        delta: assistantText,
      });
      vi.advanceTimersByTime(250);
      streamBufferManager.handle({
        type: 'content_block',
        sessionPath: SESSION_PATH,
        block: {
          type: 'file',
          fileId: 'sf-text-and-file-replay',
          filePath: 'E:/generated/rainy-street.png',
          label: 'rainy-street.png',
          ext: 'png',
          mime: 'image/png',
          kind: 'image',
          replacesTaskId: 'img-task-text-and-file-replay',
        },
      });

      const assistantItems = (useStore.getState().chatSessions[SESSION_PATH]?.items || [])
        .filter((item) => item.type === 'message' && item.data.role === 'assistant');
      expect(assistantItems).toHaveLength(1);
      const assistant = assistantItems[0];
      expect(assistant?.type).toBe('message');
      if (!assistant || assistant.type !== 'message') return;
      expect(assistant.data.blocks?.filter((block) => block.type === 'text')).toHaveLength(1);
      expect(assistant.data.blocks?.filter((block) => block.type === 'file')).toHaveLength(1);
      expect(assistant.data.blocks?.find((block) => block.type === 'file')).toMatchObject({
        type: 'file',
        fileId: 'sf-text-and-file-replay',
        replacesTaskId: 'img-task-text-and-file-replay',
      });
    });
  });
