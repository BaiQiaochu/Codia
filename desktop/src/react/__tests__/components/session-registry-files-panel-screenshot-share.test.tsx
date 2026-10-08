// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionFilesMock = vi.hoisted(() => ({
  files: [] as any[],
}));

const screenshotMock = vi.hoisted(() => ({
  takeMarkdownFileScreenshot: vi.fn(async () => undefined),
}));

let storeState: Record<string, unknown>;

vi.mock('../../stores', () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}));

vi.mock('../../stores/selectors/file-refs', () => ({
  selectSessionFiles: () => sessionFilesMock.files,
}));

vi.mock('../../utils/remote-file-preview', () => ({
  fileRefDownloadUrl: () => null,
  isWebRuntime: () => false,
  openFileRefPreview: vi.fn(),
}));

vi.mock('../../utils/screenshot', () => screenshotMock);

import { SessionRegistryFilesPanel } from '../../components/right-workspace/SessionRegistryFilesPanel';

describe('SessionRegistryFilesPanel markdown screenshot share', () => {
  beforeEach(() => {
    screenshotMock.takeMarkdownFileScreenshot.mockClear();
    sessionFilesMock.files = [{
      id: 'file-1',
      fileId: 'file-1',
      name: 'report.md',
      path: '/tmp/session-files/a1b2c3',
      kind: 'markdown',
      ext: 'md',
      source: 'session-registry',
      status: 'available',
      timestamp: 1,
    }];
    storeState = {
      currentSessionPath: '/sessions/a.jsonl',
    };
    window.t = (key: string) => {
      if (key === 'common.screenshotShare') return 'Screenshot share';
      return key;
    };
  });

  afterEach(() => {
    cleanup();
    delete window.t;
  });

  it('adds screenshot share to the context menu for one local markdown session file', () => {
    render(<SessionRegistryFilesPanel />);

    fireEvent.contextMenu(screen.getByText('report.md'), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByText('Screenshot share'));

    expect(screenshotMock.takeMarkdownFileScreenshot).toHaveBeenCalledWith(
      '/tmp/session-files/a1b2c3',
      { fileName: 'report.md' },
    );
  });
});
