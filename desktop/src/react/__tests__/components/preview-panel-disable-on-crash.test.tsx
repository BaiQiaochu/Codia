// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../components/PreviewPanel';
import { useStore } from '../../stores';

vi.mock('../../components/preview/PreviewRenderer', () => ({
  ArtifactRenderer: () => {
    throw new Error('preview renderer crashed');
  },
}));

describe('PreviewPanel crash isolation', () => {
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;

  beforeEach(() => {
    console.error = vi.fn();
    console.warn = vi.fn();
    window.t = ((key: string) => {
      if (key === 'error.regionUnavailable') return '此区域暂时无法显示';
      if (key === 'action.retry') return '重试';
      return key;
    }) as typeof window.t;
    useStore.setState({
      currentSessionPath: null,
      previewOpen: true,
      previewByOwner: {
        desk: {
          artifacts: [{
            id: 'broken-preview',
            type: 'html',
            title: 'broken.html',
            content: '<div>broken</div>',
            filePath: '/tmp/broken.html',
          }],
          openTabs: ['broken-preview'],
          activeTabId: 'broken-preview',
          markdownPreviewIds: [],
          previewReadingPositions: {},
        },
      },
      setPreviewOpen: (open: boolean) => useStore.setState({ previewOpen: open } as never),
      clearQuoteCandidate: vi.fn(),
      quoteCandidate: null,
    } as never);
  });

  afterEach(() => {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    cleanup();
    delete window.t;
  });

  it('closes the preview module instead of rendering the regional fallback when preview crashes', async () => {
    render(<PreviewPanel />);

    await waitFor(() => expect(useStore.getState().previewOpen).toBe(false));
    expect(screen.queryByText('此区域暂时无法显示')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });
});
