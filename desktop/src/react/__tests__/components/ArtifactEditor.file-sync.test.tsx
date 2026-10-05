/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { Transaction } from '@codemirror/state';
import { createRef } from 'react';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactEditor, type ArtifactEditorHandle } from '../../components/PreviewEditor';
import type { PlatformApi, VersionedWriteResult } from '../../types';

vi.mock('../../utils/checkpoints', () => ({
  requestUserEditCheckpoint: vi.fn(async () => undefined),
}));

function elementRect(width = 960, height = 640): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('ArtifactEditor markdown attachments', () => {
  async function waitForEditorView(ref: RefObject<ArtifactEditorHandle | null>) {
    await waitFor(() => expect(ref.current?.getView()).toBeTruthy(), { timeout: 5000 });
  }

  let elementRectSpy: ReturnType<typeof vi.spyOn>;
  let platform: Partial<PlatformApi> & {
    writeFileBinary: ReturnType<typeof vi.fn>;
    copyFile: ReturnType<typeof vi.fn>;
    getFilePath: ReturnType<typeof vi.fn>;
    getFileUrl: ReturnType<typeof vi.fn>;
    writeFileIfUnchanged: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    elementRectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => elementRect());
    Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList);
    Range.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    }));
    platform = {
      readFile: vi.fn(async () => 'external update'),
      writeFile: vi.fn(async () => true),
      writeFileIfUnchanged: vi.fn(async () => ({
        ok: true,
        conflict: false,
        version: { mtimeMs: 2, size: 10, sha256: 'next' },
      })),
      writeFileBinary: vi.fn(async () => true),
      copyFile: vi.fn(async () => true),
      getFilePath: vi.fn(() => null),
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
      onFileChanged: vi.fn(),
    };
    window.platform = platform as unknown as PlatformApi;
  });

  afterEach(() => {
    cleanup();
    elementRectSpy.mockRestore();
    vi.useRealTimers();
  });

  async function flushSaveTimer() {
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('does not autosave content that arrived from a parent file refresh', async () => {
    const ref = createRef<ArtifactEditorHandle>();

    const { rerender } = render(
      <ArtifactEditor
        ref={ref}
        content="original"
        filePath="/tmp/gsap-note.md"
        mode="markdown"
      />,
    );
    await waitForEditorView(ref);
    vi.useFakeTimers();

    await act(async () => {
      rerender(
        <ArtifactEditor
          ref={ref}
          content="external update"
          filePath="/tmp/gsap-note.md"
          fileVersion={{ mtimeMs: 2, size: 15, sha256: 'external' }}
          mode="markdown"
        />,
      );
      await Promise.resolve();
    });

    expect(ref.current?.getView()?.state.doc.toString()).toBe('external update');
    await flushSaveTimer();

    expect(platform.writeFileIfUnchanged).not.toHaveBeenCalled();
    expect(platform.writeFile).not.toHaveBeenCalled();
  });

  it('waits for a hidden document to become visible before creating CodeMirror', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    let visibilityState: Document['visibilityState'] = 'hidden';
    const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState);

    try {
      render(
        <ArtifactEditor
          ref={ref}
          content={'alpha\nbeta'}
          filePath="/tmp/gsap-note.md"
          mode="markdown"
        />,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(ref.current?.getView()).toBeNull();

      visibilityState = 'visible';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitForEditorView(ref);
      expect(ref.current?.getView()?.state.doc.toString()).toBe('alpha\nbeta');
    } finally {
      visibilitySpy.mockRestore();
    }
  });

  it('retries editor creation until the host has a measurable box', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    let measurable = false;
    elementRectSpy.mockImplementation(() => (measurable ? elementRect() : elementRect(0, 0)));

    render(
      <ArtifactEditor
        ref={ref}
        content={'alpha\nbeta'}
        filePath="/tmp/gsap-note.md"
        mode="markdown"
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ref.current?.getView()).toBeNull();

    measurable = true;
    await waitForEditorView(ref);
    expect(ref.current?.getView()?.state.doc.toString()).toBe('alpha\nbeta');
  });

  it('saves user edits with the file version that was last loaded from disk', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    const fileVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const nextVersion = { mtimeMs: 2, size: 10, sha256: 'next' };
    const onContentChange = vi.fn();
    platform.writeFileIfUnchanged.mockResolvedValueOnce({
      ok: true,
      conflict: false,
      version: nextVersion,
    });

    render(
      <ArtifactEditor
        ref={ref}
        content="original"
        filePath="/tmp/gsap-note.md"
        fileVersion={fileVersion}
        mode="markdown"
        onContentChange={onContentChange}
      />,
    );
    await waitForEditorView(ref);
    vi.useFakeTimers();

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'original'.length, insert: 'user edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
    });
    await flushSaveTimer();

    expect(platform.writeFileIfUnchanged).toHaveBeenCalledWith(
      '/tmp/gsap-note.md',
      'user edit',
      fileVersion,
    );
    expect(onContentChange).toHaveBeenLastCalledWith('user edit', nextVersion);
    expect(platform.writeFile).not.toHaveBeenCalled();
  });

  it('uses saveDocument for editable remote content without a local file path', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    const fileVersion = { mtimeMs: 1, size: 6, sha256: 'remote' };
    const nextVersion = { mtimeMs: 2, size: 11, sha256: 'remote-next' };
    const saveDocument = vi.fn(async (): Promise<VersionedWriteResult> => ({
      ok: true,
      conflict: false,
      version: nextVersion,
    }));
    const onContentChange = vi.fn();

    render(
      <ArtifactEditor
        ref={ref}
        content="remote"
        fileVersion={fileVersion}
        saveDocument={saveDocument}
        mode="markdown"
        onContentChange={onContentChange}
      />,
    );
    await waitForEditorView(ref);
    vi.useFakeTimers();

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'remote'.length, insert: 'remote edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
    });
    await flushSaveTimer();

    expect(saveDocument).toHaveBeenCalledWith('remote edit', fileVersion);
    expect(platform.writeFileIfUnchanged).not.toHaveBeenCalled();
    expect(platform.writeFile).not.toHaveBeenCalled();
    expect(onContentChange).toHaveBeenLastCalledWith('remote edit', nextVersion);
  });

  it('preserves the cursor when parent content is refreshed', async () => {
    const ref = createRef<ArtifactEditorHandle>();

    const { rerender } = render(
      <ArtifactEditor
        ref={ref}
        content="abcdef"
        filePath="/tmp/gsap-note.md"
        mode="markdown"
      />,
    );
    await waitForEditorView(ref);

    await act(async () => {
      ref.current?.getView()?.dispatch({ selection: { anchor: 3 } });
    });

    await act(async () => {
      rerender(
        <ArtifactEditor
          ref={ref}
          content="abcXYZdef"
          filePath="/tmp/gsap-note.md"
          mode="markdown"
        />,
      );
      await Promise.resolve();
    });

    const view = ref.current?.getView();
    expect(view?.state.doc.toString()).toBe('abcXYZdef');
    expect(view?.state.selection.main.head).toBe(3);
  });

  it('preserves scroll position when parent content is refreshed', async () => {
    const ref = createRef<ArtifactEditorHandle>();

    const { rerender } = render(
      <ArtifactEditor
        ref={ref}
        content="line 1\nline 2\nline 3"
        filePath="/tmp/gsap-note.md"
        mode="markdown"
      />,
    );
    await waitForEditorView(ref);

    const view = ref.current?.getView();
    expect(view).toBeTruthy();
    if (!view) return;

    const originalDispatch = view.dispatch.bind(view);
    vi.spyOn(view, 'dispatch').mockImplementation((...specs) => {
      originalDispatch(...specs);
      view.scrollDOM.scrollTop = 0;
      view.scrollDOM.scrollLeft = 0;
    });
    view.scrollDOM.scrollTop = 240;
    view.scrollDOM.scrollLeft = 16;

    await act(async () => {
      rerender(
        <ArtifactEditor
          ref={ref}
          content="line 1\ninserted\nline 2\nline 3"
          filePath="/tmp/gsap-note.md"
          mode="markdown"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.scrollDOM.scrollTop).toBe(240);
    expect(view.scrollDOM.scrollLeft).toBe(16);
  });

  it('merges cover-only refresh into unsaved markdown edits instead of replacing them', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    const loadedVersion = { mtimeMs: 1, size: 20, sha256: 'loaded' };
    const coverVersion = { mtimeMs: 2, size: 80, sha256: 'cover' };
    const saved = '# Demo\n\nBody';
    const coverUpdated = [
      '---',
      'cover:',
      '  image: 文本附件/cover.png',
      '  displayHeight: 320',
      '---',
      '# Demo',
      '',
      'Body',
    ].join('\n');
    const onContentChange = vi.fn();

    const { rerender } = render(
      <ArtifactEditor
        ref={ref}
        content={saved}
        filePath="/tmp/gsap-note.md"
        fileVersion={loadedVersion}
        mode="markdown"
        onContentChange={onContentChange}
      />,
    );
    await waitForEditorView(ref);
    vi.useFakeTimers();

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: saved.length, insert: '# Demo\n\nBody with local draft' },
        annotations: Transaction.userEvent.of('input.type'),
      });
    });

    await act(async () => {
      rerender(
        <ArtifactEditor
          ref={ref}
          content={coverUpdated}
          filePath="/tmp/gsap-note.md"
          fileVersion={coverVersion}
          mode="markdown"
          onContentChange={onContentChange}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const merged = [
      '---',
      'cover:',
      '  image: 文本附件/cover.png',
      '  displayHeight: 320',
      '---',
      '# Demo',
      '',
      'Body with local draft',
    ].join('\n');

    expect(ref.current?.getView()?.state.doc.toString()).toBe(merged);
    expect(onContentChange).toHaveBeenCalledWith(merged);
    await flushSaveTimer();
    expect(platform.writeFileIfUnchanged).toHaveBeenCalledWith(
      '/tmp/gsap-note.md',
      merged,
      coverVersion,
    );
  });

  it('queues saves and does not publish stale save results over newer edits', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    const loadedVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const firstVersion = { mtimeMs: 2, size: 10, sha256: 'first' };
    const secondVersion = { mtimeMs: 3, size: 11, sha256: 'second' };
    const onContentChange = vi.fn();

    let resolveFirst!: (value: VersionedWriteResult) => void;
    const firstWrite = new Promise<VersionedWriteResult>((resolve) => {
      resolveFirst = resolve;
    });

    platform.writeFileIfUnchanged
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValueOnce({
        ok: true,
        conflict: false,
        version: secondVersion,
      });

    render(
      <ArtifactEditor
        ref={ref}
        content="original"
        filePath="/tmp/gsap-note.md"
        fileVersion={loadedVersion}
        mode="markdown"
        onContentChange={onContentChange}
      />,
    );
    await waitForEditorView(ref);
    vi.useFakeTimers();

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'original'.length, insert: 'first edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
    });
    await flushSaveTimer();
    expect(platform.writeFileIfUnchanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'first edit'.length, insert: 'second edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
    });
    await flushSaveTimer();
    expect(platform.writeFileIfUnchanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({
        ok: true,
        conflict: false,
        version: firstVersion,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(platform.writeFileIfUnchanged).toHaveBeenCalledTimes(2);
    expect(platform.writeFileIfUnchanged).toHaveBeenLastCalledWith(
      '/tmp/gsap-note.md',
      'second edit',
      firstVersion,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onContentChange).not.toHaveBeenCalledWith('first edit', firstVersion);
    expect(onContentChange).toHaveBeenLastCalledWith('second edit', secondVersion);
  });

  it('treats a same-content file version refresh as the saved editor baseline', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    const loadedVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const caughtUpVersion = { mtimeMs: 2, size: 10, sha256: 'caught-up' };
    const externalVersion = { mtimeMs: 3, size: 15, sha256: 'external' };

    const { rerender } = render(
      <ArtifactEditor
        ref={ref}
        content="original"
        filePath="/tmp/gsap-note.md"
        fileVersion={loadedVersion}
        mode="markdown"
      />,
    );
    await waitForEditorView(ref);

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'original'.length, insert: 'local edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      await Promise.resolve();
    });

    await act(async () => {
      rerender(
        <ArtifactEditor
          ref={ref}
          content="local edit"
          filePath="/tmp/gsap-note.md"
          fileVersion={loadedVersion}
          mode="markdown"
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      rerender(
        <ArtifactEditor
          ref={ref}
          content="local edit"
          filePath="/tmp/gsap-note.md"
          fileVersion={caughtUpVersion}
          mode="markdown"
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      rerender(
        <ArtifactEditor
          ref={ref}
          content="external update"
          filePath="/tmp/gsap-note.md"
          fileVersion={externalVersion}
          mode="markdown"
        />,
      );
      await Promise.resolve();
    });

    expect(ref.current?.getView()?.state.doc.toString()).toBe('external update');
  });

  it('re-publishes the editor draft when rejecting an unapplied external refresh', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    const loadedVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const externalVersion = { mtimeMs: 2, size: 15, sha256: 'external' };
    const onContentChange = vi.fn();
    const notices: Array<{ text?: string; type?: string }> = [];
    const onNotice = vi.fn((event: Event) => {
      notices.push((event as CustomEvent).detail ?? {});
    });
    window.addEventListener('gsap-inline-notice', onNotice);

    try {
      const { rerender } = render(
        <ArtifactEditor
          ref={ref}
          content="original"
          filePath="/tmp/gsap-note.md"
          fileVersion={loadedVersion}
          mode="markdown"
          onContentChange={onContentChange}
        />,
      );
      await waitForEditorView(ref);

      await act(async () => {
        ref.current?.getView()?.dispatch({
          changes: { from: 0, to: 'original'.length, insert: 'local draft' },
          annotations: Transaction.userEvent.of('input.type'),
        });
        await Promise.resolve();
      });

      await act(async () => {
        rerender(
          <ArtifactEditor
            ref={ref}
            content="external update"
            filePath="/tmp/gsap-note.md"
            fileVersion={externalVersion}
            mode="markdown"
            onContentChange={onContentChange}
          />,
        );
        await Promise.resolve();
      });

      expect(ref.current?.getView()?.state.doc.toString()).toBe('local draft');
      expect(onContentChange).toHaveBeenLastCalledWith('local draft');
      expect(onContentChange).toHaveBeenCalledTimes(2);
      expect(notices.some(notice => String(notice.text ?? '').includes('settings.fileChangedOnDisk'))).toBe(true);
    } finally {
      window.removeEventListener('gsap-inline-notice', onNotice);
    }
  });

  it('pastes clipboard images into the markdown attachment folder at the cursor', async () => {
    const ref = createRef<ArtifactEditorHandle>();

    const { container } = render(
      <ArtifactEditor
        ref={ref}
        content={'Hello\n'}
        filePath="/tmp/note.md"
        mode="markdown"
      />,
    );

    await waitForEditorView(ref);

    await act(async () => {
      ref.current?.getView()?.dispatch({ selection: { anchor: 'Hello\n'.length } });
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'clip image.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [file],
        getData: vi.fn(() => ''),
        types: ['Files'],
      },
    });

    await act(async () => {
      container.querySelector('.cm-content')?.dispatchEvent(paste);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(platform.writeFileBinary).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/文本附件\/clip image-\d{8}-\d{6}\.png$/),
      'AQID',
    );
    expect(ref.current?.getView()?.state.doc.toString()).toMatch(
      /^Hello\n!\[clip image\]\(<文本附件\/clip image-\d{8}-\d{6}\.png>\)$/,
    );
  });

  it('drops external files into the markdown attachment folder without reading them into renderer memory', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    platform.getFilePath.mockReturnValue('/source/drop.png');

    const { container } = render(
      <ArtifactEditor
        ref={ref}
        content={'Start\n'}
        filePath="/tmp/note.md"
        mode="markdown"
      />,
    );

    await waitForEditorView(ref);

    await act(async () => {
      ref.current?.getView()?.dispatch({ selection: { anchor: 'Start\n'.length } });
    });

    const file = new File([new Uint8Array([4, 5, 6])], 'drop.png', { type: 'image/png' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        files: [file],
        types: ['Files'],
        dropEffect: 'copy',
        getData: vi.fn(() => ''),
      },
    });
    Object.defineProperty(drop, 'clientX', { value: 8 });
    Object.defineProperty(drop, 'clientY', { value: 80 });

    await act(async () => {
      container.querySelector('.cm-content')?.dispatchEvent(drop);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(platform.copyFile).toHaveBeenCalledWith(
      '/source/drop.png',
      expect.stringMatching(/^\/tmp\/文本附件\/drop-\d{8}-\d{6}\.png$/),
    );
    expect(platform.writeFileBinary).not.toHaveBeenCalled();
    expect(ref.current?.getView()?.state.doc.toString()).toMatch(
      /^Start\n!\[drop\]\(<文本附件\/drop-\d{8}-\d{6}\.png>\)$/,
    );
  });

  it('resolves relative markdown image previews from the edited file path', async () => {
    const ref = createRef<ArtifactEditorHandle>();

    const { container } = render(
      <ArtifactEditor
        ref={ref}
        content={'Intro\n![demo](文本附件/demo.png)'}
        filePath="/vault/notes/day.md"
        mode="markdown"
      />,
    );

    await waitForEditorView(ref);

    await waitFor(() => {
      const img = container.querySelector<HTMLImageElement>('.cm-image-widget img');
      expect(img?.getAttribute('src')).toBe('file:///vault/notes/文本附件/demo.png');
    });
  });
});
