// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const gsapFetchMock = vi.fn();

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
}));

describe('ChannelWorkspacePanel company task tree', () => {
  beforeEach(() => {
    window.t = ((key: string, vars?: Record<string, string | number>) => {
      if (key === 'common.loading') return '加载中';
      if (key === 'common.refresh') return '刷新';
      if (vars?.name) return `${key}:${vars.name}`;
      return key;
    }) as typeof window.t;
    gsapFetchMock.mockReset();
    gsapFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        company: { id: 'company_default', name: '一人公司' },
        channels: [
          { id: 'company_channel', internalChannelId: 'ch_crew' },
        ],
        tasks: [
          {
            id: 'task-root',
            treeId: 'tree-a',
            parentTaskId: '',
            taskKind: 'root',
            depth: 0,
            channelId: 'ch_crew',
            title: '项目拆解',
            assigneeTitle: '项目经理',
            assigneeAgentId: 'pm-1',
            status: 'assigned',
            acceptanceCriteria: ['拆解任务'],
          },
          {
            id: 'task-worker',
            treeId: 'tree-a',
            parentTaskId: 'task-root',
            taskKind: 'agent_task',
            depth: 1,
            channelId: 'company_channel',
            title: '设计界面',
            assigneeTitle: '视觉设计',
            assigneeAgentId: 'worker-1',
            status: 'assigned',
            acceptanceCriteria: ['输出方案'],
          },
        ],
      }),
    } as Response);
    useStore.setState({
      currentChannel: 'ch_crew',
      channelMembers: ['pm-1', 'worker-1'],
      channelMemberRoles: { 'pm-1': 'project_manager', 'worker-1': 'worker' },
      channelInfoName: '工作群',
      channelInfoDescription: '项目协作频道',
      agents: [
        { id: 'pm-1', name: '管理A', yuan: 'gsap', isPrimary: false },
        { id: 'worker-1', name: '工人A', yuan: 'gsap', isPrimary: false },
      ],
      userName: 'Boss',
      userAvatarUrl: '',
      currentAgentId: 'pm-1',
      channelAgentActivities: {
        ch_crew: {
          'worker-1': [{
            conversationId: 'ch_crew',
            conversationType: 'channel',
            agentId: 'worker-1',
            state: 'replying',
            summary: '正在执行',
            timestamp: '2026-05-29T10:00:00.000Z',
          }],
        },
      },
      addToast: vi.fn(),
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('loads company status and renders a channel-scoped agent task tree', async () => {
    const { ChannelWorkspacePanel } = await import('../../components/channels/ChannelWorkspacePanel');
    render(<ChannelWorkspacePanel />);

    await waitFor(() => expect(gsapFetchMock).toHaveBeenCalledWith('/api/plugins/company/companies/default/status'));

    expect(await screen.findByText('任务树')).toBeInTheDocument();
    expect(screen.getByText('项目拆解')).toBeInTheDocument();
    expect(screen.getByText('设计界面')).toBeInTheDocument();
    expect(screen.getAllByText('工人A').length).toBeGreaterThan(0);
    expect(screen.getByText('正在执行')).toBeInTheDocument();
  });

  it('dispatches a channel command through company cluster assignment and renders nested task depth', async () => {
    const assignedTasks = [
      {
        id: 'task-root',
        treeId: 'tree-cluster',
        parentTaskId: '',
        taskKind: 'root',
        depth: 0,
        channelId: 'ch_crew',
        title: '项目拆解',
        assigneeTitle: '项目经理',
        assigneeAgentId: 'pm-1',
        status: 'assigned',
      },
      {
        id: 'task-worker',
        treeId: 'tree-cluster',
        parentTaskId: 'task-root',
        taskKind: 'agent_task',
        depth: 1,
        channelId: 'ch_crew',
        title: '设计界面',
        assigneeTitle: '视觉设计',
        assigneeAgentId: 'worker-1',
        status: 'in_progress',
      },
      {
        id: 'task-child',
        treeId: 'tree-cluster',
        parentTaskId: 'task-worker',
        taskKind: 'agent_task',
        depth: 2,
        channelId: 'ch_crew',
        title: '整理验收清单',
        assigneeTitle: '视觉设计',
        assigneeAgentId: 'worker-1',
        status: 'assigned',
      },
    ];
    gsapFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/plugins/company/tasks/assign') {
        return {
          ok: true,
          json: async () => ({ ok: true, tasks: assignedTasks }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          channels: [{ id: 'company_channel', internalChannelId: 'ch_crew' }],
          tasks: assignedTasks,
        }),
      } as Response;
    });

    const { ChannelWorkspacePanel } = await import('../../components/channels/ChannelWorkspacePanel');
    const { container } = render(<ChannelWorkspacePanel />);

    expect(await screen.findByText('AI Agent 集群调用')).toBeInTheDocument();
    expect(await screen.findByText('整理验收清单')).toBeInTheDocument();
    expect(container.querySelector('[data-task-depth="2"]')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('输入项目目标，自动拆成任务树并派发给频道成员'), {
      target: { value: '完成阅读器模式修复' },
    });
    fireEvent.click(screen.getByText('拆解并派发'));

    await waitFor(() => expect(gsapFetchMock).toHaveBeenCalledWith(
      '/api/plugins/company/tasks/assign',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('完成阅读器模式修复'),
      }),
    ));
    const assignCall = gsapFetchMock.mock.calls.find(([url]) => url === '/api/plugins/company/tasks/assign');
    expect(JSON.parse(String(assignCall?.[1]?.body))).toMatchObject({
      channelId: 'ch_crew',
      command: '完成阅读器模式修复',
    });
  });

  it('shows a director panel with cross-channel assignment, blockers, and review queue', async () => {
    const { ChannelWorkspacePanel } = await import('../../components/channels/ChannelWorkspacePanel');
    render(<ChannelWorkspacePanel />);

    expect(await screen.findByText('调度总监')).toBeInTheDocument();
    expect(screen.getByText('跨频道任务分派')).toBeInTheDocument();
    expect(screen.getByText('阻塞点')).toBeInTheDocument();
    expect(screen.getByText('待复核输出')).toBeInTheDocument();
    expect(screen.getAllByText('管理A').length).toBeGreaterThan(0);
  });
});
