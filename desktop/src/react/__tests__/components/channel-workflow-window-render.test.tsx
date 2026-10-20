// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const codiaFetchMock = vi.fn();

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: (...args: unknown[]) => codiaFetchMock(...args),
}));

function workflowNodeTexts() {
  return screen
    .getAllByRole('button')
    .filter((element) => element.hasAttribute('data-workflow-node-id'))
    .map((element) => element.textContent || '');
}

function workflowActionButton(pattern: RegExp) {
  const button = screen.getAllByRole('button').find((element) => pattern.test(element.textContent || ''));
  if (!button) throw new Error(`Missing workflow action button: ${pattern}`);
  return button;
}

describe('ChannelWorkflowWindow render', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    window.localStorage.clear();
    codiaFetchMock.mockReset();
    codiaFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [{ id: 'company_channel', internalChannelId: 'ch_crew' }],
        tasks: [
          {
            id: 'task-1',
            treeId: 'tree-1',
            channelId: 'ch_crew',
            title: '修复阅读器图片',
            assigneeAgentId: 'worker-1',
            status: 'in_progress',
          },
        ],
      }),
    } as Response);
    useStore.setState({
      selectedFolder: null,
      selectedWorkspaceMountId: null,
      deskWorkspaceMountId: null,
      deskBasePath: '',
      homeFolder: null,
      currentChannel: 'ch_crew',
      channelHeaderName: '工作群',
      channelMessages: [
        { sender: 'user', body: '开始', timestamp: '2026-05-30T12:00:00.000Z' },
      ],
      channelMembers: ['worker-1'],
      agents: [{ id: 'worker-1', name: '工人A', yuan: 'codia', isPrimary: false }],
      userName: 'Boss',
      userAvatarUrl: '',
      currentAgentId: 'codia',
      channelAgentActivities: {
        ch_crew: {
          'worker-1': [{
            conversationId: 'ch_crew',
            conversationType: 'channel',
            agentId: 'worker-1',
            state: 'replying',
            summary: '正在执行',
            timestamp: '2026-05-30T12:01:00.000Z',
          }],
        },
      },
      channelTickerStatus: {
        ch_crew: { running: true, active: { agentCount: 1, delivered: 1 } },
      },
      agentActivitiesBySession: {},
    } as never);
  });

  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  it('keeps dispatch queued until the exact backend task completes', async () => {
    window.localStorage.setItem('codia.channel.workflow.ch_crew', JSON.stringify({
      nodes: [{ id: 'custom-test', title: 'Evidence task', prompt: 'Do work', agentId: 'worker-1', x: 312, y: 248 }], edges: [],
    }));
    let task: any = null;
    codiaFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/assign-from-workflow')) {
        const body = JSON.parse(String(init?.body));
        task = { id: 'real-task', channelId: 'ch_crew', status: 'assigned', source: { nodeId: 'custom-test', runId: body.runId } };
        return { ok: true, json: async () => ({ tasks: [task] }) };
      }
      return { ok: true, json: async () => ({ channels: [], tasks: task ? [task] : [] }) };
    });
    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Evidence task')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '执行' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '已排队' })).toBeDisabled());
    expect(codiaFetchMock.mock.calls.some(([url]) => String(url).endsWith('/trigger'))).toBe(false);
    task = { ...task, status: 'awaiting_approval' };
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '等待审批 / 解除阻塞' })).toBeDisabled());
    task = { ...task, status: 'completed', report: 'Verified output' };
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '执行' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: '取消后续执行' })).not.toBeInTheDocument();
  });

  it('renders a neutral Chinese workflow canvas above the app chrome', async () => {
    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: '工作流可视窗口' })).toBeInTheDocument();
    expect(screen.getByText('工作流画布')).toBeInTheDocument();
    expect(screen.queryByText('Codia 工作流画布')).not.toBeInTheDocument();
    expect(screen.getByText('Agent 小队输入')).toBeInTheDocument();
    expect(screen.getByText('调度器')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('修复阅读器图片')).toBeInTheDocument());
    expect(workflowNodeTexts().some((text) => text.includes('工人A'))).toBe(true);
    expect(codiaFetchMock).toHaveBeenCalledWith('/api/plugins/company/companies/default/status');
  });

  it('preserves editable workflow drafts when the channel task tree is empty', async () => {
    codiaFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [{ id: 'company_channel', internalChannelId: 'ch_crew' }],
        tasks: [],
      }),
    } as Response);
    window.localStorage.setItem('codia.channel.workflow.ch_crew', JSON.stringify({
      nodes: [{
        id: 'custom-node-1',
        title: '自定义任务 1',
        prompt: '旧的草稿任务',
        agentId: 'worker-1',
        x: 312,
        y: 248,
      }],
      edges: [],
    }));

    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('自定义任务 1')).toBeInTheDocument());
    expect(window.localStorage.getItem('codia.channel.workflow.ch_crew')).not.toBeNull();
    expect(screen.queryByText('暂无工作流任务')).not.toBeInTheDocument();
    expect(screen.getByText('Agent 小队输入')).toBeInTheDocument();
  });

  it('adds only one custom node and does not expand stale agent activity into workflow nodes', async () => {
    codiaFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [{ id: 'company_channel', internalChannelId: 'ch_crew' }],
        tasks: [],
      }),
    } as Response);
    useStore.setState({
      currentChannel: 'ch_crew',
      channelHeaderName: '工作群',
      channelMessages: [],
      channelMembers: ['worker-a', 'director-a', 'admin-a', 'worker-b', 'kskooo'],
      channelMemberRoles: {
        'worker-a': 'worker',
        'director-a': 'project_manager',
        'admin-a': 'admin',
        'worker-b': 'worker',
        kskooo: 'worker',
      },
      agents: [
        { id: 'worker-a', name: '工人A', yuan: 'codia', isPrimary: false },
        { id: 'director-a', name: '总监A', yuan: 'codia', isPrimary: false },
        { id: 'admin-a', name: '管理员A', yuan: 'codia', isPrimary: false },
        { id: 'worker-b', name: '工人B', yuan: 'codia', isPrimary: false },
        { id: 'kskooo', name: 'kskooo', yuan: 'codia', isPrimary: false },
      ],
      channelAgentActivities: {
        ch_crew: Object.fromEntries(['worker-a', 'director-a', 'admin-a', 'worker-b', 'kskooo'].map((agentId) => [
          agentId,
          [{
            conversationId: 'ch_crew',
            conversationType: 'channel',
            agentId,
            state: 'replying',
            summary: '历史处理中',
            timestamp: '2026-05-30T12:01:00.000Z',
          }],
        ])),
      },
      channelTickerStatus: {
        ch_crew: { running: false },
      },
    } as never);

    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('暂无工作流任务')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));

    expect(screen.getByText('自定义任务 1')).toBeInTheDocument();
    const nodeTexts = workflowNodeTexts();
    expect(nodeTexts.some((text) => text.includes('工人A'))).toBe(true);
    expect(nodeTexts.some((text) => text.includes('总监A'))).toBe(true);
    expect(nodeTexts.some((text) => text.includes('管理员A'))).toBe(true);
    expect(nodeTexts.some((text) => text.includes('工人B'))).toBe(false);
    expect(nodeTexts.some((text) => text.includes('kskooo'))).toBe(false);
  });

  it('opens a saved standalone draft without a channel and offers execution setup only on execute', async () => {
    useStore.setState({
      // Match the real app: the user may open an independent workflow draft
      // while a different channel remains selected in the store.
      currentChannel: 'unrelated-channel',
      channelMembers: [],
      channels: [],
      channelsEnabled: false,
      selectedFolder: '',
      selectedWorkspaceMountId: '',
      agents: [
        { id: 'worker-1', name: '工人A', yuan: 'codia', isPrimary: false },
        { id: 'worker-2', name: '工人B', yuan: 'codia', isPrimary: false },
      ],
    } as never);
    const draftKey = 'codia.channel.workflow.draft.default';
    window.localStorage.setItem(draftKey, JSON.stringify({ nodes: [{
      id: 'custom-node-saved', title: '保存的独立任务', prompt: '草稿内容', agentId: 'worker-1', x: 312, y: 248,
    }], edges: [] }));

    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open standalone pageMode onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('保存的独立任务')).toBeInTheDocument());
    expect(codiaFetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: '工作流页面' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '执行' }));
    expect(screen.getByRole('dialog', { name: '关联执行Agent 小队' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /新建Agent 小队/ })).not.toBeInTheDocument();
  });

  it('restores a legacy standalone draft on cold home startup before any chat is opened', async () => {
    const home = '/workspace/home';
    const legacyKey = 'codia.channel.workflow.draft.default';
    const homeKey = `codia.channel.workflow.draft.${encodeURIComponent(home)}`;
    const draft = JSON.stringify({ nodes: [1, 2].map((index) => ({
      id: `saved-${index}`, title: `Restart node ${index}`, prompt: 'Saved before restart',
      agentId: 'worker-1', x: 312 * index, y: 248,
    })), edges: [{ id: 'saved-edge', from: 'saved-1', to: 'saved-2' }] });
    localStorage.setItem(legacyKey, draft);
    // initApp restores the configured home before restoring the workflow tab.
    useStore.setState({ homeFolder: home, selectedFolder: home, deskBasePath: home });
    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    const first = render(<ChannelWorkflowWindow open standalone pageMode onClose={vi.fn()} />);
    expect(screen.getByText('Restart node 1')).toBeInTheDocument();
    expect(screen.getByText('Restart node 2')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(homeKey)!).nodes).toHaveLength(2);
    expect(localStorage.getItem(legacyKey)).toBe(draft);

    // switchSession clears the pending folder choice, without changing cwd.
    await act(async () => useStore.setState({ selectedFolder: null }));
    expect(screen.getByText('Restart node 1')).toBeInTheDocument();
    first.unmount();
    // A fresh renderer/store startup must select the same persisted canvas.
    useStore.setState({ selectedFolder: home, deskBasePath: '' });
    render(<ChannelWorkflowWindow open standalone pageMode onClose={vi.fn()} />);
    expect(screen.getByText('Restart node 1')).toBeInTheDocument();
    expect(screen.getByText('Restart node 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除工作流' }));
    cleanup();
    render(<ChannelWorkflowWindow open standalone pageMode onClose={vi.fn()} />);
    expect(screen.queryByText('Restart node 1')).not.toBeInTheDocument();
    expect(localStorage.getItem(homeKey)).toBeNull();
  });

  it('uses the actual desk workspace when chat clears the temporary folder choice', async () => {
    const home = '/workspace/home';
    const folder = '/workspace/project';
    const draftKey = `codia.channel.workflow.draft.${encodeURIComponent(folder)}`;
    localStorage.setItem(draftKey, JSON.stringify({ nodes: [{
      id: 'project-node', title: 'Project draft', prompt: 'Project work',
      agentId: 'worker-1', x: 312, y: 248,
    }], edges: [] }));
    useStore.setState({ homeFolder: home, selectedFolder: folder, deskBasePath: folder });
    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open standalone pageMode onClose={vi.fn()} />);
    expect(screen.getByText('Project draft')).toBeInTheDocument();
    await act(async () => useStore.setState({ selectedFolder: null }));
    expect(screen.getByText('Project draft')).toBeInTheDocument();
    expect(localStorage.getItem('codia.channel.workflow.draft.default')).toBeNull();
  });

  it('renders channel-scoped ActivityHub workflow entries in the timeline', async () => {
    useStore.setState({
      agentActivitiesBySession: {
        'channel:ch_crew': {
          'wf-channel-run-1': {
            id: 'wf-channel-run-1',
            kind: 'workflow',
            status: 'running',
            sessionPath: 'channel:ch_crew',
            agentId: 'codia',
            agentName: 'Codia',
            summary: 'Launch workflow',
            childSessionPath: null,
            startedAt: Date.parse('2026-05-30T12:02:00.000Z'),
            finishedAt: null,
          },
          'wf-channel-run-1::node-1': {
            id: 'wf-channel-run-1::node-1',
            kind: 'workflow_agent',
            status: 'done',
            sessionPath: 'channel:ch_crew',
            parentTaskId: 'wf-channel-run-1',
            agentId: 'worker-1',
            agentName: 'Worker One',
            summary: 'Plan ready',
            childSessionPath: null,
            label: 'Plan',
            startedAt: Date.parse('2026-05-30T12:03:00.000Z'),
            finishedAt: Date.parse('2026-05-30T12:04:00.000Z'),
          },
        },
      },
    } as never);

    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/Plan ready/)).toBeInTheDocument());
    expect(screen.getAllByText(/Plan/).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-workflow-activity-session-path="channel:ch_crew"]')).toBeInTheDocument();
    expect(document.querySelector('[data-workflow-activity-count="2"]')).toBeInTheDocument();
  });

  it('never writes the previous workspace draft into the next workspace storage key', async () => {
    const draftKey = (workspace: string) => `codia.channel.workflow.draft.${workspace}`;
    const makeDraft = (workspace: string) => ({ nodes: [{
      id: `custom-node-${workspace}`, title: `Draft ${workspace}`, prompt: workspace,
      agentId: 'worker-1', x: 312, y: 248,
    }], edges: [] });
    window.localStorage.setItem(draftKey('workspace-a'), JSON.stringify(makeDraft('workspace-a')));
    window.localStorage.setItem(draftKey('workspace-b'), JSON.stringify(makeDraft('workspace-b')));
    useStore.setState({
      selectedWorkspaceMountId: 'workspace-a', selectedFolder: '',
      channels: [], channelsEnabled: false,
    } as never);
    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open standalone pageMode onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Draft workspace-a')).toBeInTheDocument());

    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const removals = vi.spyOn(Storage.prototype, 'removeItem');
    try {
      await act(async () => useStore.setState({ selectedWorkspaceMountId: 'workspace-b' }));
      expect(screen.getByText('Draft workspace-b')).toBeInTheDocument();
      const newWorkspaceWrites = writes.mock.calls.filter(([key]) => key === draftKey('workspace-b'));
      expect(newWorkspaceWrites.length).toBeGreaterThan(0);
      for (const [, value] of newWorkspaceWrites) {
        expect(JSON.parse(value).nodes.map((node: { id: string }) => node.id)).toEqual(['custom-node-workspace-b']);
      }
      expect(removals).not.toHaveBeenCalledWith(draftKey('workspace-b'));

      writes.mockClear();
      await act(async () => useStore.setState({ selectedWorkspaceMountId: 'workspace-a' }));
      expect(screen.getByText('Draft workspace-a')).toBeInTheDocument();
      for (const [key, value] of writes.mock.calls) {
        if (key === draftKey('workspace-a')) {
          expect(JSON.parse(value).nodes.map((node: { id: string }) => node.id)).toEqual(['custom-node-workspace-a']);
        }
      }
    } finally {
      writes.mockRestore();
      removals.mockRestore();
    }
  });

  it('previews, edits, and confirms a generated workflow template before changing the canvas', async () => {
    codiaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/workspace-tools/resolve') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            draft: {
              title: '周报模板',
              nodes: [
                { id: 'collect', title: '收集进展', prompt: '收集本周进展', agentId: 'worker-1' },
                { id: 'review', title: '复核周报', prompt: '复核风险并输出周报', agentId: 'worker-1' },
              ],
              edges: [{ from: 'collect', to: 'review' }],
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ channels: [], tasks: [] }),
      } as Response;
    });
    window.localStorage.setItem('codia.channel.workflow.ch_crew', JSON.stringify({
      nodes: [{ id: 'existing', title: '原有节点', prompt: '保留我', agentId: 'worker-1', x: 312, y: 248 }],
      edges: [],
    }));

    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('原有节点')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '生成模板' }));
    fireEvent.change(screen.getByLabelText('模板需求'), { target: { value: '生成团队周报流程' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿' }));

    await waitFor(() => expect(document.querySelector('[data-workflow-template-preview="true"]')).toBeInTheDocument());
    expect(screen.getByText('原有节点')).toBeInTheDocument();
    const nodeNameInputs = screen.getAllByLabelText('节点名称');
    fireEvent.change(nodeNameInputs[0], { target: { value: '收集团队进展' } });
    fireEvent.click(screen.getByRole('button', { name: '确认应用' }));

    await waitFor(() => expect(screen.getByText('收集团队进展')).toBeInTheDocument());
    expect(screen.getByText('原有节点')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-workflow-edge-id]').length).toBeGreaterThan(0);
    expect(codiaFetchMock).toHaveBeenCalledWith('/api/workspace-tools/resolve', expect.objectContaining({ method: 'POST' }));
  });

  it('keeps the current canvas unchanged when template generation fails', async () => {
    codiaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/workspace-tools/resolve') {
        return {
          ok: false,
          status: 422,
          json: async () => ({ error: '模板包含循环连线' }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ channels: [], tasks: [] }),
      } as Response;
    });
    window.localStorage.setItem('codia.channel.workflow.ch_crew', JSON.stringify({
      nodes: [{ id: 'safe', title: '安全节点', prompt: '保持不变', agentId: 'worker-1', x: 312, y: 248 }],
      edges: [],
    }));

    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('安全节点')).toBeInTheDocument());
    await waitFor(() => expect(window.localStorage.getItem('codia.channel.workflow.ch_crew')).toContain('hiddenTimelineItemIds'));
    const storedBeforeFailure = window.localStorage.getItem('codia.channel.workflow.ch_crew');
    fireEvent.click(screen.getByRole('button', { name: '生成模板' }));
    fireEvent.change(screen.getByLabelText('模板需求'), { target: { value: '生成循环流程' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('模板包含循环连线'));
    expect(screen.getByText('安全节点')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认应用' })).toBeDisabled();
    expect(window.localStorage.getItem('codia.channel.workflow.ch_crew')).toBe(storedBeforeFailure);
  });

  it('restores focus and ignores a stale template response after the generator is closed', async () => {
    let resolveTemplate: ((value: Response) => void) | null = null;
    codiaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/workspace-tools/resolve') {
        return await new Promise<Response>((resolve) => { resolveTemplate = resolve; });
      }
      return {
        ok: true,
        json: async () => ({ channels: [], tasks: [] }),
      } as Response;
    });

    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '生成模板' });
    trigger.focus();
    fireEvent.click(trigger);

    await waitFor(() => expect(screen.getByLabelText('模板需求')).toHaveFocus());
    const dialog = screen.getByRole('dialog', { name: '生成工作流模板' });
    expect(dialog.parentElement?.parentElement?.firstElementChild).toHaveAttribute('inert');
    fireEvent.change(screen.getByLabelText('模板需求'), { target: { value: '生成旧流程' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭模板生成器' }));
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByLabelText('模板需求')).toHaveFocus());
    await act(async () => {
      resolveTemplate?.({
        ok: true,
        json: async () => ({
          ok: true,
          draft: {
            title: '过期模板',
            nodes: [{ id: 'stale', title: '不应出现', prompt: '旧请求', agentId: 'worker-1' }],
            edges: [],
          },
        }),
      } as Response);
      await Promise.resolve();
    });

    expect(document.querySelector('[data-workflow-template-preview="true"]')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成草稿' })).toBeEnabled();
  });
});
