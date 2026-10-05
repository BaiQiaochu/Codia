import { beforeEach, describe, expect, it } from 'vitest';
import { createChatSlice, type ChatSlice } from '../../stores/chat-slice';

function makeSlice(extras: Record<string, unknown> = {}): ChatSlice {
  let state: ChatSlice;
  const set = (partial: Partial<ChatSlice> | ((s: ChatSlice) => Partial<ChatSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  state = { ...createChatSlice(set as never, get), ...extras };
  return new Proxy({} as ChatSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('chat-slice branch truncation', () => {
  let slice: ChatSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('removes only the target session tail from the selected message onward', () => {
    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'old' } },
      { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [] } },
      { type: 'message', data: { id: 'u2', sourceEntryId: 'entry-u2', role: 'user', text: 'retry' } },
      { type: 'message', data: { id: 'a2', role: 'assistant', blocks: [] } },
    ], false);
    slice.initSession('/b', [
      { type: 'message', data: { id: 'b1', role: 'user', text: 'keep' } },
    ], false);

    expect(slice.truncateSessionFromMessage('/a', 'entry-u2')).toBe(true);

    expect(slice.chatSessions['/a']?.items.map(item => item.type === 'message' ? item.data.id : item.id)).toEqual(['u1', 'a1']);
    expect(slice.chatSessions['/b']?.items.map(item => item.type === 'message' ? item.data.id : item.id)).toEqual(['b1']);
  });

  it('returns false without changing state when the target message is missing', () => {
    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'old' } },
    ], false);

    expect(slice.truncateSessionFromMessage('/a', 'missing')).toBe(false);
    expect(slice.chatSessions['/a']?.items).toHaveLength(1);
  });

  it('stores session-owned UI state under the stable session id when a locator is known', () => {
    slice = makeSlice({
      sessions: [{ path: '/a', sessionId: 'sess-a' }],
      sessionLocatorsById: { 'sess-a': { path: '/a' } },
    });

    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'hello' } },
    ], false);
    slice.appendItem('/a', {
      type: 'message',
      data: { id: 'a1', role: 'assistant', blocks: [] },
    });
    slice.setSessionRegistryFiles('/a', [{ fileId: 'sf-1', filePath: '/tmp/a.md', label: 'a.md', ext: 'md' }]);
    slice.hideSessionResources('/a', ['resource-1']);
    slice.updateSessionModel('/a', { id: 'gpt-test', provider: 'openai', name: 'GPT Test' });
    slice.saveScrollPosition('/a', 42);

    expect(slice.chatSessions['sess-a']?.items).toHaveLength(2);
    expect(slice.chatSessions['/a']).toBeUndefined();
    expect(slice.sessionRegistryFilesByPath['sess-a']).toHaveLength(1);
    expect(slice.hiddenSessionResourceIdsByPath['sess-a']).toEqual(['resource-1']);
    expect(slice.sessionModelsByPath['sess-a']).toMatchObject({ id: 'gpt-test', provider: 'openai' });
    expect(slice.scrollPositions['sess-a']).toBe(42);

    slice.clearSession('/a');

    expect(slice.chatSessions['sess-a']).toBeUndefined();
    expect(slice.sessionRegistryFilesByPath['sess-a']).toBeUndefined();
    expect(slice.hiddenSessionResourceIdsByPath['sess-a']).toBeUndefined();
    expect(slice.sessionModelsByPath['sess-a']).toBeUndefined();
    expect(slice.scrollPositions['sess-a']).toBeUndefined();
  });

  it('stamps session message revision under the stable session id', () => {
    slice = makeSlice({
      sessions: [{ path: '/a', sessionId: 'sess-a' }],
      sessionLocatorsById: { 'sess-a': { path: '/a' } },
    });

    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'hello' } },
    ], false, '4096:1765500000000');
    slice.initSession('/b', [], false);

    expect(slice.chatSessions['sess-a']?.revision).toBe('4096:1765500000000');
    expect(slice.chatSessions['/a']).toBeUndefined();
    expect(slice.chatSessions['/b']?.revision).toBeNull();
  });

  it('removes duplicate completed media assistant replays when initializing a session', () => {
    const text = '图片已经生成好啦，会自动出现在下面的卡片里';

    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: '生成图片' } },
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          blocks: [
            { type: 'text', html: text, source: text },
            {
              type: 'file',
              fileId: 'sf-img',
              filePath: 'E:/generated/cat.png',
              label: 'cat.png',
              ext: 'png',
              mime: 'image/png',
              kind: 'image',
              replacesTaskId: 'img-task',
            },
          ],
        },
      },
      {
        type: 'interlude',
        id: 'deferred:img-task:success',
        data: {
          type: 'interlude',
          id: 'deferred:img-task:success',
          variant: 'deferred_result',
          taskId: 'img-task',
          status: 'success',
          sourceKind: 'tool',
          sourceLabel: 'image generation',
          text: 'G-SAP received a result from image generation',
        },
      },
      {
        type: 'message',
        data: {
          id: 'a2',
          role: 'assistant',
          blocks: [
            { type: 'text', html: text, source: text },
            {
              type: 'file',
              fileId: 'sf-img',
              filePath: 'E:/generated/cat.png',
              label: 'cat.png',
              ext: 'png',
              mime: 'image/png',
              kind: 'image',
              replacesTaskId: 'img-task',
            },
          ],
        },
      },
    ], false);

    const assistantItems = slice.chatSessions['/a']?.items
      .filter((item) => item.type === 'message' && item.data.role === 'assistant') || [];
    expect(assistantItems).toHaveLength(1);
    expect(slice.chatSessions['/a']?.items.map((item) => item.type === 'message' ? item.data.id : item.id))
      .toEqual(['u1', 'a1', 'deferred:img-task:success']);
  });

  it('removes duplicate completed media assistant replays when appending a session item', () => {
    const text = '图片已经生成好啦，会自动出现在下面的卡片里';

    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: '生成图片' } },
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          blocks: [
            { type: 'text', html: text, source: text },
            {
              type: 'file',
              fileId: 'sf-img',
              filePath: 'E:/generated/cat.png',
              label: 'cat.png',
              ext: 'png',
              mime: 'image/png',
              kind: 'image',
              replacesTaskId: 'img-task',
            },
          ],
        },
      },
    ], false);
    slice.appendItem('/a', {
      type: 'interlude',
      id: 'deferred:img-task:success',
      data: {
        type: 'interlude',
        id: 'deferred:img-task:success',
        variant: 'deferred_result',
        taskId: 'img-task',
        status: 'success',
        sourceKind: 'tool',
        sourceLabel: 'image generation',
        text: 'G-SAP received a result from image generation',
      },
    });
    slice.appendItem('/a', {
      type: 'message',
      data: {
        id: 'a2',
        role: 'assistant',
        blocks: [
          { type: 'text', html: text, source: text },
          {
            type: 'file',
            fileId: 'sf-img',
            filePath: 'E:/generated/cat.png',
            label: 'cat.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
            replacesTaskId: 'img-task',
          },
        ],
      },
    });

    const assistantItems = slice.chatSessions['/a']?.items
      .filter((item) => item.type === 'message' && item.data.role === 'assistant') || [];
    expect(assistantItems).toHaveLength(1);
    expect(slice.chatSessions['/a']?.items.map((item) => item.type === 'message' ? item.data.id : item.id))
      .toEqual(['u1', 'a1', 'deferred:img-task:success']);
  });

  it('removes duplicate media-only assistant replays when initializing a session', () => {
    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'generate image' } },
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          blocks: [
            { type: 'text', html: 'Image submitted.', source: 'Image submitted.' },
            {
              type: 'file',
              fileId: 'sf-img',
              filePath: 'E:/generated/cat.png',
              label: 'cat.png',
              ext: 'png',
              mime: 'image/png',
              kind: 'image',
              replacesTaskId: 'img-task',
            },
          ],
        },
      },
      {
        type: 'interlude',
        id: 'deferred:img-task:success',
        data: {
          type: 'interlude',
          id: 'deferred:img-task:success',
          variant: 'deferred_result',
          taskId: 'img-task',
          status: 'success',
          sourceKind: 'tool',
          sourceLabel: 'image generation',
          text: 'G-SAP received a result from image generation',
        },
      },
      {
        type: 'message',
        data: {
          id: 'a2',
          role: 'assistant',
          blocks: [
            {
              type: 'file',
              fileId: 'sf-img',
              filePath: 'E:/generated/cat.png',
              label: 'cat.png',
              ext: 'png',
              mime: 'image/png',
              kind: 'image',
              replacesTaskId: 'img-task',
            },
          ],
        },
      },
    ], false);

    const assistantItems = slice.chatSessions['/a']?.items
      .filter((item) => item.type === 'message' && item.data.role === 'assistant') || [];
    expect(assistantItems).toHaveLength(1);
    expect(slice.chatSessions['/a']?.items.map((item) => item.type === 'message' ? item.data.id : item.id))
      .toEqual(['u1', 'a1', 'deferred:img-task:success']);
  });

  it('removes duplicate media-only assistant replays when appending a session item', () => {
    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'generate image' } },
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          blocks: [
            { type: 'text', html: 'Image submitted.', source: 'Image submitted.' },
            {
              type: 'file',
              fileId: 'sf-img',
              filePath: 'E:/generated/cat.png',
              label: 'cat.png',
              ext: 'png',
              mime: 'image/png',
              kind: 'image',
              replacesTaskId: 'img-task',
            },
          ],
        },
      },
    ], false);
    slice.appendItem('/a', {
      type: 'interlude',
      id: 'deferred:img-task:success',
      data: {
        type: 'interlude',
        id: 'deferred:img-task:success',
        variant: 'deferred_result',
        taskId: 'img-task',
        status: 'success',
        sourceKind: 'tool',
        sourceLabel: 'image generation',
        text: 'G-SAP received a result from image generation',
      },
    });
    slice.appendItem('/a', {
      type: 'message',
      data: {
        id: 'a2',
        role: 'assistant',
        blocks: [
          {
            type: 'file',
            fileId: 'sf-img',
            filePath: 'E:/generated/cat.png',
            label: 'cat.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
            replacesTaskId: 'img-task',
          },
        ],
      },
    });

    const assistantItems = slice.chatSessions['/a']?.items
      .filter((item) => item.type === 'message' && item.data.role === 'assistant') || [];
    expect(assistantItems).toHaveLength(1);
    expect(slice.chatSessions['/a']?.items.map((item) => item.type === 'message' ? item.data.id : item.id))
      .toEqual(['u1', 'a1', 'deferred:img-task:success']);
  });

  it('strips duplicate completed media blocks from replayed assistant messages with new text', () => {
    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'generate image' } },
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          blocks: [
            { type: 'text', html: 'Image submitted.', source: 'Image submitted.' },
            {
              type: 'file',
              fileId: 'sf-img',
              filePath: 'E:/generated/cat.png',
              label: 'cat.png',
              ext: 'png',
              mime: 'image/png',
              kind: 'image',
              replacesTaskId: 'img-task',
            },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'a2',
          role: 'assistant',
          blocks: [
            { type: 'text', html: 'Here is an extra note.', source: 'Here is an extra note.' },
            {
              type: 'file',
              fileId: 'sf-img',
              filePath: 'E:/generated/cat.png',
              label: 'cat.png',
              ext: 'png',
              mime: 'image/png',
              kind: 'image',
              replacesTaskId: 'img-task',
            },
          ],
        },
      },
    ], false);

    const items = slice.chatSessions['/a']?.items || [];
    expect(items).toHaveLength(3);
    const replay = items[2];
    expect(replay?.type).toBe('message');
    if (!replay || replay.type !== 'message') return;
    expect(replay.data.blocks?.filter((block) => block.type === 'file')).toHaveLength(0);
    expect(replay.data.blocks?.filter((block) => block.type === 'text')).toHaveLength(1);
  });

  it('drops replayed status text after its duplicate media block is stripped', () => {
    const statusText = '图片生成中，我会在结果出来后再呈现给你。';

    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'generate image' } },
      {
        type: 'message',
        data: {
          id: 'a-tool',
          role: 'assistant',
          blocks: [
            { type: 'text', html: 'Calling image generation.', source: 'Calling image generation.' },
            {
              type: 'file',
              fileId: 'sf-img',
              filePath: 'E:/generated/avatar.png',
              label: 'avatar.png',
              ext: 'png',
              mime: 'image/png',
              kind: 'image',
              replacesTaskId: 'img-task',
            },
          ],
        },
      },
      {
        type: 'interlude',
        id: 'deferred:img-task:success',
        data: {
          type: 'interlude',
          id: 'deferred:img-task:success',
          variant: 'deferred_result',
          taskId: 'img-task',
          status: 'success',
          sourceKind: 'tool',
          sourceLabel: 'image generation',
          text: 'G-SAP received a result from image generation',
        },
      },
      {
        type: 'message',
        data: {
          id: 'a-status',
          role: 'assistant',
          blocks: [
            { type: 'text', html: statusText, source: statusText },
          ],
        },
      },
    ], false);

    slice.appendItem('/a', {
      type: 'message',
      data: {
        id: 'a-replay',
        role: 'assistant',
        blocks: [
          { type: 'text', html: statusText, source: statusText },
          {
            type: 'file',
            fileId: 'sf-img',
            filePath: 'E:/generated/avatar.png',
            label: 'avatar.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
            replacesTaskId: 'img-task',
          },
        ],
      },
    });

    const assistantItems = slice.chatSessions['/a']?.items
      .filter((item) => item.type === 'message' && item.data.role === 'assistant') || [];
    expect(assistantItems.map((item) => item.type === 'message' ? item.data.id : '')).toEqual(['a-tool', 'a-status']);
    expect(JSON.stringify(slice.chatSessions['/a']?.items)).not.toContain('a-replay');
  });
});
