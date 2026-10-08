// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const createChannelMock = vi.fn();

vi.mock('../../stores/channel-actions', () => ({
  createChannel: (...args: unknown[]) => createChannelMock(...args),
}));

describe('ChannelCreateOverlay interaction', () => {
  beforeEach(() => {
    window.t = ((key: string) => ({
      'channel.createTitle': '新建频道',
      'channel.createName': '频道名称',
      'channel.createNamePlaceholder': '例如：design-team',
      'channel.createMembers': '成员',
      'channel.createIntro': '频道介绍',
      'channel.createIntroOptional': '说明',
      'channel.createIntroPlaceholder': '描述一下这个频道的用途...',
      'channel.createCancel': '取消',
      'channel.createConfirm': '创建',
      'channel.nameExists': '频道已存在',
    }[key] || key)) as typeof window.t;
    createChannelMock.mockReset();
    createChannelMock.mockResolvedValue('ch_design-team');
    useStore.setState({
      channelCreateOverlayVisible: true,
      agents: [
        { id: 'worker-a', name: '工人A', yuan: 'gsap', isPrimary: false },
        { id: 'admin-a', name: '管理员A', yuan: 'gsap', isPrimary: false },
      ],
    } as never);
  });

  afterEach(() => {
    cleanup();
    useStore.setState({ channelCreateOverlayVisible: false } as never);
  });

  it('uses the typed channel name when creating a channel', async () => {
    const { ChannelCreateOverlay } = await import('../../components/channels/ChannelCreateOverlay');
    render(<ChannelCreateOverlay />);

    fireEvent.change(screen.getByPlaceholderText('例如：design-team'), {
      target: { value: 'design-team' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(createChannelMock).toHaveBeenCalledWith(
        'design-team',
        ['worker-a', 'admin-a'],
        undefined,
      );
    });
  });
});
