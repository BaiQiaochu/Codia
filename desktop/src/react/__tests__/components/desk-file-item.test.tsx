// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadDeskFilesMock = vi.fn((..._args: unknown[]) => undefined);
const deskFullPathMock = vi.fn((name: string) => `/desk/${name}`);
const deskCreateMindmapFromDocumentMock = vi.fn(async (..._args: unknown[]) => true);
const deskMoveFilesMock = vi.fn(async (..._args: unknown[]) => {});
const deskRemoveFileMock = vi.fn(async (..._args: unknown[]) => {});
const gsapFetchMock = vi.fn((..._args: unknown[]) => undefined);
const openFilePreviewMock = vi.fn((..._args: unknown[]) => undefined);

let storeState = {
  deskCurrentPath: '',
  deskBasePath: '/desk',
};

vi.mock('../../stores', () => ({
  get useStore() {
    return Object.assign(
      (selector?: (s: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState),
      {
        getState: () => storeState,
        setState: (partial: Record<string, unknown>) => { storeState = { ...storeState, ...partial }; },
      },
    );
  },
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: (...args: unknown[]) => loadDeskFilesMock(...args),
  deskFullPath: (name: string) => deskFullPathMock(name),
  deskCreateMindmapFromDocument: (name: string) => deskCreateMindmapFromDocumentMock(name),
  deskMoveFiles: (...args: unknown[]) => deskMoveFilesMock(...args),
  deskRemoveFile: (...args: unknown[]) => deskRemoveFileMock(...args),
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
}));

vi.mock('../../utils/file-preview', () => ({
  openFilePreview: (...args: unknown[]) => openFilePreviewMock(...args),
}));

describe('DeskFileItem', () => {
  beforeEach(() => {
    storeState = { deskCurrentPath: '', deskBasePath: '/desk' };
    loadDeskFilesMock.mockReset();
    deskFullPathMock.mockClear();
    deskCreateMindmapFromDocumentMock.mockReset();
    deskMoveFilesMock.mockReset();
    deskRemoveFileMock.mockReset();
    gsapFetchMock.mockReset();
    openFilePreviewMock.mockReset();
    (window as typeof window & { t?: (key: string, vars?: Record<string, unknown>) => string }).t = (key, vars) =>
      vars?.n ? `${key}:${vars.n}` : key;
    (window as unknown as { platform?: { startDrag?: (paths: string | string[]) => void; showInFinder?: (path: string) => void; openFile?: (path: string) => void; getFilePath?: (file: File) => string | null } }).platform = {
      startDrag: vi.fn(),
      showInFinder: vi.fn(),
      openFile: vi.fn(),
      getFilePath: vi.fn(() => null),
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('opens file preview from desk on double click', async () => {
    const { DeskFileItem } = await import('../../components/desk/DeskFileItem');

    const view = render(
      <DeskFileItem
        file={{ name: 'readme.md', isDir: false, size: 12, mtime: '2026-04-24T00:00:00.000Z' }}
        selected={false}
        onSelect={vi.fn()}
        allSelectedFiles={[]}
        renamingFile={null}
        renameValue=""
        onRenameStart={vi.fn()}
        onRenameChange={vi.fn()}
        onRenameCommit={vi.fn()}
        onRenameCancel={vi.fn()}
        onShowContextMenu={vi.fn()}
      />,
    );

    fireEvent.doubleClick(view.container.querySelector('[data-desk-item]') as HTMLElement);

    expect(openFilePreviewMock).toHaveBeenCalledWith('/desk/readme.md', 'readme.md', 'md', { origin: 'desk' });
  });

  it('commits rename on Enter', async () => {
    const { DeskFileItem } = await import('../../components/desk/DeskFileItem');
    const onRenameCommit = vi.fn();

    const view = render(
      <DeskFileItem
        file={{ name: 'note.md', isDir: false, size: 12, mtime: '2026-04-24T00:00:00.000Z' }}
        selected={false}
        onSelect={vi.fn()}
        allSelectedFiles={[]}
        renamingFile="note.md"
        renameValue="note-new.md"
        onRenameStart={vi.fn()}
        onRenameChange={vi.fn()}
        onRenameCommit={onRenameCommit}
        onRenameCancel={vi.fn()}
        onShowContextMenu={vi.fn()}
      />,
    );

    const input = view.container.querySelector('input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter', nativeEvent: { isComposing: false } });

    expect(onRenameCommit).toHaveBeenCalled();
  });

  it('offers document-to-mindmap creation from a document context menu', async () => {
    const { DeskFileItem } = await import('../../components/desk/DeskFileItem');
    const onShowContextMenu = vi.fn();

    const view = render(
      <DeskFileItem
        file={{ name: 'brief.md', isDir: false, size: 12, mtime: '2026-04-24T00:00:00.000Z' }}
        selected={false}
        onSelect={vi.fn()}
        allSelectedFiles={[]}
        renamingFile={null}
        renameValue=""
        onRenameStart={vi.fn()}
        onRenameChange={vi.fn()}
        onRenameCommit={vi.fn()}
        onRenameCancel={vi.fn()}
        onShowContextMenu={onShowContextMenu}
      />,
    );

    fireEvent.contextMenu(view.container.querySelector('[data-desk-item]') as HTMLElement);

    const menu = onShowContextMenu.mock.calls[0][0];
    const item = menu.items.find((entry: { label?: string }) => entry.label === 'desk.ctx.createMindmapFromDocument');
    expect(item).toBeTruthy();
    await item.action();
    expect(deskCreateMindmapFromDocumentMock).toHaveBeenCalledWith('brief.md');
  });

  it('does not offer document-to-mindmap creation for folders', async () => {
    const { DeskFileItem } = await import('../../components/desk/DeskFileItem');
    const onShowContextMenu = vi.fn();

    const view = render(
      <DeskFileItem
        file={{ name: 'docs', isDir: true, size: 0, mtime: '2026-04-24T00:00:00.000Z' }}
        selected={false}
        onSelect={vi.fn()}
        allSelectedFiles={[]}
        renamingFile={null}
        renameValue=""
        onRenameStart={vi.fn()}
        onRenameChange={vi.fn()}
        onRenameCommit={vi.fn()}
        onRenameCancel={vi.fn()}
        onShowContextMenu={onShowContextMenu}
      />,
    );

    fireEvent.contextMenu(view.container.querySelector('[data-desk-item]') as HTMLElement);

    const menu = onShowContextMenu.mock.calls[0][0];
    expect(menu.items.some((entry: { label?: string }) => entry.label === 'desk.ctx.createMindmapFromDocument')).toBe(false);
  });

  it('moves internally dragged desk files into a folder on drop', async () => {
    const { DeskFileItem } = await import('../../components/desk/DeskFileItem');
    const { setDeskDragNames } = await import('../../components/desk/desk-types');

    setDeskDragNames(['a.txt', 'folder']);

    const view = render(
      <DeskFileItem
        file={{ name: 'folder', isDir: true, size: 0, mtime: '2026-04-24T00:00:00.000Z' }}
        selected={false}
        onSelect={vi.fn()}
        allSelectedFiles={['a.txt', 'folder']}
        renamingFile={null}
        renameValue=""
        onRenameStart={vi.fn()}
        onRenameChange={vi.fn()}
        onRenameCommit={vi.fn()}
        onRenameCancel={vi.fn()}
        onShowContextMenu={vi.fn()}
      />,
    );

    fireEvent.drop(view.container.querySelector('[data-desk-item]') as HTMLElement, {
      dataTransfer: { files: [] },
    });

    await waitFor(() => {
      expect(deskMoveFilesMock).toHaveBeenCalledWith(['a.txt'], 'folder');
    });
    expect(gsapFetchMock).not.toHaveBeenCalled();
  });
});
