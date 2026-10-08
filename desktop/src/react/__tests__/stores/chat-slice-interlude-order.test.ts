import { beforeEach, describe, expect, it } from 'vitest';
import { createChatSlice, type ChatSlice } from '../../stores/chat-slice';

function makeSlice(): ChatSlice {
  let state: ChatSlice;
  const set = (partial: Partial<ChatSlice> | ((s: ChatSlice) => Partial<ChatSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  state = createChatSlice(set as never, get);
  return new Proxy({} as ChatSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('chat-slice interlude ordering', () => {
  let slice: ChatSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('workflow interlude is appended after the current assistant run', () => {
    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'run workflow' } },
      {
        type: 'message',
        data: {
          id: 'a-card',
          role: 'assistant',
          blocks: [{
            type: 'workflow',
            taskId: 'workflow-1',
            taskTitle: '冒烟测试',
            streamStatus: 'running',
          }],
        },
      },
      {
        type: 'message',
        data: {
          id: 'a-text',
          role: 'assistant',
          blocks: [{ type: 'text', html: '<p>工作流已经提交后台运行。</p>', source: '工作流已经提交后台运行。' }],
        },
      },
    ], false);

    expect(slice.appendInterludeItem('/a', {
      type: 'interlude',
      id: 'deferred:workflow-1:success',
      variant: 'deferred_result',
      taskId: 'workflow-1',
      status: 'success',
      sourceKind: 'workflow',
      text: '工作流结果已返回',
    })).toBe(true);

    expect(slice.chatSessions['/a']?.items.map((item) => (
      item.type === 'message' ? item.data.id : item.id
    ))).toEqual(['u1', 'a-card', 'a-text', 'deferred:workflow-1:success']);
  });

  it('media interlude is appended after the resolved file during live streaming', () => {
    slice.initSession('/a', [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'draw' } },
      {
        type: 'message',
        data: {
          id: 'a-media',
          role: 'assistant',
          blocks: [{
            type: 'file',
            replacesTaskId: 'task-img',
            filePath: '/tmp/image.png',
            label: 'image.png',
            ext: 'png',
          }],
        },
      },
    ], false);

    expect(slice.appendInterludeItem('/a', {
      type: 'interlude',
      id: 'deferred:task-img:success',
      variant: 'deferred_result',
      taskId: 'task-img',
      status: 'success',
      sourceKind: 'tool',
      text: '图片结果已返回',
    })).toBe(true);

    expect(slice.chatSessions['/a']?.items.map((item) => (
      item.type === 'message' ? item.data.id : item.id
    ))).toEqual(['u1', 'a-media', 'deferred:task-img:success']);
  });
});
