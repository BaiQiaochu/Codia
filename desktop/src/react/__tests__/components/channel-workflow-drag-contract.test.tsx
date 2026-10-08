// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const gsapFetchMock = vi.fn();

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
}));

function workflowActionButton(pattern: RegExp) {
  const button = screen.getAllByRole('button').find((element) => pattern.test(element.textContent || ''));
  if (!button) throw new Error(`Missing workflow action button: ${pattern}`);
  return button;
}

describe('ChannelWorkflowWindow drag contract', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    window.localStorage.clear();
    gsapFetchMock.mockReset();
    gsapFetchMock.mockResolvedValue({
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
      channelMembers: ['worker-a'],
      agents: [{ id: 'worker-a', name: '工人A', yuan: 'gsap', isPrimary: false }],
      currentAgentId: 'gsap',
      channelAgentActivities: { ch_crew: {} },
      channelTickerStatus: { ch_crew: { running: false } },
    } as never);
  });

  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  it('moves custom nodes and creates edges by dragging from an output port to another node', async () => {
    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);

    const addButton = workflowActionButton(/添加节点|娣诲姞鑺傜偣/);
    fireEvent.click(addButton);
    fireEvent.click(addButton);

    await waitFor(() => expect(document.querySelectorAll<HTMLElement>('[data-custom="true"]')).toHaveLength(2));
    const [firstNode, secondNode] = Array.from(document.querySelectorAll<HTMLElement>('[data-custom="true"]'));
    const firstNodeId = firstNode.dataset.workflowNodeId || '';
    const secondNodeId = secondNode.dataset.workflowNodeId || '';

    fireEvent.pointerDown(firstNode, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 160, clientY: 125 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 160, clientY: 125 });

    await waitFor(() => {
      const movedNode = document.querySelector<HTMLElement>(`[data-workflow-node-id="${firstNodeId}"]`);
      expect(movedNode?.style.left).toBe('372px');
      expect(movedNode?.style.top).toBe('273px');
    });

    const movedNode = document.querySelector<HTMLElement>(`[data-workflow-node-id="${firstNodeId}"]`);
    const outputPort = movedNode?.querySelector<HTMLElement>('[data-workflow-port="out"]');
    expect(outputPort).toBeTruthy();

    fireEvent.pointerDown(outputPort as HTMLElement, { pointerId: 2, button: 0, clientX: 580, clientY: 320 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 620, clientY: 350 });
    fireEvent.pointerUp(secondNode, { pointerId: 2, clientX: 620, clientY: 350 });

    await waitFor(() => {
      expect(document.querySelector(`[data-workflow-edge-from="${firstNodeId}"][data-workflow-edge-to="${secondNodeId}"]`)).toBeInTheDocument();
    });
  });

  it('zooms the workflow canvas with the mouse wheel', async () => {
    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);

    const scroller = screen.getByLabelText('工作流画布');
    const canvas = document.querySelector<HTMLElement>('[data-workflow-canvas="true"]');
    expect(canvas).toBeTruthy();

    fireEvent.wheel(scroller, { deltaY: -120, clientX: 180, clientY: 160 });

    await waitFor(() => {
      expect(canvas?.style.transform).toBe('scale(1.1)');
    });
  });

  it('deletes individual timeline records and clears visible timeline records', async () => {
    const { ChannelWorkflowWindow } = await import('../../components/channels/ChannelWorkflowWindow');
    render(<ChannelWorkflowWindow open onClose={vi.fn()} />);

    const addButton = workflowActionButton(/添加节点|娣诲姞鑺傜偣/);
    fireEvent.click(addButton);

    const deleteButton = await screen.findByRole('button', { name: /删除时间线记录：自定义任务 1/ });
    fireEvent.click(deleteButton);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /删除时间线记录：自定义任务 1/ })).toBeNull();
    });

    fireEvent.click(addButton);
    await screen.findByRole('button', { name: /删除时间线记录：自定义任务 2/ });
    fireEvent.click(workflowActionButton(/^清空$/));

    await waitFor(() => {
      expect(screen.getByText('暂无运行记录')).toBeInTheDocument();
    });
  });
});
