// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeTimeline } from '../../components/chat/RuntimeTimeline';
import { useStore } from '../../stores';

describe('RuntimeTimeline', () => {
  beforeEach(() => {
    window.t = (key: string) => ({
      'chat.runtimeTimeline.summary.completed': '已完成',
      'chat.runtimeTimeline.summary.failed': '失败',
      'chat.runtimeTimeline.toggleExpand': '展开执行时间线',
      'chat.runtimeTimeline.toggleCollapse': '收起执行时间线',
      'chat.runtimeTimeline.queued': '排队',
      'chat.runtimeTimeline.modelRoute': '路由模型',
      'chat.runtimeTimeline.thinking': '思考',
      'chat.runtimeTimeline.completed': '已完成',
      'chat.runtimeTimeline.failed': '失败',
      'chat.runtimeTimeline.tools.todoWrite': '更新任务清单',
    } as Record<string, string>)[key] || key;
    useStore.setState({
      runtimeTimelineByTrace: {},
      runtimeTimelineTraceIdsBySession: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('collapses successful timelines by default and expands on click', () => {
    const state = useStore.getState();
    state.upsertRuntimeTimelineEvent({
      id: 'ok:queued',
      turnTraceId: 'ok',
      sessionPath: 's',
      type: 'queued',
      label: 'Queued',
      status: 'success',
      startedAt: new Date(0).toISOString(),
    });
    state.upsertRuntimeTimelineEvent({
      id: 'ok:completed',
      turnTraceId: 'ok',
      sessionPath: 's',
      type: 'completed',
      label: 'Completed',
      status: 'success',
      startedAt: new Date(1).toISOString(),
    });

    render(<RuntimeTimeline turnTraceId="ok" />);

    expect(screen.queryByText('排队')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开执行时间线' }));
    expect(screen.getByText('排队')).toBeTruthy();
  });

  it('auto-expands failed timelines', () => {
    const state = useStore.getState();
    state.upsertRuntimeTimelineEvent({
      id: 'bad:thinking',
      turnTraceId: 'bad',
      sessionPath: 's',
      type: 'thinking',
      label: 'Thinking',
      status: 'running',
      startedAt: new Date(0).toISOString(),
    });
    state.upsertRuntimeTimelineEvent({
      id: 'bad:failed',
      turnTraceId: 'bad',
      sessionPath: 's',
      type: 'failed',
      label: 'Failed',
      status: 'error',
      startedAt: new Date(1).toISOString(),
    });

    render(<RuntimeTimeline turnTraceId="bad" />);

    expect(screen.getByText('思考')).toBeTruthy();
    expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1);
  });

  it('renders known tool names as readable Chinese labels', () => {
    const state = useStore.getState();
    state.upsertRuntimeTimelineEvent({
      id: 'tool:todo',
      turnTraceId: 'tool',
      sessionPath: 's',
      type: 'tool_call',
      label: 'todo_write',
      status: 'success',
      startedAt: new Date(0).toISOString(),
      tool: { name: 'todo_write' },
    });
    state.upsertRuntimeTimelineEvent({
      id: 'tool:completed',
      turnTraceId: 'tool',
      sessionPath: 's',
      type: 'completed',
      label: 'Completed',
      status: 'success',
      startedAt: new Date(1).toISOString(),
    });

    render(<RuntimeTimeline turnTraceId="tool" />);

    fireEvent.click(screen.getByRole('button', { name: '展开执行时间线' }));
    expect(screen.getByText('更新任务清单')).toBeTruthy();
  });
});
