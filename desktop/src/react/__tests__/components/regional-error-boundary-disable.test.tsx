// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegionalErrorBoundary } from '../../components/RegionalErrorBoundary';

function CrashingRegion(): React.ReactElement {
  throw new Error('preview renderer crashed');
}

describe('RegionalErrorBoundary disable mode', () => {
  const originalConsoleError = console.error;

  beforeEach(() => {
    console.error = vi.fn();
    window.t = ((key: string) => {
      if (key === 'error.regionUnavailable') return '此区域暂时无法显示';
      if (key === 'action.retry') return '重试';
      return key;
    }) as typeof window.t;
  });

  afterEach(() => {
    console.error = originalConsoleError;
    cleanup();
    delete window.t;
  });

  it('can disable a crashing region without rendering the generic unavailable panel', async () => {
    const onDisableRegion = vi.fn();

    render(
      <RegionalErrorBoundary region="preview" onDisableRegion={onDisableRegion}>
        <CrashingRegion />
      </RegionalErrorBoundary>,
    );

    await waitFor(() => expect(onDisableRegion).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('此区域暂时无法显示')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('hides the regional fallback panel by default when a child region crashes', async () => {
    render(
      <RegionalErrorBoundary region="chat">
        <CrashingRegion />
      </RegionalErrorBoundary>,
    );

    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(screen.queryByText('此区域暂时无法显示')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('renders an explicit fallback when a critical region crashes', async () => {
    render(
      <RegionalErrorBoundary
        region="chat"
        fallback={<div role="alert">聊天区域渲染异常，请切换会话或重试。</div>}
      >
        <CrashingRegion />
      </RegionalErrorBoundary>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('聊天区域渲染异常');
  });
});
