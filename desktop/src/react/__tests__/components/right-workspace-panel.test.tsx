// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let storeState: Record<string, unknown>;

vi.mock('../../stores', () => ({
  get useStore() {
    return Object.assign(
      (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(storeState) : storeState),
      {
        getState: () => storeState,
        setState: (partial: Record<string, unknown>) => { storeState = { ...storeState, ...partial }; },
      },
    );
  },
}));

vi.mock('../../components/DeskSection', () => ({
  DeskSection: ({ openFilesOnSingleClick }: { openFilesOnSingleClick?: boolean }) => (
    <div data-testid="desk-section" data-single-click={openFilesOnSingleClick ? 'true' : 'false'} />
  ),
}));

vi.mock('../../components/plugin/PluginWidgetView', () => ({
  PluginWidgetView: ({ pluginId }: { pluginId: string }) => <div data-testid="plugin-widget">{pluginId}</div>,
}));

describe('RightWorkspacePanel', () => {
  beforeEach(() => {
    (window as typeof window & { t?: (key: string) => string }).t = (key) => key;
    storeState = {
      rightWorkspaceTab: 'workspace',
      jianDrawerOpen: true,
      jianView: 'desk',
      deskBasePath: '/workspace',
      selectedFolder: null,
      homeFolder: null,
      cwdSkills: [],
      cwdSkillsOpen: false,
      deskJianContent: 'hello',
      currentSessionPath: null,
      currentModel: { id: 'model-a' },
      sessionModelsByPath: {},
      sessionRegistryFilesByPath: {},
      sessionTodos: [],
      agents: [],
      agentActivitiesBySession: {},
      setRightWorkspaceTab: (tab: string) => { storeState.rightWorkspaceTab = tab; },
      setJianDrawerOpen: (open: boolean) => { storeState.jianDrawerOpen = open; },
      setDeskJianContent: (content: string | null) => { storeState.deskJianContent = content; },
      setSubagentPreviewSessionPath: vi.fn(),
    };
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    window.HTMLElement.prototype.focus = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('collapses and expands the Jian drawer without unmounting the editor', async () => {
    const { RightWorkspacePanel } = await import('../../components/right-workspace/RightWorkspacePanel');
    const view = render(<RightWorkspacePanel />);

    expect(screen.getByRole('tabpanel')).toBeTruthy();
    const drawer = view.container.querySelector('[aria-label="desk.jianLabel"]') as HTMLElement;
    expect(drawer.dataset.open).toBe('true');
    expect(view.container.querySelector('[data-desk-editor]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'rightWorkspace.jian.collapse' }));
    view.rerender(<RightWorkspacePanel />);

    expect(drawer.dataset.open).toBe('false');
    expect(view.container.querySelector('[data-desk-editor]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'rightWorkspace.jian.expand' }));
    view.rerender(<RightWorkspacePanel />);

    expect(drawer.dataset.open).toBe('true');
  });

  it('renders compatible original right workspace status cards when session data exists', async () => {
    storeState = {
      ...storeState,
      currentSessionPath: '/sessions/a.jsonl',
      sessionTodos: [{ status: 'pending', content: 'check layout' }],
      sessionRegistryFilesByPath: { '/sessions/a.jsonl': [{ id: 'f1' }, { id: 'f2' }] },
      agentActivitiesBySession: {
        '/sessions/a.jsonl': [
          {
            id: 'wf-1',
            kind: 'workflow',
            status: 'running',
            sessionPath: '/sessions/a.jsonl',
            agentId: 'agent-a',
            agentName: 'Agent A',
            summary: 'workflow summary',
            childSessionPath: null,
            startedAt: 1,
            finishedAt: null,
          },
          {
            id: 'sub-1',
            kind: 'subagent',
            status: 'running',
            sessionPath: '/sessions/a.jsonl',
            agentId: 'agent-a',
            agentName: 'Agent A',
            summary: 'subagent summary',
            childSessionPath: null,
            startedAt: 1,
            finishedAt: null,
          },
        ],
      },
    };
    const { RightWorkspacePanel } = await import('../../components/right-workspace/RightWorkspacePanel');

    render(<RightWorkspacePanel />);

    expect(screen.getByText('rightWorkspace.todo.title')).toBeTruthy();
    expect(screen.getByText('rightWorkspace.workflow.title')).toBeTruthy();
    expect(screen.getByText('rightWorkspace.subagent.title')).toBeTruthy();
    expect(screen.getByText('rightWorkspace.session.title')).toBeTruthy();
  });

  it('falls back to the workspace tab when persisted state points at a removed tab', async () => {
    storeState = {
      ...storeState,
      rightWorkspaceTab: 'removed-tab',
    };
    const { RightWorkspacePanel } = await import('../../components/right-workspace/RightWorkspacePanel');

    render(<RightWorkspacePanel />);

    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByTestId('desk-section')).toBeTruthy();
    expect(screen.getByTestId('desk-section').dataset.singleClick).toBe('true');
  });

  it('keeps workflow details in the original right workspace card', async () => {
    storeState = {
      ...storeState,
      currentSessionPath: '/sessions/a.jsonl',
      agentActivitiesBySession: {
        '/sessions/a.jsonl': [
          {
            id: 'wf-1',
            kind: 'workflow',
            status: 'running',
            sessionPath: '/sessions/a.jsonl',
            agentId: null,
            agentName: null,
            summary: '复杂工作流',
            childSessionPath: null,
            startedAt: 1,
            finishedAt: null,
          },
          {
            id: 'node-1',
            kind: 'workflow_agent',
            status: 'running',
            sessionPath: '/sessions/a.jsonl',
            parentTaskId: 'wf-1',
            agentId: 'agent-a',
            agentName: 'Agent A',
            label: '执行智能体',
            summary: '正在处理',
            childSessionPath: null,
            startedAt: 2,
            finishedAt: null,
          },
        ],
      },
    };
    const { RightWorkspacePanel } = await import('../../components/right-workspace/RightWorkspacePanel');

    render(<RightWorkspacePanel />);

    expect(screen.queryByText('执行智能体')).toBeNull();
    fireEvent.click(screen.getByText('复杂工作流'));
    expect(screen.getByText('执行智能体')).toBeTruthy();
  });
});
