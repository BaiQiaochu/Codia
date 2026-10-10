/**
 * ArtifactEditor
 *
 * CodeMirror 6 editor component used by the preview panel. Core CodeMirror
 * modules and mode-specific extensions are loaded asynchronously so markdown
 * and CSV editing no longer pull the full editor stack into the initial shell.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import type { EditorState, TransactionSpec } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import { loadCodeMirrorCore } from '../editor/codemirror-core';
import { loadEditorModeResources } from '../editor/mode-resources';
import { requestUserEditCheckpoint, type UserEditCheckpointReason } from '../utils/checkpoints';
import {
  arrayBufferToBase64,
  buildMarkdownAttachmentPlan,
  type MarkdownAttachmentPlan,
} from '../utils/markdown-attachments';
import {
  clearAppFileDragPayload,
  readAppFileDragPayload,
} from '../utils/app-file-drag';
import {
  applyMarkdownCoverImageDrop,
  hasMarkdownCoverDropImage,
} from '../utils/markdown-cover-drop';
import {
  isMarkdownCoverOnlyUpdate,
  mergeMarkdownCoverIntoDocument,
  parseMarkdownCover,
} from '../utils/markdown-cover';
import type { FileVersion, VersionedWriteResult } from '../types';
import type { RemoteWorkbenchContentRef } from '../types';
import type { PreviewScrollSnapshot } from '../../../../shared/preview-reading-position.ts';

export interface ArtifactEditorHandle {
  getView(): EditorView | null;
  focus(): void;
  getScrollSnapshot(contentHash?: string): PreviewScrollSnapshot | null;
  restoreScrollSnapshot(snapshot: PreviewScrollSnapshot | null | undefined): void;
  scrollToLine(line: number): void;
  scrollToOffset(from: number, to?: number): void;
  getTopVisibleLine(): number;
}

export interface ArtifactEditorStats {
  selectedChars: number;
  totalChars: number;
}

export type ArtifactEditorSaveDocument = (
  content: string,
  expectedVersion?: FileVersion | null,
) => Promise<VersionedWriteResult>;

export interface ArtifactEditorProps {
  content: string;
  filePath?: string;
  remoteContentRef?: RemoteWorkbenchContentRef | null;
  fileVersion?: FileVersion | null;
  saveDocument?: ArtifactEditorSaveDocument;
  mode: 'markdown' | 'code' | 'csv' | 'text';
  language?: string | null;
  onSelectionChange?: (view: EditorView) => void;
  onStatsChange?: (stats: ArtifactEditorStats) => void;
  onContentChange?: (content: string, fileVersion?: FileVersion | null) => void;
  initialScrollSnapshot?: PreviewScrollSnapshot | null;
  contentHash?: string;
  onScrollSnapshotChange?: (snapshot: PreviewScrollSnapshot, topVisibleLine: number) => void;
  readOnly?: boolean;
}

const SAVE_DELAY = 600;
const CHECKPOINT_INTERVAL = 5 * 60 * 1000;
const EDITOR_HOST_MIN_SIZE_PX = 1;

interface SaveJob {
  text: string;
  revision: number;
}

interface PendingIncomingContent {
  content: string;
  fileVersion: FileVersion | null;
  noticeShown: boolean;
}

function fileVersionIdentity(version: FileVersion | null | undefined): string {
  if (!version) return '';
  return [
    Number.isFinite(version.mtimeMs) ? version.mtimeMs : '',
    Number.isFinite(version.size) ? version.size : '',
    version.sha256 || '',
  ].join(':');
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tr(key: string, fallback: string): string {
  const tFn = window.t ?? ((p: string) => p);
  try {
    const value = tFn(key);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}

function showSaveError(prefixKey: string, err: unknown): void {
  const tFn = window.t ?? ((p: string) => p);
  window.dispatchEvent(new CustomEvent('codia-inline-notice', {
    detail: { text: `${tFn(prefixKey)}: ${getErrorMessage(err)}`, type: 'error' },
  }));
}

function countTextChars(text: string): number {
  return Array.from(text).length;
}

function getSelectedText(state: EditorState): string {
  return state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => state.sliceDoc(range.from, range.to))
    .join('');
}

function getEditorStats(view: EditorView): ArtifactEditorStats {
  return {
    selectedChars: countTextChars(getSelectedText(view.state).trim()),
    totalChars: countTextChars(view.state.doc.toString()),
  };
}

function clampPos(pos: number, max: number): number {
  return Math.max(0, Math.min(pos, max));
}

function restoreScrollPosition(view: EditorView, scrollTop: number, scrollLeft: number): void {
  const restore = () => {
    view.scrollDOM.scrollTop = scrollTop;
    view.scrollDOM.scrollLeft = scrollLeft;
  };
  restore();
  queueMicrotask(restore);
  window.requestAnimationFrame?.(restore);
}

function editorHostBoxSize(el: HTMLElement): { width: number; height: number } {
  const rect = el.getBoundingClientRect();
  return {
    width: Math.max(rect.width, el.clientWidth, el.offsetWidth),
    height: Math.max(rect.height, el.clientHeight, el.offsetHeight),
  };
}

function isEditorHostReady(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!win || win.closed) return false;
  if (doc.visibilityState === 'hidden') return false;
  const { width, height } = editorHostBoxSize(el);
  return width >= EDITOR_HOST_MIN_SIZE_PX && height >= EDITOR_HOST_MIN_SIZE_PX;
}

function syncEditorRootToDom(view: EditorView): void {
  const root = view.dom.getRootNode();
  if (root === (view.root as unknown)) return;
  const nodeType = (root as Node).nodeType;
  const isDocument = nodeType === Node.DOCUMENT_NODE;
  const isShadowRoot = nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root;
  if (isDocument || isShadowRoot) {
    view.setRoot(root as Document | ShadowRoot);
  }
}

function scrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(1, scrollHeight - clientHeight);
  return Math.max(0, Math.min(1, scrollTop / max));
}

function editorScrollSnapshot(view: EditorView, contentHash?: string): PreviewScrollSnapshot {
  const { scrollDOM } = view;
  return {
    scrollTop: scrollDOM.scrollTop,
    scrollLeft: scrollDOM.scrollLeft,
    scrollHeight: scrollDOM.scrollHeight,
    clientHeight: scrollDOM.clientHeight,
    ratio: scrollRatio(scrollDOM.scrollTop, scrollDOM.scrollHeight, scrollDOM.clientHeight),
    ...(contentHash ? { contentHash } : {}),
  };
}

function restoreEditorScrollSnapshot(view: EditorView, snapshot: PreviewScrollSnapshot | null | undefined): void {
  if (!snapshot) return;
  const maxScrollTop = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
  const scrollTop = typeof snapshot.scrollTop === 'number'
    ? Math.min(maxScrollTop, Math.max(0, snapshot.scrollTop))
    : Math.round(maxScrollTop * (snapshot.ratio ?? 0));
  restoreScrollPosition(view, scrollTop, snapshot.scrollLeft ?? 0);
}

function topVisibleLine(view: EditorView): number {
  try {
    const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
    return view.state.doc.lineAt(block.from).number;
  } catch {
    return 1;
  }
}

function scrollEditorToOffset(view: EditorView, from: number, to = from): void {
  const length = view.state.doc.length;
  const anchor = clampPos(from, length);
  const head = clampPos(to, length);
  view.dispatch({
    selection: EditorSelection.range(anchor, head),
    scrollIntoView: true,
  });
}

interface MarkdownAttachmentSource {
  file?: File;
  path?: string;
  name: string;
  mimeType?: string | null;
}

function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files?.length) return true;
  return Array.from(dataTransfer.types || []).includes('Files');
}

function filesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  const files = Array.from(dataTransfer.files || []);
  if (files.length > 0) return files;

  return Array.from(dataTransfer.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => !!file);
}

function attachmentSourcesFromFiles(files: File[]): MarkdownAttachmentSource[] {
  return files
    .filter(file => !file.name.endsWith('/'))
    .map(file => ({
      file,
      path: window.platform?.getFilePath?.(file) || undefined,
      name: file.name,
      mimeType: file.type || null,
    }));
}

function attachmentSourcesFromAppDrag(dataTransfer: DataTransfer | null): MarkdownAttachmentSource[] | null {
  const payload = readAppFileDragPayload(dataTransfer);
  if (!payload) return null;
  return payload.files
    .filter(file => !file.isDirectory && !!file.path)
    .map(file => ({
      path: file.path,
      name: file.name || file.path,
      mimeType: file.mimeType || null,
    }));
}

async function writeMarkdownAttachment(source: MarkdownAttachmentSource, plan: MarkdownAttachmentPlan): Promise<void> {
  let copied = false;
  if (source.path && typeof window.platform?.copyFile === 'function') {
    copied = await window.platform.copyFile(source.path, plan.attachmentPath);
  }
  if (copied) return;

  if (!source.file) {
    throw new Error(`cannot copy attachment: ${source.name}`);
  }
  if (typeof window.platform?.writeFileBinary !== 'function') {
    throw new Error('writeFileBinary unavailable');
  }
  const base64 = arrayBufferToBase64(await source.file.arrayBuffer());
  const ok = await window.platform.writeFileBinary(plan.attachmentPath, base64);
  if (ok === false) {
    throw new Error(`failed to write attachment: ${source.name}`);
  }
}

function insertMarkdownAt(view: EditorView, markdown: string, position: number | null): void {
  const selection = view.state.selection.main;
  const from = position ?? selection.from;
  const to = position ?? selection.to;
  view.dispatch({
    changes: { from, to, insert: markdown },
    selection: { anchor: from + markdown.length },
    scrollIntoView: true,
  });
}

function dropPosition(view: EditorView, event: DragEvent): number | null {
  try {
    return view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null;
  } catch {
    return null;
  }
}

function dragEventElement(event: DragEvent): Element | null {
  return event.target instanceof Element ? event.target : null;
}

function editorCoverElementFromEvent(event: DragEvent): HTMLElement | null {
  return dragEventElement(event)?.closest('.cm-markdown-cover') as HTMLElement | null;
}

function clearMarkdownCoverDropState(view: EditorView): void {
  view.dom.classList.remove('cm-markdown-cover-rail-active');
  view.dom.querySelector('.cm-markdown-cover-drop-active')?.classList.remove('cm-markdown-cover-drop-active');
}

function isMarkdownTopCoverDrop(event: DragEvent): boolean {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const y = Number.isFinite(event.clientY) ? event.clientY : rect.top;
  return y >= rect.top && y <= rect.top + 40;
}

function shouldUseMarkdownCoverRail(view: EditorView, event: DragEvent): boolean {
  if (parseMarkdownCover(view.state.doc.toString())) return false;
  return isMarkdownTopCoverDrop(event);
}

const fileChangeEmitter = new EventTarget();
let fileChangeListenerSetup = false;

function setupFileChangeListener() {
  if (fileChangeListenerSetup) return;
  fileChangeListenerSetup = true;
  window.platform?.onFileChanged((filePath: string) => {
    fileChangeEmitter.dispatchEvent(new CustomEvent('change', { detail: filePath }));
  });
}

export const ArtifactEditor = forwardRef<ArtifactEditorHandle, ArtifactEditorProps>(
  function ArtifactEditor({
    content,
    filePath,
    remoteContentRef,
    fileVersion,
    saveDocument,
    mode,
    language,
    onSelectionChange,
    onStatsChange,
    onContentChange,
    initialScrollSnapshot,
    contentHash,
    onScrollSnapshotChange,
    readOnly = false,
  }, ref) {
    const incomingFileVersionKey = fileVersionIdentity(fileVersion ?? null);
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [editorHostReadySignal, setEditorHostReadySignal] = useState(0);
    const lastEditorHostReadyRef = useRef(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const saveInFlightRef = useRef(false);
    const pendingSaveRef = useRef<SaveJob | null>(null);
    const lastSavedContentRef = useRef(content);
    const selfWriteContentsRef = useRef<Set<string>>(new Set());
    const pendingIncomingContentRef = useRef<PendingIncomingContent | null>(null);
    const diskVersionRef = useRef<FileVersion | null>(fileVersion ?? null);
    const lastPropFileVersionKeyRef = useRef(incomingFileVersionKey);
    const docRevisionRef = useRef(0);
    const lastCheckpointAtRef = useRef<number>(0);
    const filePathRef = useRef(filePath);
    const remoteContentRefRef = useRef(remoteContentRef);
    const saveDocumentRef = useRef(saveDocument);
    const selectionCbRef = useRef(onSelectionChange);
    const statsCbRef = useRef(onStatsChange);
    const scrollSnapshotCbRef = useRef(onScrollSnapshotChange);
    const initialScrollSnapshotRef = useRef(initialScrollSnapshot);
    const contentHashRef = useRef(contentHash);
    const scrollTimerRef = useRef<number | null>(null);
    const scrollCleanupRef = useRef<(() => void) | null>(null);
    const restoredScrollKeyRef = useRef<string | null>(null);
    const lastStatsRef = useRef<ArtifactEditorStats | null>(null);
    const contentCbRef = useRef(onContentChange);
    const compartmentsRef = useRef<{
      lang: InstanceType<typeof import('@codemirror/state').Compartment>;
      highlight: InstanceType<typeof import('@codemirror/state').Compartment>;
      gutter: InstanceType<typeof import('@codemirror/state').Compartment>;
      theme: InstanceType<typeof import('@codemirror/state').Compartment>;
    } | null>(null);
    const remoteAnnotationRef = useRef<(() => unknown) | null>(null);

    filePathRef.current = filePath;
    remoteContentRefRef.current = remoteContentRef;
    saveDocumentRef.current = saveDocument;
    selectionCbRef.current = onSelectionChange;
    statsCbRef.current = onStatsChange;
    scrollSnapshotCbRef.current = onScrollSnapshotChange;
    initialScrollSnapshotRef.current = initialScrollSnapshot;
    contentHashRef.current = contentHash;
    contentCbRef.current = onContentChange;

    useLayoutEffect(() => {
      const host = containerRef.current;
      if (!host) return undefined;
      const editorHost: HTMLElement = host;
      const doc = editorHost.ownerDocument;
      const win = doc.defaultView ?? window;
      let disposed = false;
      let rafId: number | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let resizeObserver: ResizeObserver | null = null;

      const clearPending = () => {
        if (rafId !== null) {
          win.cancelAnimationFrame?.(rafId);
          rafId = null;
        }
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      };

      function scheduleCheck() {
        if (disposed || rafId !== null || retryTimer) return;
        if (typeof win.requestAnimationFrame === 'function') {
          rafId = win.requestAnimationFrame(check);
        } else {
          retryTimer = setTimeout(check, 0);
        }
      }

      function check() {
        rafId = null;
        retryTimer = null;
        if (disposed) return;
        const ready = isEditorHostReady(editorHost);
        if (ready && !lastEditorHostReadyRef.current && !viewRef.current) {
          setEditorHostReadySignal(signal => signal + 1);
        }
        lastEditorHostReadyRef.current = ready;
        if (!ready) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            scheduleCheck();
          }, 250);
        }
      }

      const requestCheck = () => {
        if (disposed) return;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        scheduleCheck();
      };

      if (typeof win.ResizeObserver === 'function') {
        resizeObserver = new win.ResizeObserver(requestCheck);
        resizeObserver.observe(editorHost);
      }
      doc.addEventListener('visibilitychange', requestCheck);
      win.addEventListener('resize', requestCheck);
      check();

      return () => {
        disposed = true;
        clearPending();
        resizeObserver?.disconnect();
        doc.removeEventListener('visibilitychange', requestCheck);
        win.removeEventListener('resize', requestCheck);
      };
    }, []);

    useEffect(() => {
      if (fileVersion !== undefined) {
        diskVersionRef.current = fileVersion;
      }
    }, [fileVersion]);

    useImperativeHandle(ref, () => ({
      getView: () => viewRef.current,
      focus: () => viewRef.current?.focus(),
      getScrollSnapshot: (hash?: string) => {
        const view = viewRef.current;
        return view ? editorScrollSnapshot(view, hash ?? contentHashRef.current) : null;
      },
      restoreScrollSnapshot: (snapshot) => {
        const view = viewRef.current;
        if (view) restoreEditorScrollSnapshot(view, snapshot);
      },
      scrollToLine: (line) => {
        const view = viewRef.current;
        if (!view) return;
        const nextLine = Math.max(1, Math.min(Math.trunc(line), view.state.doc.lines));
        const docLine = view.state.doc.line(nextLine);
        scrollEditorToOffset(view, docLine.from);
      },
      scrollToOffset: (from, to) => {
        const view = viewRef.current;
        if (view) scrollEditorToOffset(view, from, to);
      },
      getTopVisibleLine: () => {
        const view = viewRef.current;
        return view ? topVisibleLine(view) : 1;
      },
    }));

    const createCheckpointIfDue = useCallback(async (fp: string) => {
      const now = Date.now();
      if (lastCheckpointAtRef.current > 0 && now - lastCheckpointAtRef.current < CHECKPOINT_INTERVAL) return;
      const reason: UserEditCheckpointReason = lastCheckpointAtRef.current > 0
        ? 'autosave-interval'
        : 'edit-start';
      try {
        await requestUserEditCheckpoint(fp, reason);
      } catch (err) {
        console.warn('[ArtifactEditor] checkpoint failed:', err);
        showSaveError('settings.saveFailed', err);
      } finally {
        lastCheckpointAtRef.current = now;
      }
    }, []);

    const rememberSelfWrite = useCallback((text: string) => {
      selfWriteContentsRef.current.add(text);
      window.setTimeout(() => {
        selfWriteContentsRef.current.delete(text);
      }, 5000);
    }, []);

    const insertMarkdownAttachments = useCallback(async (
      view: EditorView,
      sources: MarkdownAttachmentSource[],
      position: number | null = null,
    ) => {
      const fp = filePathRef.current;
      if (!fp) throw new Error('markdown file path required');
      if (sources.length === 0) return;

      const plans: MarkdownAttachmentPlan[] = [];
      for (let i = 0; i < sources.length; i += 1) {
        const source = sources[i];
        const plan = buildMarkdownAttachmentPlan({
          markdownFilePath: fp,
          originalName: source.name,
          mimeType: source.mimeType,
          index: i,
        });
        await writeMarkdownAttachment(source, plan);
        plans.push(plan);
      }

      insertMarkdownAt(view, plans.map(plan => plan.markdown).join('\n'), position);
    }, []);

    const emitStatsIfChanged = useCallback((view: EditorView) => {
      const next = getEditorStats(view);
      const previous = lastStatsRef.current;
      if (
        previous
        && previous.selectedChars === next.selectedChars
        && previous.totalChars === next.totalChars
      ) {
        return;
      }
      lastStatsRef.current = next;
      statsCbRef.current?.(next);
    }, []);

    const performSave = useCallback(async ({ text, revision }: SaveJob) => {
      const currentPath = filePathRef.current;
      const saveRemoteDocument = saveDocumentRef.current;
      if (!currentPath && !saveRemoteDocument) return;
      const expectedVersion = diskVersionRef.current;

      try {
        if (currentPath) await createCheckpointIfDue(currentPath);
        if (
          revision !== docRevisionRef.current
          || currentPath !== filePathRef.current
          || saveRemoteDocument !== saveDocumentRef.current
        ) {
          return;
        }

        let nextVersion: FileVersion | null | undefined;
        if (saveRemoteDocument) {
          const result = await saveRemoteDocument(text, expectedVersion);
          if (!result?.ok) {
            if (result?.conflict) {
              const tFn = window.t ?? ((p: string) => p);
              throw new Error(tFn('settings.fileChangedOnDisk'));
            }
            throw new Error('saveDocument returned false');
          }
          nextVersion = result.version ?? null;
          if (result.version) diskVersionRef.current = result.version;
        } else if (window.platform?.writeFileIfUnchanged) {
          if (!currentPath) return;
          const result = await window.platform.writeFileIfUnchanged(currentPath, text, expectedVersion);
          if (!result?.ok) {
            if (result?.conflict) {
              const tFn = window.t ?? ((p: string) => p);
              throw new Error(tFn('settings.fileChangedOnDisk'));
            }
            throw new Error('write-file-if-unchanged returned false');
          }
          nextVersion = result.version ?? null;
          if (result.version) diskVersionRef.current = result.version;
        } else {
          if (!currentPath) return;
          const ok = await window.platform?.writeFile(currentPath, text);
          if (ok === false) throw new Error('write-file returned false');
          nextVersion = undefined;
        }

        lastSavedContentRef.current = text;
        if (pendingIncomingContentRef.current?.content === text) {
          pendingIncomingContentRef.current = null;
        }
        rememberSelfWrite(text);
        if (
          revision === docRevisionRef.current
          && currentPath === filePathRef.current
          && saveRemoteDocument === saveDocumentRef.current
          && nextVersion !== undefined
        ) {
          contentCbRef.current?.(text, nextVersion);
        }
      } catch (err) {
        console.warn('[ArtifactEditor] write failed:', err);
        showSaveError('settings.saveFailed', err);
      }
    }, [createCheckpointIfDue, rememberSelfWrite]);

    const drainSaveQueue = useCallback(function drain() {
      if (saveInFlightRef.current) return;
      const job = pendingSaveRef.current;
      if (!job) return;
      pendingSaveRef.current = null;
      saveInFlightRef.current = true;
      void performSave(job).finally(() => {
        saveInFlightRef.current = false;
        drain();
      });
    }, [performSave]);

    const saveToFile = useCallback((text: string, revision: number = docRevisionRef.current) => {
      pendingSaveRef.current = { text, revision };
      drainSaveQueue();
    }, [drainSaveQueue]);

    const replaceDocumentPreservingSelection = useCallback((view: EditorView, nextContent: string): boolean => {
      const current = view.state.doc.toString();
      if (current === nextContent) return false;
      const nextLength = nextContent.length;
      const { anchor, head } = view.state.selection.main;
      const { scrollTop, scrollLeft } = view.scrollDOM;
      const transaction: TransactionSpec = {
        changes: { from: 0, to: current.length, insert: nextContent },
        selection: {
          anchor: clampPos(anchor, nextLength),
          head: clampPos(head, nextLength),
        },
      };
      const remoteAnnotation = remoteAnnotationRef.current?.();
      if (remoteAnnotation) {
        transaction.annotations = remoteAnnotation as TransactionSpec['annotations'];
      }
      view.dispatch(transaction);
      restoreScrollPosition(view, scrollTop, scrollLeft);
      return true;
    }, []);

    const applyIncomingContent = useCallback((nextContent: string, options: { publish?: boolean } = {}) => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === nextContent) {
        if (options.publish) {
          lastSavedContentRef.current = nextContent;
          pendingIncomingContentRef.current = null;
        }
        return;
      }
      if (selfWriteContentsRef.current.has(nextContent)) {
        return;
      }

      const hasLocalUnsavedEdits = !readOnly && current !== lastSavedContentRef.current;
      if (hasLocalUnsavedEdits) {
        const merged = mode === 'markdown' && isMarkdownCoverOnlyUpdate(lastSavedContentRef.current, nextContent)
          ? mergeMarkdownCoverIntoDocument(current, nextContent)
          : null;
        if (merged) {
          docRevisionRef.current += 1;
          const revision = docRevisionRef.current;
          if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
          }
          lastSavedContentRef.current = nextContent;
          pendingIncomingContentRef.current = null;
          replaceDocumentPreservingSelection(view, merged);
          contentCbRef.current?.(merged);
          saveToFile(merged, revision);
          return;
        }

        const nextVersion = diskVersionRef.current;
        const previousPending = pendingIncomingContentRef.current;
        const samePending = !!previousPending
          && previousPending.content === nextContent
          && fileVersionIdentity(previousPending.fileVersion) === fileVersionIdentity(nextVersion);
        const pending: PendingIncomingContent = {
          content: nextContent,
          fileVersion: nextVersion,
          noticeShown: samePending ? previousPending.noticeShown : false,
        };
        pendingIncomingContentRef.current = pending;
        contentCbRef.current?.(current);
        if (!pending.noticeShown) {
          showSaveError('settings.fileChangedOnDisk', 'local edits are not saved yet');
          pending.noticeShown = true;
        }
        return;
      }

      docRevisionRef.current += 1;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      lastSavedContentRef.current = nextContent;
      pendingIncomingContentRef.current = null;
      replaceDocumentPreservingSelection(view, nextContent);
      if (options.publish) {
        contentCbRef.current?.(nextContent, diskVersionRef.current);
      }
    }, [mode, readOnly, replaceDocumentPreservingSelection, saveToFile]);

    useLayoutEffect(() => {
      if (!containerRef.current) return undefined;
      if (!editorHostReadySignal || !isEditorHostReady(containerRef.current)) return undefined;

      let disposed = false;
      setLoadError(null);

      (async () => {
        try {
          const [cm, modeResources] = await Promise.all([
            loadCodeMirrorCore(),
            loadEditorModeResources(mode, {
              markdownImageContext: {
                filePath: filePathRef.current ?? null,
                getFileUrl: window.platform?.getFileUrl
                  ? (localPath) => window.platform?.getFileUrl?.(localPath)
                  : null,
              },
            }),
          ]);
          if (disposed || !containerRef.current) return;

          if (!compartmentsRef.current) {
            compartmentsRef.current = {
              lang: new cm.Compartment(),
              highlight: new cm.Compartment(),
              gutter: new cm.Compartment(),
              theme: new cm.Compartment(),
            };
          }
          const c = compartmentsRef.current;
          remoteAnnotationRef.current = () => cm.Transaction.remote.of(true);

          const extensions = [
            cm.drawSelection(),
            cm.history(),
            cm.bracketMatching(),
            cm.keymap.of([...cm.defaultKeymap, ...cm.historyKeymap]),
            cm.EditorView.lineWrapping,
            ...(mode === 'markdown' && !readOnly ? [
              cm.EditorView.domEventHandlers({
                dragover(event, view) {
                  const editorView = view as EditorView;
                  const coverElement = editorCoverElementFromEvent(event);
                  const coverTarget = filePathRef.current || remoteContentRefRef.current;
                  if (coverElement && coverTarget && hasMarkdownCoverDropImage(event.dataTransfer)) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                    coverElement.classList.add('cm-markdown-cover-drop-active');
                    editorView.dom.classList.remove('cm-markdown-cover-rail-active');
                    return true;
                  }
                  if (coverTarget && hasMarkdownCoverDropImage(event.dataTransfer) && shouldUseMarkdownCoverRail(editorView, event)) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                    editorView.dom.classList.add('cm-markdown-cover-rail-active');
                    return true;
                  }
                  clearMarkdownCoverDropState(editorView);
                  const appSources = attachmentSourcesFromAppDrag(event.dataTransfer);
                  if (!filePathRef.current || (!appSources && !dataTransferHasFiles(event.dataTransfer))) return false;
                  event.preventDefault();
                  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                  return true;
                },
                dragleave(event, view) {
                  const coverElement = editorCoverElementFromEvent(event);
                  if (coverElement && !(event.relatedTarget instanceof Node && coverElement.contains(event.relatedTarget))) {
                    coverElement.classList.remove('cm-markdown-cover-drop-active');
                  }
                  if (!(event.relatedTarget instanceof Node && (view as EditorView).dom.contains(event.relatedTarget))) {
                    clearMarkdownCoverDropState(view as EditorView);
                  }
                  return false;
                },
                drop(event, view) {
                  const editorView = view as EditorView;
                  const payload = readAppFileDragPayload(event.dataTransfer);
                  const coverElement = editorCoverElementFromEvent(event);
                  const coverTarget = filePathRef.current || remoteContentRefRef.current;
                  const isCoverTarget = Boolean(coverElement)
                    || (coverTarget && hasMarkdownCoverDropImage(event.dataTransfer) && shouldUseMarkdownCoverRail(editorView, event));
                  if (isCoverTarget && coverTarget && hasMarkdownCoverDropImage(event.dataTransfer)) {
                    event.preventDefault();
                    event.stopPropagation();
                    clearMarkdownCoverDropState(editorView);
                    void applyMarkdownCoverImageDrop({
                      filePath: filePathRef.current,
                      target: remoteContentRefRef.current,
                      dataTransfer: event.dataTransfer,
                    });
                    return true;
                  }
                  const appSources = payload
                    ? attachmentSourcesFromAppDrag(event.dataTransfer)
                    : null;
                  const sources = appSources ?? attachmentSourcesFromFiles(filesFromDataTransfer(event.dataTransfer));
                  if (!filePathRef.current || sources.length === 0) return false;
                  event.preventDefault();
                  event.stopPropagation();
                  if (payload) clearAppFileDragPayload(payload.dragId);
                  const position = dropPosition(view as EditorView, event);
                  void insertMarkdownAttachments(view as EditorView, sources, position)
                    .catch(err => showSaveError('preview.markdownAttachmentInsertFailed', err));
                  return true;
                },
                paste(event, view) {
                  const sources = attachmentSourcesFromFiles(filesFromDataTransfer(event.clipboardData));
                  if (!filePathRef.current || sources.length === 0) return false;
                  event.preventDefault();
                  event.stopPropagation();
                  void insertMarkdownAttachments(view as EditorView, sources)
                    .catch(err => showSaveError('preview.markdownAttachmentInsertFailed', err));
                  return true;
                },
              }),
            ] : []),
            ...(readOnly
              ? [cm.EditorState.readOnly.of(true), cm.EditorView.editable.of(false)]
              : [
                  cm.EditorView.updateListener.of((update) => {
                    if (!update.docChanged) return;
                    if (update.transactions.some((tr) => tr.annotation(cm.Transaction.remote))) return;
                    const text = update.state.doc.toString();
                    docRevisionRef.current += 1;
                    const revision = docRevisionRef.current;
                    contentCbRef.current?.(text);
                    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                    saveTimerRef.current = setTimeout(() => {
                      saveTimerRef.current = null;
                      saveToFile(text, revision);
                    }, SAVE_DELAY);
                  }),
                ]),
            cm.EditorView.updateListener.of((update) => {
              if (update.selectionSet && selectionCbRef.current) {
                selectionCbRef.current(update.view as EditorView);
              }
              if (update.docChanged || update.selectionSet) {
                emitStatsIfChanged(update.view as EditorView);
              }
            }),
            c.gutter.of(modeResources.showLineNumbers ? cm.lineNumbers() : []),
            c.lang.of(modeResources.languageExtension),
            c.highlight.of(cm.syntaxHighlighting(modeResources.highlightStyle)),
            c.theme.of(modeResources.themeExtension),
            ...modeResources.extraExtensions,
          ];

          if (modeResources.highlightActiveLine) {
            extensions.push(cm.highlightActiveLine());
          }

          const state = cm.EditorState.create({ doc: content, extensions });
          const view = new cm.EditorView({ state, parent: containerRef.current });
          viewRef.current = view as EditorView;
          lastStatsRef.current = null;
          emitStatsIfChanged(view as EditorView);
          const scrollView = view as EditorView;
          const publishScrollSnapshot = () => {
            scrollTimerRef.current = null;
            scrollSnapshotCbRef.current?.(
              editorScrollSnapshot(scrollView, contentHashRef.current),
              topVisibleLine(scrollView),
            );
          };
          const handleEditorScroll = () => {
            if (!scrollSnapshotCbRef.current) return;
            if (scrollTimerRef.current != null) window.clearTimeout(scrollTimerRef.current);
            scrollTimerRef.current = window.setTimeout(publishScrollSnapshot, 160);
          };
          scrollCleanupRef.current?.();
          scrollView.scrollDOM.addEventListener('scroll', handleEditorScroll, { passive: true });
          scrollCleanupRef.current = () => {
            scrollView.scrollDOM.removeEventListener('scroll', handleEditorScroll);
          };
          const scrollKey = `${filePathRef.current || ''}:${contentHashRef.current || ''}`;
          if (restoredScrollKeyRef.current !== scrollKey) {
            restoredScrollKeyRef.current = scrollKey;
            restoreEditorScrollSnapshot(scrollView, initialScrollSnapshotRef.current);
          }
        } catch (err) {
          console.warn('[ArtifactEditor] load failed:', err);
          if (!disposed) setLoadError(getErrorMessage(err));
        }
      })();

      return () => {
        disposed = true;
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
          const view = viewRef.current;
          if (view && !readOnly) saveToFile(view.state.doc.toString(), docRevisionRef.current);
        }
        if (scrollTimerRef.current != null) {
          window.clearTimeout(scrollTimerRef.current);
          scrollTimerRef.current = null;
        }
        scrollCleanupRef.current?.();
        scrollCleanupRef.current = null;
        viewRef.current?.destroy();
        viewRef.current = null;
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content changes are handled by the sync effect below; recreating the editor on every keystroke would be incorrect.
    }, [editorHostReadySignal, filePath, mode, language, readOnly, saveToFile, emitStatsIfChanged, insertMarkdownAttachments]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      syncEditorRootToDom(view);
    });

    useEffect(() => {
      const versionChanged = incomingFileVersionKey !== lastPropFileVersionKeyRef.current;
      lastPropFileVersionKeyRef.current = incomingFileVersionKey;
      applyIncomingContent(content, { publish: versionChanged });
    }, [content, incomingFileVersionKey, applyIncomingContent]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view || !initialScrollSnapshot) return;
      const scrollKey = `${filePath || ''}:${contentHash || ''}`;
      if (restoredScrollKeyRef.current === scrollKey) return;
      restoredScrollKeyRef.current = scrollKey;
      restoreEditorScrollSnapshot(view, initialScrollSnapshot);
    }, [contentHash, filePath, initialScrollSnapshot]);

    useEffect(() => {
      if (!filePath || readOnly) return undefined;

      setupFileChangeListener();
      window.platform?.watchFile(filePath);

      const handler = (event: Event) => {
        const changedPath = (event as CustomEvent<string>).detail;
        if (changedPath !== filePath) return;

        void (async () => {
          const snapshot = await window.platform?.readFileSnapshot?.(filePath);
          if (snapshot?.version) diskVersionRef.current = snapshot.version;
          return snapshot?.content ?? await window.platform?.readFile(filePath);
        })().then((newContent) => {
          if (newContent == null) return;
          applyIncomingContent(newContent, { publish: true });
        }).catch((err) => {
          console.warn('[ArtifactEditor] reload watched file failed:', err);
        });
      };

      fileChangeEmitter.addEventListener('change', handler);
      return () => {
        fileChangeEmitter.removeEventListener('change', handler);
        window.platform?.unwatchFile(filePath);
      };
    }, [filePath, readOnly, applyIncomingContent]);

    if (loadError) {
      return (
        <div className={`artifact-editor artifact-editor-error mode-${mode}`} role="alert">
          <div className="artifact-editor-error-title">
            {tr('preview.documentUnavailable', 'Document preview unavailable')}
          </div>
          <div className="artifact-editor-error-hint">
            {tr('preview.documentOpenWithDefaultHint', 'The file could not be rendered here. You can open it with the default app.')}
          </div>
          <div className="artifact-editor-error-detail">{loadError}</div>
        </div>
      );
    }

    return <div className={`artifact-editor mode-${mode}`} ref={containerRef} />;
  },
);
