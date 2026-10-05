/**
 * PreviewPanel
 *
 * Reads owner-keyed artifacts / activeTabId / previewOpen state from Zustand.
 * Editable artifact types (markdown/code/csv with filePath) load CodeMirror
 * on demand. The filesystem remains the source of truth; editable artifact
 * content is not written back into store state.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../stores';
import {
  selectArtifacts,
  selectActiveTabId,
  selectMarkdownPreviewIds,
  selectPreviewReadingPositions,
} from '../stores/preview-slice';
import {
  closePreview,
  setMarkdownPreviewActive,
  updatePreviewReadingPosition,
  upsertArtifact,
} from '../stores/preview-actions';
import { ArtifactRenderer } from './preview/PreviewRenderer';
import { TabBar } from './preview/TabBar';
import { FloatingActions } from './preview/FloatingActions';
import { EditorContextMenu } from './preview/EditorContextMenu';
import { ChapterRail, ClassicFindBox, LinkDiagnosticsBadge } from './preview/MarkdownChrome';
import { RegionalErrorBoundary } from './RegionalErrorBoundary';
import { OpenPreviewDocumentWatchBridge } from './app/OpenPreviewDocumentWatchBridge';
import { captureSelection, clearSelection } from '../stores/selection-actions';
import { openFilePreview } from '../utils/file-preview';
import { resolveBrowserFilePaths } from '../utils/browser-file-paths';
import { isRemoteWorkbenchContentRef, saveRemoteWorkbenchContent } from '../utils/remote-file-preview';
import type { Artifact } from '../types';
import type { ArtifactEditorHandle, ArtifactEditorStats } from './PreviewEditor';
import {
  extractMarkdownHeadings,
  findCurrentHeading,
  hashMarkdownContent,
  type MarkdownHeading,
} from '../utils/markdown-document';
import type { PreviewScrollSnapshot } from '../../../../shared/preview-reading-position.ts';
import previewStyles from './Preview.module.css';

const ArtifactEditor = lazy(() => import('./PreviewEditor').then((m) => ({ default: m.ArtifactEditor })));

const EDITABLE_TYPES = new Set(['markdown', 'code', 'csv']);
const CHAPTER_RAIL_HOVER_ZONE_PX = 64;
const CHAPTER_RAIL_TOP_OFFSET_PX = 76;
const CHAPTER_RAIL_HEIGHT_RATIO = 0.5;

function isEditable(artifact: Artifact | null): boolean {
  if (!artifact) return false;
  if (artifact.status === 'missing') return false;
  return EDITABLE_TYPES.has(artifact.type)
    && (!!artifact.filePath || isRemoteWorkbenchContentRef(artifact.remoteContentRef));
}

function isMarkdownFile(artifact: Artifact | null): boolean {
  return !!artifact
    && artifact.status !== 'missing'
    && artifact.type === 'markdown'
    && (!!artifact.filePath || isRemoteWorkbenchContentRef(artifact.remoteContentRef));
}

function getEditorMode(artifact: Artifact): 'markdown' | 'code' | 'csv' | 'text' {
  if (artifact.type === 'markdown') return 'markdown';
  if (artifact.type === 'csv') return 'csv';
  return 'code';
}

function countPreviewChars(text: string): number {
  return Array.from(text).length;
}

function formatMarkdownEditorStatus(stats: ArtifactEditorStats): string {
  const fallback = `Selected ${stats.selectedChars} chars · Total ${stats.totalChars} chars`;
  const translated = window.t?.('preview.markdownEditorStatus', {
    selected: stats.selectedChars,
    total: stats.totalChars,
  });
  return translated && translated !== 'preview.markdownEditorStatus' ? translated : fallback.replace(/[^\x20-\x7E]+/g, '-');
}

function tr(key: string, fallback: string): string {
  const fallbackByKey: Record<string, string> = {
    'preview.emptyTitle': 'Select a document',
    'preview.emptyHint': 'Open Markdown, documents, or generated artifacts from the file area to preview them here.',
  };
  const safeFallback = fallbackByKey[key] ?? fallback;
  try {
    const value = (window.t ?? (() => safeFallback))(key);
    return !value || value === key ? safeFallback : value;
  } catch {
    return safeFallback;
  }
}

function scrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, scrollHeight - clientHeight);
  return max > 0 ? Math.min(1, Math.max(0, scrollTop / max)) : 0;
}

function escapeCssId(id: string): string {
  const css = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS;
  if (typeof css?.escape === 'function') return css.escape(id);
  return id.replace(/["\\#.:,[\]=]/g, '\\$&');
}

function clearPreviewFindMarks(root: HTMLElement | null): void {
  if (!root) return;
  const marks = Array.from(root.querySelectorAll('mark.preview-find-mark'));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    parent.normalize();
  }
}

function applyPreviewFindMarks(root: HTMLElement | null, query: string): HTMLElement[] {
  if (!root || !query) return [];
  clearPreviewFindMarks(root);
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('mark.preview-find-mark')) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const marks: HTMLElement[] = [];
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let index = text.toLowerCase().indexOf(needle);
    while (index >= 0) {
      if (index > cursor) fragment.append(document.createTextNode(text.slice(cursor, index)));
      // eslint-disable-next-line no-restricted-syntax -- preview search highlights split existing text nodes after render.
      const mark = document.createElement('mark');
      mark.className = 'preview-find-mark';
      mark.textContent = text.slice(index, index + query.length);
      fragment.append(mark);
      marks.push(mark);
      cursor = index + query.length;
      index = text.toLowerCase().indexOf(needle, cursor);
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }
  return marks;
}

function sourceFindMatches(content: string, query: string): Array<{ from: number; to: number }> {
  if (!query) return [];
  const matches: Array<{ from: number; to: number }> = [];
  const lower = content.toLowerCase();
  const needle = query.toLowerCase();
  let index = lower.indexOf(needle);
  while (index >= 0) {
    matches.push({ from: index, to: index + query.length });
    index = lower.indexOf(needle, index + Math.max(1, query.length));
  }
  return matches;
}

function previewFileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function previewFileExt(filePath: string): string {
  const name = previewFileName(filePath);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function PreviewPanel() {
  const previewOpen = useStore((s) => s.previewOpen);
  const activeTabId = useStore(selectActiveTabId);
  const artifacts = useStore(selectArtifacts);
  const markdownPreviewIds = useStore(selectMarkdownPreviewIds);
  const previewReadingPositions = useStore(selectPreviewReadingPositions);
  const setPreviewOpen = useStore((s) => s.setPreviewOpen);
  const setEditorDetached = useStore((s) => s.setEditorDetached);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewBodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ArtifactEditorHandle | null>(null);
  const previewScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredPreviewKeyRef = useRef('');
  const activeHeadingRef = useRef<string | null>(null);
  const previewFindMarksRef = useRef<HTMLElement[]>([]);
  const [editorStats, setEditorStats] = useState<ArtifactEditorStats>({ selectedChars: 0, totalChars: 0 });
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const [chapterRailVisible, setChapterRailVisible] = useState(false);

  const artifact = artifacts.find((a) => a.id === activeTabId) ?? null;
  const markdownPreviewActive = !!artifact && markdownPreviewIds.includes(artifact.id);
  const editable = isEditable(artifact) && !markdownPreviewActive;
  const markdownFile = isMarkdownFile(artifact);
  const showMarkdownEditorStatus = editable && artifact?.type === 'markdown';
  const contentHash = useMemo(() => artifact?.type === 'markdown' ? hashMarkdownContent(artifact.content) : '', [artifact?.content, artifact?.type]);
  const markdownHeadings = useMemo(
    () => artifact?.type === 'markdown' ? extractMarkdownHeadings(artifact.content, 3) : [],
    [artifact?.content, artifact?.type],
  );
  const readingPosition = artifact ? previewReadingPositions[artifact.id] || null : null;
  const panelOpen = previewOpen;
  const panelClassName = `${previewStyles.previewPanel}${panelOpen ? '' : ` ${previewStyles.previewPanelCollapsed}`}`;
  const saveDocument = useMemo(() => {
    const remoteRef = artifact?.remoteContentRef;
    if (!isRemoteWorkbenchContentRef(remoteRef)) return undefined;
    return (content: string, expectedVersion?: Artifact['fileVersion']) =>
      saveRemoteWorkbenchContent(remoteRef, content, expectedVersion ?? null);
  }, [artifact?.remoteContentRef]);

  const handleDetach = useCallback(() => {
    if (!artifact?.filePath) return;
    setEditorDetached(true);
    setPreviewOpen(false);
    window.platform?.openEditorWindow?.({
      filePath: artifact.filePath,
      title: artifact.title,
      type: artifact.type,
      language: artifact.language,
    });
  }, [artifact, setEditorDetached, setPreviewOpen]);

  const handleToggleMarkdownPreview = useCallback(() => {
    if (!artifact || !isMarkdownFile(artifact)) return;
    setMarkdownPreviewActive(artifact.id, !markdownPreviewActive);
  }, [artifact, markdownPreviewActive]);

  const handleEditorContentChange = useCallback((content: string, fileVersion?: Artifact['fileVersion']) => {
    if (!artifact) return;
    upsertArtifact({
      ...artifact,
      content,
      fileVersion: fileVersion === undefined ? artifact.fileVersion : fileVersion,
    });
  }, [artifact]);

  const handleEditorStatsChange = useCallback((stats: ArtifactEditorStats) => {
    setEditorStats(stats);
  }, []);

  const currentPreviewHeading = useCallback((): MarkdownHeading | null => {
    const body = previewBodyRef.current;
    if (!body || markdownHeadings.length === 0) return null;
    const bodyTop = body.getBoundingClientRect().top + 56;
    let current: MarkdownHeading | null = markdownHeadings[0] || null;
    for (const heading of markdownHeadings) {
      const el = body.querySelector<HTMLElement>(`.preview-markdown #${escapeCssId(heading.id)}`);
      if (!el) continue;
      if (el.getBoundingClientRect().top <= bodyTop) current = heading;
      else break;
    }
    return current;
  }, [markdownHeadings]);

  const publishPreviewScrollSnapshot = useCallback(() => {
    previewScrollTimerRef.current = null;
    if (!artifact || !markdownFile || editable) return;
    const body = previewBodyRef.current;
    if (!body) return;
    const heading = currentPreviewHeading();
    if (heading?.id !== activeHeadingRef.current) {
      activeHeadingRef.current = heading?.id ?? null;
      setActiveHeadingId(heading?.id ?? null);
    }
    updatePreviewReadingPosition(artifact.id, 'preview', {
      scrollTop: body.scrollTop,
      scrollLeft: body.scrollLeft,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      ratio: scrollRatio(body.scrollTop, body.scrollHeight, body.clientHeight),
      ...(heading ? { anchorId: heading.id, anchorText: heading.text } : {}),
      contentHash,
    }, heading ? { id: heading.id, text: heading.text } : null);
  }, [artifact, contentHash, currentPreviewHeading, editable, markdownFile]);

  const schedulePreviewScrollSnapshot = useCallback(() => {
    if (previewScrollTimerRef.current) clearTimeout(previewScrollTimerRef.current);
    previewScrollTimerRef.current = setTimeout(publishPreviewScrollSnapshot, 160);
  }, [publishPreviewScrollSnapshot]);

  const handleEditorScrollSnapshot = useCallback((snapshot: PreviewScrollSnapshot, topVisibleLine: number) => {
    if (!artifact || !markdownFile) return;
    const heading = findCurrentHeading(markdownHeadings, Math.max(0, topVisibleLine - 1));
    if (heading?.id !== activeHeadingRef.current) {
      activeHeadingRef.current = heading?.id ?? null;
      setActiveHeadingId(heading?.id ?? null);
    }
    updatePreviewReadingPosition(artifact.id, 'edit', {
      ...snapshot,
      ...(heading ? { anchorId: heading.id, anchorText: heading.text } : {}),
      contentHash,
    }, heading ? { id: heading.id, text: heading.text } : null);
  }, [artifact, contentHash, markdownFile, markdownHeadings]);

  const restorePreviewScroll = useCallback(() => {
    if (!artifact || editable || !markdownFile || !readingPosition?.preview) return;
    const body = previewBodyRef.current;
    if (!body) return;
    const snapshot = readingPosition.preview;
    const key = `${artifact.id}:preview:${contentHash}:${snapshot.updatedAt || ''}:${snapshot.scrollTop}:${snapshot.anchorId || ''}`;
    if (restoredPreviewKeyRef.current === key) return;
    restoredPreviewKeyRef.current = key;
    const restore = () => {
      if (snapshot.contentHash === contentHash && Number.isFinite(snapshot.scrollTop)) {
        body.scrollTop = Math.max(0, snapshot.scrollTop);
        body.scrollLeft = Math.max(0, snapshot.scrollLeft || 0);
        return;
      }
      if (snapshot.anchorId) {
        const el = body.querySelector<HTMLElement>(`.preview-markdown #${escapeCssId(snapshot.anchorId)}`);
        if (el) {
          body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 56;
          return;
        }
      }
      if (Number.isFinite(snapshot.ratio)) {
        body.scrollTop = Math.max(0, (snapshot.ratio || 0) * Math.max(0, body.scrollHeight - body.clientHeight));
      }
    };
    restore();
    queueMicrotask(restore);
    window.requestAnimationFrame?.(restore);
  }, [artifact, contentHash, editable, markdownFile, readingPosition?.preview]);

  const handleJumpHeading = useCallback((heading: MarkdownHeading) => {
    if (editable) {
      editorRef.current?.scrollToLine(heading.line + 1);
    } else {
      const body = previewBodyRef.current;
      const el = body?.querySelector<HTMLElement>(`.preview-markdown #${escapeCssId(heading.id)}`);
      if (body && el) {
        body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 56;
      }
    }
    activeHeadingRef.current = heading.id;
    setActiveHeadingId(heading.id);
  }, [editable]);

  const handleBodyShellPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const xFromLeft = event.clientX - rect.left;
    const yFromTop = event.clientY - rect.top;
    const inRailX = xFromLeft >= 0 && xFromLeft <= CHAPTER_RAIL_HOVER_ZONE_PX;
    const inRailY = yFromTop >= CHAPTER_RAIL_TOP_OFFSET_PX
      && yFromTop <= CHAPTER_RAIL_TOP_OFFSET_PX + rect.height * CHAPTER_RAIL_HEIGHT_RATIO;
    setChapterRailVisible(inRailX && inRailY);
  }, []);

  const handleBodyShellPointerLeave = useCallback(() => {
    setChapterRailVisible(false);
  }, []);

  const handleSelectPreviewFile = useCallback(async () => {
    try {
      const paths = await window.platform?.selectFiles?.();
      const filePath = paths?.find(path => typeof path === 'string' && path);
      if (filePath) {
        openFilePreview(filePath, previewFileName(filePath), previewFileExt(filePath), { origin: 'desk' });
        return;
      }
    } catch (err) {
      console.warn('[preview] native file picker failed, falling back to browser picker:', err);
    }
    fileInputRef.current?.click();
  }, []);

  const disablePreviewRegion = useCallback((error: Error) => {
    console.warn('[preview] disabled after render crash:', error);
    closePreview();
  }, []);

  const handlePreviewFileInputChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;
    const { paths, nameMap } = await resolveBrowserFilePaths(files.slice(0, 1));
    const filePath = paths.find(path => typeof path === 'string' && path);
    if (!filePath) return;
    openFilePreview(
      filePath,
      nameMap[filePath] || previewFileName(filePath),
      previewFileExt(filePath),
      { origin: 'desk' },
    );
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!artifact || editable) return;
    captureSelection(artifact);
  }, [artifact, editable]);

  useEffect(() => {
    clearSelection();
    setEditorStats({
      selectedChars: 0,
      totalChars: artifact?.type === 'markdown' ? countPreviewChars(artifact.content) : 0,
    });
    activeHeadingRef.current = readingPosition?.currentHeadingId || null;
    setActiveHeadingId(readingPosition?.currentHeadingId || null);
  }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps -- reset the status bar when switching preview tabs

  useEffect(() => {
    if (!panelOpen || !artifact || !markdownFile || editable) return undefined;
    const body = previewBodyRef.current;
    if (!body) return undefined;
    const onScroll = () => schedulePreviewScrollSnapshot();
    body.addEventListener('scroll', onScroll, { passive: true });
    restorePreviewScroll();
    return () => {
      body.removeEventListener('scroll', onScroll);
      if (previewScrollTimerRef.current) {
        clearTimeout(previewScrollTimerRef.current);
        publishPreviewScrollSnapshot();
      }
    };
  }, [
    artifact,
    editable,
    markdownFile,
    panelOpen,
    publishPreviewScrollSnapshot,
    restorePreviewScroll,
    schedulePreviewScrollSnapshot,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!panelOpen || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      event.stopPropagation();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [panelOpen]);

  useEffect(() => {
    setFindIndex(0);
  }, [activeTabId, editable, findQuery]);

  useEffect(() => {
    clearPreviewFindMarks(previewBodyRef.current);
    previewFindMarksRef.current = [];
    if (!findOpen || !findQuery || !artifact) {
      setFindCount(0);
      return undefined;
    }
    if (editable) {
      const matches = sourceFindMatches(artifact.content, findQuery);
      setFindCount(matches.length);
      const match = matches[Math.min(findIndex, Math.max(0, matches.length - 1))];
      if (match) editorRef.current?.scrollToOffset(match.from, match.to);
      return undefined;
    }
    const marks = applyPreviewFindMarks(previewBodyRef.current, findQuery);
    previewFindMarksRef.current = marks;
    setFindCount(marks.length);
    return () => {
      clearPreviewFindMarks(previewBodyRef.current);
      previewFindMarksRef.current = [];
    };
  }, [activeTabId, artifact, editable, findIndex, findOpen, findQuery]);

  useEffect(() => {
    const marks = previewFindMarksRef.current;
    for (const mark of marks) mark.classList.remove('preview-find-mark-active');
    const active = marks[Math.min(findIndex, Math.max(0, marks.length - 1))];
    if (active) {
      active.classList.add('preview-find-mark-active');
      active.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }, [findCount, findIndex]);

  const goFind = useCallback((direction: 1 | -1) => {
    setFindIndex(index => {
      if (findCount <= 0) return 0;
      return (index + direction + findCount) % findCount;
    });
  }, [findCount]);

  return (
    <div
      className={panelClassName}
      id="previewPanel"
      data-preview-open={panelOpen ? 'true' : 'false'}
      data-reader-mode="false"
    >
      <OpenPreviewDocumentWatchBridge />
      <div className="resize-handle resize-handle-left" id="previewResizeHandle"></div>
      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={handlePreviewFileInputChange}
      />
      <div className={previewStyles.previewPanelInner} data-preview-panel-inner="">
        <TabBar />
        <div
          className={previewStyles.previewBodyShell}
          data-preview-body-shell=""
          onPointerMove={handleBodyShellPointerMove}
          onPointerLeave={handleBodyShellPointerLeave}
        >
          {panelOpen && artifact && markdownFile && (
            <ChapterRail
              headings={markdownHeadings}
              activeHeadingId={activeHeadingId}
              railVisible={chapterRailVisible}
              onJump={handleJumpHeading}
            />
          )}
          <ClassicFindBox
            open={findOpen}
            query={findQuery}
            resultIndex={Math.min(findIndex, Math.max(0, findCount - 1))}
            resultCount={findCount}
            onQueryChange={setFindQuery}
            onPrevious={() => goFind(-1)}
            onNext={() => goFind(1)}
            onClose={() => setFindOpen(false)}
          />
          {panelOpen && artifact && artifact.status !== 'missing' && (
            <FloatingActions
              content={artifact.content}
              filePath={artifact.filePath}
              remoteContentRef={artifact.remoteContentRef}
              contentType={artifact.type}
              language={artifact.language}
              editable={editable}
              onDetach={handleDetach}
              showMarkdownPreviewToggle={isMarkdownFile(artifact)}
              markdownPreviewActive={markdownPreviewActive}
              onToggleMarkdownPreview={handleToggleMarkdownPreview}
            />
          )}
          <div ref={previewBodyRef} className={previewStyles.previewPanelBody} id="previewBody" onMouseUp={handleMouseUp}>
            {panelOpen && artifact && !editable && (
              <RegionalErrorBoundary
                region="preview"
                resetKeys={[artifact.id, artifact.type, artifact.content]}
                onDisableRegion={disablePreviewRegion}
              >
                <ArtifactRenderer artifact={artifact} />
              </RegionalErrorBoundary>
            )}
            {panelOpen && artifact && editable && (
              <RegionalErrorBoundary
                region="preview"
                resetKeys={[artifact.id, artifact.type, artifact.filePath]}
                onDisableRegion={disablePreviewRegion}
              >
                <Suspense fallback={null}>
                  <ArtifactEditor
                    ref={editorRef}
                    content={artifact.content}
                    filePath={artifact.filePath}
                    remoteContentRef={artifact.remoteContentRef}
                    fileVersion={artifact.fileVersion ?? artifact.remoteContentRef?.version ?? null}
                    saveDocument={saveDocument}
                    mode={getEditorMode(artifact)}
                    language={artifact.language}
                    onSelectionChange={(view) => {
                      if (artifact) captureSelection(artifact, view);
                    }}
                    onStatsChange={handleEditorStatsChange}
                    onContentChange={handleEditorContentChange}
                    initialScrollSnapshot={readingPosition?.edit ?? null}
                    contentHash={contentHash}
                    onScrollSnapshotChange={handleEditorScrollSnapshot}
                  />
                  <EditorContextMenu editorRef={editorRef} containerRef={previewBodyRef} />
                </Suspense>
              </RegionalErrorBoundary>
            )}
            {panelOpen && artifact && editable && artifact.type === 'markdown' && (
              <LinkDiagnosticsBadge previewItem={artifact} headings={markdownHeadings} />
            )}
            {panelOpen && artifact && showMarkdownEditorStatus && (
              <div
                className={previewStyles.markdownEditorStatus}
                data-testid="markdown-editor-status"
                aria-live="polite"
              >
                {formatMarkdownEditorStatus(editorStats)}
              </div>
            )}
            {panelOpen && !artifact && (
              <div className={previewStyles.previewEmptyState}>
                <div className={previewStyles.previewEmptyIcon} aria-hidden="true">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                    <path d="M8 13h8" />
                    <path d="M8 17h5" />
                  </svg>
                </div>
                <button
                  type="button"
                  className={previewStyles.previewEmptyAction}
                  onClick={handleSelectPreviewFile}
                >
                  {tr('preview.selectFile', '选择文件')}
                </button>
                <div className={previewStyles.previewEmptyTitle}>{tr('preview.emptyTitle', '选择一个文档')}</div>
                <div className={previewStyles.previewEmptyHint}>{tr('preview.emptyHint', '从左侧文件区打开 Markdown、文档或生成物后会显示在这里。')}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
