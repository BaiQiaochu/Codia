/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let storeState: {
  currentSessionPath: string | null;
  agents: any[];
  agentActivitiesBySession: Record<string, any[]>;
};

type WorkflowInlineBlock = {
  taskId: string;
  taskTitle: string;
  streamStatus: 'running' | 'done' | 'failed' | 'aborted';
  summary?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
};

vi.mock('../../../stores', () => ({
  useStore: (selector?: (state: typeof storeState) => unknown) => (
    typeof selector === 'function' ? selector(storeState) : storeState
  ),
}));

vi.mock('../../../stores/agent-activity-slice', () => ({
  selectAgentActivities: (sessionPath: string | null) => (state: typeof storeState) => (
    sessionPath ? (state.agentActivitiesBySession[sessionPath] || []) : []
  ),
}));

const makeBlock = (overrides: Partial<WorkflowInlineBlock>): WorkflowInlineBlock => ({
  taskId: 'wf-1',
  taskTitle: '三行晨诗',
  streamStatus: 'running' as const,
  startedAt: 1000,
  finishedAt: null,
  ...overrides,
});

describe('WorkflowInlineCard', () => {
  beforeEach(() => {
    storeState = {
      currentSessionPath: '/sessions/main.jsonl',
      agents: [],
      agentActivitiesBySession: {
        '/sessions/main.jsonl': [],
      },
    };
    window.t = ((key: string, vars?: Record<string, string | number>) => {
      if (key === 'rightWorkspace.workflow.agents') return `${vars?.n ?? 0} 个智能体`;
      if (key === 'rightWorkspace.workflow.title') return 'Workflow';
      return key;
    }) as typeof window.t;
  });

  afterEach(() => {
    cleanup();
    delete window.t;
  });

  it('显示 workflow 名和静态运行状态', async () => {
    const { WorkflowInlineCard } = await import('../WorkflowInlineCard');

    const { container } = render(<WorkflowInlineCard block={makeBlock({ streamStatus: 'running' })} />);

    expect(container.textContent).toContain('三行晨诗');
    expect(container.textContent).toContain('◐ 运行中');
    expect(container.querySelector('[data-chat-resource-card]')).toBeTruthy();
  });

  it('done 显示完成状态和耗时', async () => {
    const { WorkflowInlineCard } = await import('../WorkflowInlineCard');

    const { container } = render(
      <WorkflowInlineCard block={makeBlock({ streamStatus: 'done', startedAt: 1000, finishedAt: 6000 })} />,
    );

    expect(container.textContent).toContain('✓ 已完成');
    expect(container.textContent).toContain('5s');
  });

  it('只作为聊天概览，不在聊天流内展开工作流节点或弹窗', async () => {
    const { WorkflowInlineCard } = await import('../WorkflowInlineCard');
    storeState.agentActivitiesBySession['/sessions/main.jsonl'] = [
      {
        id: 'node-agent',
        kind: 'workflow_agent',
        status: 'running',
        sessionPath: '/sessions/main.jsonl',
        parentTaskId: 'wf-1',
        agentId: 'agent-a',
        agentName: 'Agent A',
        label: '整理资料',
      },
    ];

    render(<WorkflowInlineCard block={makeBlock({ streamStatus: 'running' })} />);

    expect(screen.queryByTestId('workflow-inline-popover')).toBeNull();
    expect(document.querySelector('[data-workflow-inline-node]')).toBeNull();
    expect(document.querySelector('[data-workflow-inline-canvas]')).toBeNull();
    expect(screen.queryByRole('button', { name: '三行晨诗' })).toBeNull();
  });
});
