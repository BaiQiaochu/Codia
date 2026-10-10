// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelMessages } from '../../components/ChannelsPanel';
import { useStore } from '../../stores';

type TestWindowWithPlatform = {
  platform?: {
    getFileUrl: (filePath: string) => string;
  };
};

function setScrollMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value) => { metrics.scrollTop = value; },
  });
}

describe('ChannelMessages scroll behavior', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      currentChannel: 'ch_crew',
      channels: [{
        id: 'ch_crew',
        name: 'crew',
        members: ['codia'],
        lastMessage: '',
        lastSender: '',
        lastTimestamp: '',
        newMessageCount: 0,
        isDM: false,
      }],
      channelMessages: [
        { sender: 'user', timestamp: '2026-05-07 17:00:00', body: 'old' },
      ],
      agents: [],
      userName: 'user',
      userAvatarUrl: '',
      currentAgentId: 'codia',
    } as never);
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as TestWindowWithPlatform).platform;
  });

  it('keeps the reader position when a new message arrives while scrolled up', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 120 };
    const { container } = render(
      <div className="channel-messages">
        <ChannelMessages />
      </div>,
    );
    const scroller = container.querySelector('.channel-messages') as HTMLElement;
    setScrollMetrics(scroller, metrics);

    act(() => {
      metrics.scrollTop = 120;
      fireEvent.scroll(scroller);
      useStore.setState({
        channelMessages: [
          { sender: 'user', timestamp: '2026-05-07 17:00:00', body: 'old' },
          { sender: 'codia', timestamp: '2026-05-07 17:01:00', body: 'new reply' },
        ],
      } as never);
    });

    expect(screen.getByText('new reply')).toBeInTheDocument();
    expect(metrics.scrollTop).toBe(120);
  });

  it('shows a new-message shortcut while scrolled up and jumps to the latest message', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 120 };
    const { container } = render(
      <div className="channel-messages">
        <ChannelMessages />
      </div>,
    );
    const scroller = container.querySelector('.channel-messages') as HTMLElement;
    setScrollMetrics(scroller, metrics);

    act(() => {
      metrics.scrollTop = 120;
      fireEvent.scroll(scroller);
      useStore.setState({
        channelMessages: [
          { sender: 'user', timestamp: '2026-05-07 17:00:00', body: 'old' },
          { sender: 'codia', timestamp: '2026-05-07 17:01:00', body: 'new reply' },
        ],
      } as never);
    });

    const shortcut = screen.getByRole('button', { name: 'channel.newMessages' });
    expect(shortcut).toBeInTheDocument();

    act(() => {
      fireEvent.click(shortcut);
    });

    expect(metrics.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'channel.newMessages' })).not.toBeInTheDocument();
  });

  it('renders channel rich blocks with the same media cards as chat messages', () => {
    (window as unknown as TestWindowWithPlatform).platform = {
      getFileUrl: (filePath: string) => `file://${filePath}`,
    };
    useStore.setState({
      channelMessages: [{
        sender: 'codia',
        timestamp: '2026-05-07 17:02:00',
        body: '| 文件 | 状态 |\n| --- | --- |\n| 图片 | 已生成 |',
        blocks: [
          { type: 'file', filePath: 'E:\\outputs\\image.png', label: 'image.png', ext: 'png' },
          { type: 'file', filePath: 'E:\\outputs\\voice.mp3', label: 'voice.mp3', ext: 'mp3' },
        ],
      }],
    } as never);

    const { container } = render(
      <div className="channel-messages">
        <ChannelMessages />
      </div>,
    );

    expect(container.querySelector('table')).toBeInTheDocument();
    expect(screen.getByAltText('image.png')).toBeInTheDocument();
    expect(screen.getByText('voice.mp3')).toBeInTheDocument();
    expect(container.querySelector('audio')).toBeInTheDocument();
  });
});
