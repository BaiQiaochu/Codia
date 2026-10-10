// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const codiaFetchMock = vi.fn();

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: (...args: unknown[]) => codiaFetchMock(...args),
}));

vi.mock('../../components/channels/ChannelWorkflowWindow', () => ({
  ChannelWorkflowWindow: () => null,
}));

describe('ChannelHeader routing', () => {
  beforeEach(() => {
    codiaFetchMock.mockReset();
    codiaFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        members: ['agent-a', 'agent-b'],
        memberRoles: { 'agent-a': 'project_manager', 'agent-b': 'worker' },
        roleCounts: { project_manager: 1, admin: 0, worker: 1 },
      }),
    } as Response);
    window.t = ((key: string, vars?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        'channel.addMember': 'Add member',
        'channel.info': 'Channel info',
        'channel.createAgent': 'Create assistant',
        'channel.noAvailableMembers': 'No available members',
        'channel.memberAdded': `Added ${vars?.name || ''}`,
        'channel.addMemberFailed': 'Failed to add member',
        'channel.removeMember': 'Remove member',
        'channel.removeMemberConfirm': `Remove ${vars?.name || ''}?`,
        'channel.removeMemberFailed': 'Failed to remove member',
        'common.more': 'More',
      };
      return dict[key] || key;
    }) as typeof window.t;
    useStore.setState({
      currentChannel: 'ch-team',
      channelHeaderName: '# team',
      channelHeaderMembersText: '2 members',
      channelIsDM: false,
      channelMembers: ['agent-a'],
      channelMemberRoles: { 'agent-a': 'project_manager' },
      agents: [
        { id: 'agent-a', name: 'Agent A', yuan: 'codia', isPrimary: false },
        { id: 'agent-b', name: 'Agent B', yuan: 'codia', isPrimary: false },
      ],
      addToast: vi.fn(),
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('adds an existing assistant from the header add-member menu', async () => {
    const { ChannelHeader } = await import('../../components/channels/ChannelHeader');
    render(<ChannelHeader />);

    fireEvent.click(screen.getByTitle('Add member'));
    fireEvent.click(await screen.findByText('Agent B'));

    await waitFor(() => expect(codiaFetchMock).toHaveBeenCalledWith(
      '/api/channels/ch-team/members',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ memberId: 'agent-b' }),
      }),
    ));
    expect(useStore.getState().channelMembers).toEqual(['agent-a', 'agent-b']);
  });

  it('removes an assistant from the header member menu', async () => {
    useStore.setState({
      channelMembers: ['agent-a', 'agent-b'],
      channelMemberRoles: { 'agent-a': 'project_manager', 'agent-b': 'worker' },
    } as never);
    codiaFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        members: ['agent-a'],
        memberRoles: { 'agent-a': 'project_manager' },
        roleCounts: { project_manager: 1, admin: 0, worker: 0 },
      }),
    } as Response);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { ChannelHeader } = await import('../../components/channels/ChannelHeader');
    render(<ChannelHeader />);

    fireEvent.click(screen.getByTitle('Add member'));
    fireEvent.click(await screen.findByText('Remove member: Agent B'));

    await waitFor(() => expect(codiaFetchMock).toHaveBeenCalledWith(
      '/api/channels/ch-team/members/agent-b',
      expect.objectContaining({ method: 'DELETE' }),
    ));
    expect(useStore.getState().channelMembers).toEqual(['agent-a']);
  });

  it('routes the info button to the channel info panel', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const { ChannelHeader } = await import('../../components/channels/ChannelHeader');
    render(<ChannelHeader />);

    fireEvent.click(screen.getByTitle('Channel info'));

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'codia-channel-focus-info',
    }));
  });
});
