// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchStreamKey } from '../../services/stream-key-dispatcher';
import { useStore } from '../../stores';

vi.mock('../../stores/session-actions', () => ({
  loadMessages: vi.fn(async () => {}),
}));

const SESSION_PATH = '/phone/ch_crew/worker-1.jsonl';

describe('AgentPhoneSessionPreview stream turns', () => {
  beforeEach(() => {
    window.t = ((key: string) => {
      if (key === 'channel.phoneReceivedNewMessages') return '收到新的频道消息';
      if (key === 'channel.agentIdle') return '空闲';
      if (key === 'common.loading') return '加载中';
      return key;
    }) as typeof window.t;
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    useStore.setState({
      chatSessions: {
        [SESSION_PATH]: {
          items: [{
            type: 'message',
            data: {
              id: 'user-existing',
              role: 'user',
              text: '触发任务',
              textHtml: '触发任务',
            },
          }],
          hasMore: false,
          loadingMore: false,
        },
      },
      agents: [{ id: 'worker-1', name: '工人A', yuan: 'gsap', isPrimary: false }],
      agentName: 'G-SAP',
      agentYuan: 'gsap',
      streamingSessions: [],
      selectedMessageIdsBySession: {},
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('creates a separate temporary assistant message when turnTraceId changes', async () => {
    const { AgentPhoneSessionPreview } = await import('../../components/ChannelsPanel');
    const { container } = render(
      <AgentPhoneSessionPreview
        sessionPath={SESSION_PATH}
        agentId="worker-1"
        agentYuan="gsap"
      />,
    );

    act(() => {
      dispatchStreamKey(SESSION_PATH, {
        type: 'text_delta',
        turnTraceId: 'turn-a',
        delta: '第一轮回复',
      });
    });
    act(() => {
      dispatchStreamKey(SESSION_PATH, {
        type: 'text_delta',
        turnTraceId: 'turn-b',
        delta: '第二轮回复',
      });
    });

    expect(container.querySelectorAll('[data-message-id^="agent-phone-stream-worker-1-"]')).toHaveLength(2);
  });
});
