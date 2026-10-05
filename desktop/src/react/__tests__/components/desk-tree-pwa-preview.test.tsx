// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadDeskTreeFilesMock = vi.fn(async (..._args: unknown[]) => {});
const openFilePreviewMock = vi.fn((..._args: unknown[]) => undefined);
const openWorkbenchFilePreviewMock = vi.fn(async (..._args: unknown[]) => {});

let storeState: Record<string, unknown> = {};

vi.mock('../../stores', () => ({
  useStore: Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) => selector ? selector(storeState) : storeState,
    {
      getState: () => storeState,
      setState: (partial: Record<string, unknown> | ((state: Record<string, unknown>) => Record<string, unknown>)) => {
        const patch = typeof partial === 'function' ? partial(storeState) : partial;
        storeState = { ...storeState, ...patch };
      },
    },
  ),
}));

vi.mock('../../stores/desk-actions', () => ({
  deskCreateMindmapFromDocument: vi.fn(),
  deskMoveTreeFiles: vi.fn(),
  deskRenameTreeItem: vi.fn(),
  deskTrashTreeItems: vi.fn(),
  deskUploadFilesToSubdir: vi.fn(),
  loadDeskTreeFiles: (...args: unknown[]) => loadDeskTreeFilesMock(...args),
}));

vi.mock('../../stores/workspace-ui-state-actions', () => ({
  schedulePersistCurrentWorkspaceUiState: vi.fn(),
}));

vi.mock('../../utils/file-preview', () => ({
  openFilePreview: (...args: unknown[]) => openFilePreviewMock(...args),
}));

vi.mock('../../utils/remote-file-preview', () => ({
  isWebRuntime: () => document.documentElement.getAttribute('data-platform') === 'web',
  openWorkbenchFilePreview: (...args: unknown[]) => openWorkbenchFilePreviewMock(...args),
}));

describe('DeskTree PWA preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.setAttribute('data-platform', 'web');
    storeState = {
      deskBasePath: '/workspace',
      deskFiles: [{ name: 'readme.md', isDir: false, size: 12, mtime: '2026-05-17T00:00:00.000Z' }],
      deskTreeFilesByPath: {
        '': [{ name: 'readme.md', isDir: false, size: 12, mtime: '2026-05-17T00:00:00.000Z' }],
      },
      deskExpandedPaths: [],
      deskSelectedPath: '',
      setDeskSelectedPath: vi.fn((path: string) => { storeState.deskSelectedPath = path; }),
      setDeskExpandedPaths: vi.fn((paths: string[]) => { storeState.deskExpandedPaths = paths; }),
      vscodeFileIconThemes: [],
    };
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-platform');
  });

  it('opens files through the unified workbench preview instead of desktop file paths on PWA', async () => {
    const { DeskTree } = await import('../../components/desk/DeskTree');

    const view = render(
      <DeskTree
        sortMode="name-asc"
        typeFilters={[]}
        onShowMenu={vi.fn()}
      />,
    );

    fireEvent.doubleClick(view.getByRole('treeitem', { name: 'readme.md' }));

    expect(openWorkbenchFilePreviewMock).toHaveBeenCalledWith(expect.objectContaining({
      file: expect.objectContaining({ name: 'readme.md', isDir: false }),
      subdir: '',
    }));
    expect(openFilePreviewMock).not.toHaveBeenCalled();
  });

  it('exposes the full filename on the hovered tree row', async () => {
    const longName = 'very-long-report-name-that-truncates.md';
    storeState = {
      ...storeState,
      deskFiles: [{ name: longName, isDir: false, size: 12, mtime: '2026-05-17T00:00:00.000Z' }],
      deskTreeFilesByPath: {
        '': [{ name: longName, isDir: false, size: 12, mtime: '2026-05-17T00:00:00.000Z' }],
      },
    };
    const { DeskTree } = await import('../../components/desk/DeskTree');

    const view = render(
      <DeskTree
        sortMode="name-asc"
        typeFilters={[]}
        onShowMenu={vi.fn()}
      />,
    );

    expect(view.getByRole('treeitem', { name: longName }).getAttribute('title')).toBe(longName);
  });

  it('opens a right-workspace file on a single click when requested by the host panel', async () => {
    document.documentElement.setAttribute('data-platform', 'desktop');
    const onOpenFile = vi.fn();
    const { DeskTree } = await import('../../components/desk/DeskTree');
    const view = render(
      <DeskTree
        sortMode="name-asc"
        typeFilters={[]}
        onShowMenu={vi.fn()}
        onOpenFile={onOpenFile}
        openFilesOnSingleClick
      />,
    );

    fireEvent.click(view.getByRole('treeitem', { name: 'readme.md' }));

    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      name: 'readme.md',
      ext: 'md',
    })));
  });
});
