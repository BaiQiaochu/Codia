// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      'channel.minMembers': '至少选择 2 位成员',
    }[key] || key)) as typeof window.t;
    createChannelMock.mockReset();
    createChannelMock.mockResolvedValue('ch_design-team');
    useStore.setState({
      channelCreateOverlayVisible: true,
      agents: [
        { id: 'worker-a', name: '工人A', yuan: 'codia', isPrimary: false },
        { id: 'admin-a', name: '管理员A', yuan: 'codia', isPrimary: false },
      ],
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    useStore.setState({ channelCreateOverlayVisible: false } as never);
  });

  it.each([0, 1])('explains the minimum when submitting with %i selected members', async (memberCount) => {
    const { ChannelCreateOverlay } = await import('../../components/channels/ChannelCreateOverlay');
    render(<ChannelCreateOverlay />);

    fireEvent.change(screen.getByPlaceholderText('例如：design-team'), {
      target: { value: 'design-team' },
    });
    fireEvent.click(screen.getByRole('button', { name: /管理员A/ }));
    if (memberCount === 0) fireEvent.click(screen.getByRole('button', { name: /工人A/ }));

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('alert')).toHaveTextContent('至少选择 2 位成员');
    expect(screen.getByRole('group', { name: '成员' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('group', { name: '成员' })).toHaveAccessibleDescription('至少选择 2 位成员');
    act(() => vi.advanceTimersByTime(1600));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(createChannelMock).not.toHaveBeenCalled();
    expect(useStore.getState().channelCreateOverlayVisible).toBe(true);
  });

  it('shows the same explanation when only one assistant is available', async () => {
    useStore.setState({ agents: useStore.getState().agents.slice(0, 1) });
    const { ChannelCreateOverlay } = await import('../../components/channels/ChannelCreateOverlay');
    render(<ChannelCreateOverlay />);

    fireEvent.change(screen.getByPlaceholderText('例如：design-team'), { target: { value: 'solo' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('alert')).toHaveTextContent('至少选择 2 位成员');
    expect(createChannelMock).not.toHaveBeenCalled();
  });

  it('clears the explanation and creates after the selection reaches two members', async () => {
    const { ChannelCreateOverlay } = await import('../../components/channels/ChannelCreateOverlay');
    render(<ChannelCreateOverlay />);

    fireEvent.change(screen.getByPlaceholderText('例如：design-team'), { target: { value: 'design-team' } });
    fireEvent.click(screen.getByRole('button', { name: /管理员A/ }));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('alert')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /管理员A/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: '成员' })).not.toHaveAttribute('aria-invalid');
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(createChannelMock).toHaveBeenCalledWith(
      'design-team', ['worker-a', 'admin-a'], undefined,
    ));
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
