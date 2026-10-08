/**
 * ArtifactRenderer — Artifact 内容的声明式渲染
 *
 * 替代 PreviewPanel 中命令式 DOM 构建的 switch/case useEffect。
 * 每种 artifact 类型对应一个 JSX 分支或子组件。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode, type WheelEvent } from 'react';
import { renderMarkdownPreview } from '../../utils/markdown';
import {
  parseMarkdownCover,
  removeMarkdownCover,
  resolveMarkdownCoverImagePath,
  stripMarkdownFrontMatterForPreview,
  updateMarkdownCoverLayout,
  type MarkdownCover,
  type MarkdownCoverLayoutPatch,
} from '../../utils/markdown-cover';
import {
  dispatchCoverNotice,
} from '../../utils/markdown-cover-generation';
import {
  regenerateMarkdownCoverWithPrompt,
} from '../../utils/markdown-cover-actions';
import {
  applyMarkdownCoverImageDrop,
  hasMarkdownCoverDropImage,
} from '../../utils/markdown-cover-drop';
import { parseCSV, injectCopyButtons } from '../../utils/format';
import { fileIconSvg } from '../../utils/icons';
import { useMermaidDiagrams } from '../../hooks/use-mermaid-diagrams';
import { bindMarkdownVisualControls } from '../../utils/markdown-visual-controls';
import { gsapFetch } from '../../hooks/use-gsap-fetch';
import { openInternalLink, resolveLinkTarget, type LinkOpenContext } from '../../utils/link-open';
import { useStore } from '../../stores';
import { upsertArtifact } from '../../stores/preview-actions';
import type { Artifact, DesignDocumentPreview } from '../../types';
import { DocumentReferencesBlock, MarkdownPropertiesBlock } from './MarkdownChrome';
import previewStyles from '../Preview.module.css';

interface ArtifactRendererProps {
  artifact: Artifact;
}

function tr(key: string, fallback: string): string {
  const t = window.t ?? ((p: string) => p);
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizePathForCompare(value: string | null | undefined) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function isPathInsideRoot(filePath: string | null | undefined, rootPath: string | null | undefined) {
  const file = normalizePathForCompare(filePath);
  const root = normalizePathForCompare(rootPath);
  return Boolean(file && root && (file === root || file.startsWith(`${root}/`)));
}

function resolveArtifactSandboxRoot(filePath: Artifact['filePath']) {
  const state = useStore.getState();
  const candidates = [
    state.deskBasePath,
    state.selectedFolder,
    state.homeFolder,
    ...(Array.isArray(state.workspaceFolders) ? state.workspaceFolders : []),
  ];
  return candidates.find((root) => isPathInsideRoot(filePath, root)) || undefined;
}

function safeDownloadName(name: string, fallback: string): string {
  const cleaned = Array.from(name.trim().replace(/[<>:"/\\|?*]+/g, '_'))
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
    .slice(0, 120);
  return cleaned || fallback;
}

function imageDownloadName(src: string, alt: string): string {
  const fromAlt = safeDownloadName(alt, '');
  if (fromAlt && /\.[a-z0-9]{2,5}$/i.test(fromAlt)) return fromAlt;
  if (/^data:image\/svg\+xml/i.test(src)) return `${fromAlt || 'image'}.svg`;
  if (/^data:image\/jpe?g/i.test(src)) return `${fromAlt || 'image'}.jpg`;
  if (/^data:image\/webp/i.test(src)) return `${fromAlt || 'image'}.webp`;
  if (/^data:image\/gif/i.test(src)) return `${fromAlt || 'image'}.gif`;
  try {
    const url = new URL(src);
    const base = decodeURIComponent(url.pathname.split('/').pop() || '');
    if (base) return safeDownloadName(base, `${fromAlt || 'image'}.png`);
  } catch {
    // fall through to a stable default name
  }
  return `${fromAlt || 'image'}.png`;
}

function ZoomablePreviewImage({ src, alt }: { src: string; alt: string }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<null | { x: number; y: number; ox: number; oy: number }>(null);
  const downloadRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
  }, [src]);

  const zoomBy = useCallback((delta: number) => {
    setScale((current) => clampNumber(Number((current + delta).toFixed(2)), 0.25, 5));
  }, []);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 0.12 : -0.12);
  }, [zoomBy]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      ox: offset.x,
      oy: offset.y,
    };
  }, [offset.x, offset.y]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({
      x: drag.ox + event.clientX - drag.x,
      y: drag.oy + event.clientY - drag.y,
    });
  }, []);

  const handlePointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const download = useCallback(() => {
    const link = downloadRef.current;
    if (!link) return;
    link.href = src;
    link.download = imageDownloadName(src, alt);
    link.click();
  }, [alt, src]);

  return (
    <div className="preview-image-viewer" onWheel={handleWheel}>
      <div
        className="preview-image-stage"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <img
          className="preview-image"
          src={src}
          alt={alt}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            cursor: dragRef.current ? 'grabbing' : 'grab',
          }}
        />
      </div>
      <div className="preview-image-toolbar" aria-label="图片预览工具">
        <button type="button" onClick={() => zoomBy(-0.15)} aria-label="缩小">-</button>
        <span>{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => zoomBy(0.15)} aria-label="放大">+</button>
        <button type="button" onClick={reset}>重置</button>
        <button type="button" onClick={download}>下载</button>
        <a ref={downloadRef} hidden aria-hidden="true" rel="noopener" />
      </div>
    </div>
  );
}

// ── MarkdownPreview ──

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coverLayout(cover: MarkdownCover): Required<MarkdownCoverLayoutPatch> {
  return {
    displayWidth: clamp(cover.displayWidth ?? 100, 40, 100),
    displayHeight: clamp(cover.displayHeight ?? 320, 160, 720),
    positionX: clamp(cover.positionX ?? 50, 0, 100),
    positionY: clamp(cover.positionY ?? 50, 0, 100),
  };
}

function hasNonLocalProtocol(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
}

function localBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'cover.png';
}

function joinLocalPath(dirPath: string, fileName: string): string {
  const sep = dirPath.includes('\\') && !dirPath.includes('/') ? '\\' : '/';
  return `${dirPath.replace(/[\\/]+$/, '')}${sep}${fileName}`;
}

function MarkdownCoverView({ artifact, cover }: { artifact: Artifact; cover: MarkdownCover }) {
  const coverImage = cover.image;
  const coverDisplayWidth = cover.displayWidth;
  const coverDisplayHeight = cover.displayHeight;
  const coverPositionX = cover.positionX;
  const coverPositionY = cover.positionY;
  const coverLayoutSnapshot = useMemo(
    () => coverLayout({
      image: coverImage,
      displayWidth: coverDisplayWidth,
      displayHeight: coverDisplayHeight,
      positionX: coverPositionX,
      positionY: coverPositionY,
    }),
    [
      coverDisplayHeight,
      coverDisplayWidth,
      coverImage,
      coverPositionX,
      coverPositionY,
    ],
  );
  const [layout, setLayout] = useState(() => coverLayoutSnapshot);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [coverDropActive, setCoverDropActive] = useState(false);
  const layoutRef = useRef(layout);
  const dragRef = useRef<null | {
    kind: 'position' | 'height';
    startY: number;
    startLayout: Required<MarkdownCoverLayoutPatch>;
  }>(null);

  useEffect(() => {
    setLayout(coverLayoutSnapshot);
  }, [coverLayoutSnapshot]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const imagePath = resolveMarkdownCoverImagePath(artifact.filePath, cover.image);
  const imageUrl = imagePath && hasNonLocalProtocol(imagePath)
    ? imagePath
    : imagePath ? window.platform?.getFileUrl?.(imagePath) || imagePath : null;

  const persistLayout = useCallback(async (nextLayout: Required<MarkdownCoverLayoutPatch>) => {
    if (!artifact.filePath || !window.platform?.writeFileIfUnchanged) return;

    const writeNext = async (content: string, version: Artifact['fileVersion']) => {
      const nextContent = updateMarkdownCoverLayout(content, nextLayout);
      const result = await window.platform?.writeFileIfUnchanged?.(artifact.filePath!, nextContent, version || null);
      return { nextContent, result };
    };

    let { nextContent, result } = await writeNext(artifact.content, artifact.fileVersion);
    if (!result?.ok && result?.conflict && window.platform?.readFileSnapshot) {
      const snapshot = await window.platform.readFileSnapshot(artifact.filePath);
      if (snapshot?.content != null) {
        ({ nextContent, result } = await writeNext(snapshot.content, snapshot.version));
      }
    }

    if (result?.ok) {
      upsertArtifact({ ...artifact, content: nextContent, fileVersion: result.version });
    }
  }, [artifact]);

  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) void persistLayout(layoutRef.current);
  }, [persistLayout]);

  useEffect(() => {
    const onMove = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dy = event.clientY - drag.startY;
      if (drag.kind === 'height') {
        setLayout(prev => ({
          ...prev,
          displayHeight: clamp(drag.startLayout.displayHeight + dy, 160, 720),
        }));
        return;
      }
      const delta = (dy / Math.max(1, drag.startLayout.displayHeight)) * 100;
      setLayout(prev => ({
        ...prev,
        positionY: clamp(drag.startLayout.positionY - delta, 0, 100),
      }));
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };
  }, [finishDrag]);

  const beginDrag = useCallback((kind: 'position' | 'height', event: PointerEvent) => {
    event.preventDefault();
    setMenu(null);
    dragRef.current = {
      kind,
      startY: event.clientY,
      startLayout: layout,
    };
  }, [layout]);

  const saveImage = useCallback(async () => {
    setMenu(null);
    if (!imagePath || hasNonLocalProtocol(imagePath)) {
      dispatchCoverNotice('当前 cover 不是本地图片，无法直接保存。', 'error');
      return;
    }
    const folder = await window.platform?.selectFolder?.();
    if (!folder || typeof window.platform?.copyFile !== 'function') return;
    const ok = await window.platform.copyFile(imagePath, joinLocalPath(folder, localBasename(imagePath)));
    dispatchCoverNotice(ok ? 'Cover 图片已保存。' : 'Cover 图片保存失败。', ok ? 'success' : 'error');
  }, [imagePath]);

  const regenerateWithPrompt = useCallback(async () => {
    setMenu(null);
    await regenerateMarkdownCoverWithPrompt(artifact.filePath);
  }, [artifact.filePath]);

  const deleteCover = useCallback(async () => {
    setMenu(null);
    if (!artifact.filePath || !window.platform?.writeFileIfUnchanged) return;

    const writeNext = async (content: string, version: Artifact['fileVersion']) => {
      const nextContent = removeMarkdownCover(content);
      const result = await window.platform?.writeFileIfUnchanged?.(artifact.filePath!, nextContent, version || null);
      return { nextContent, result };
    };

    let { nextContent, result } = await writeNext(artifact.content, artifact.fileVersion);
    if (!result?.ok && result?.conflict && window.platform?.readFileSnapshot) {
      const snapshot = await window.platform.readFileSnapshot(artifact.filePath);
      if (snapshot?.content != null) {
        ({ nextContent, result } = await writeNext(snapshot.content, snapshot.version));
      }
    }

    if (result?.ok) {
      upsertArtifact({ ...artifact, content: nextContent, fileVersion: result.version });
    }
  }, [artifact]);

  const handleCoverDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!artifact.filePath || !hasMarkdownCoverDropImage(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setCoverDropActive(true);
  }, [artifact.filePath]);

  const handleCoverDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setCoverDropActive(false);
  }, []);

  const handleCoverDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!artifact.filePath || !hasMarkdownCoverDropImage(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setCoverDropActive(false);
    void applyMarkdownCoverImageDrop({
      filePath: artifact.filePath,
      dataTransfer: event.dataTransfer,
    });
  }, [artifact.filePath]);

  if (!imageUrl) return null;

  return (
    <div
      className={`markdown-cover${coverDropActive ? ' markdown-cover-drop-active' : ''}`}
      style={{
        width: `${layout.displayWidth}%`,
        height: `${layout.displayHeight}px`,
        marginLeft: 'auto',
        marginRight: 'auto',
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onDragOver={handleCoverDragOver}
      onDragLeave={handleCoverDragLeave}
      onDrop={handleCoverDrop}
    >
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={{ objectPosition: `${layout.positionX}% ${layout.positionY}%` }}
        onPointerDown={(event) => beginDrag('position', event)}
      />
      <div
        className="markdown-cover-resize"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={(event) => beginDrag('height', event)}
      />
      {menu && (
        <div
          className="markdown-cover-menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={saveImage}>{tr('preview.cover.saveImage', '保存图片')}</button>
          <button type="button" onClick={regenerateWithPrompt}>{tr('preview.cover.regenerateWithPrompt', '自定义提示词生成图片')}</button>
          <button type="button" className="markdown-cover-menu-danger" onClick={deleteCover}>{tr('preview.cover.deleteCover', '删除封面')}</button>
        </div>
      )}
    </div>
  );
}

function isMarkdownTopCoverDrop(event: DragEvent<HTMLElement>): boolean {
  const rect = event.currentTarget.getBoundingClientRect();
  const y = Number.isFinite(event.clientY) ? event.clientY : rect.top;
  return y >= rect.top && y <= rect.top + 40;
}

function MarkdownCoverDropRail({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`markdown-cover-drop-rail${active ? ' markdown-cover-drop-rail-active' : ''}`}
    />
  );
}

function MarkdownNoCoverDropHost({ filePath, children }: { filePath?: string; children: ReactNode }) {
  const [active, setActive] = useState(false);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!filePath || !hasMarkdownCoverDropImage(event.dataTransfer) || !isMarkdownTopCoverDrop(event)) {
      setActive(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setActive(true);
  }, [filePath]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setActive(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!filePath || !hasMarkdownCoverDropImage(event.dataTransfer) || !isMarkdownTopCoverDrop(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setActive(false);
    void applyMarkdownCoverImageDrop({
      filePath,
      dataTransfer: event.dataTransfer,
    });
  }, [filePath]);

  if (!filePath) return <>{children}</>;
  return (
    <div
      className="markdown-cover-drop-host"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <MarkdownCoverDropRail active={active} />
      {children}
    </div>
  );
}

function MarkdownPreview({ artifact }: { artifact: Artifact }) {
  const divRef = useRef<HTMLDivElement>(null);
  const cover = useMemo(() => parseMarkdownCover(artifact.content), [artifact.content]);
  const body = useMemo(() => stripMarkdownFrontMatterForPreview(artifact.content), [artifact.content]);
  const linkContext = useMemo<LinkOpenContext>(() => ({
    origin: 'desk',
    baseFilePath: artifact.filePath,
  }), [artifact.filePath]);

  useEffect(() => {
    if (divRef.current) {
      injectCopyButtons(divRef.current);
    }
  }, [body]);
  useEffect(() => {
    if (!divRef.current) return undefined;
    return bindMarkdownVisualControls(divRef.current);
  }, [body]);
  useMermaidDiagrams(divRef, [body]);

  const findAnchor = useCallback((event: MouseEvent<HTMLDivElement>): HTMLAnchorElement | null => {
    const root = divRef.current;
    const target = event.target;
    if (!root || !(target instanceof Element)) return null;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || !root.contains(anchor)) return null;
    return anchor;
  }, []);

  const handleLinkClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const anchor = findAnchor(event);
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const context = {
      ...linkContext,
      label: anchor.textContent?.trim() || undefined,
    };
    if (resolveLinkTarget(href, context).kind === 'anchor') return;
    event.preventDefault();
    event.stopPropagation();
    void openInternalLink(href, context);
  }, [findAnchor, linkContext]);

  return (
    <div className={previewStyles.markdownPreviewDocument}>
      {cover && <MarkdownCoverView artifact={artifact} cover={cover} />}
      <MarkdownPropertiesBlock content={artifact.content} />
      {cover ? (
        <div
          ref={divRef}
          className="preview-markdown md-content markdown-has-cover"
          onClick={handleLinkClick}
          dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(body, { filePath: artifact.filePath, getFileUrl: window.platform?.getFileUrl }) }}
        />
      ) : (
        <MarkdownNoCoverDropHost filePath={artifact.filePath}>
          <div
            ref={divRef}
            className="preview-markdown md-content"
            onClick={handleLinkClick}
            dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(body, { filePath: artifact.filePath, getFileUrl: window.platform?.getFileUrl }) }}
          />
        </MarkdownNoCoverDropHost>
      )}
      <DocumentReferencesBlock previewItem={artifact} />
    </div>
  );
}

// ── CsvPreview ──

function CsvPreview({ content }: { content: string }) {
  const rows = parseCSV(content);
  if (rows.length === 0) {
    return <div className="preview-csv"><table /></div>;
  }

  const headerRow = rows[0];
  const bodyRows = rows.slice(1);

  return (
    <div className="preview-csv">
      <table>
        <thead>
          <tr>
            {headerRow.map((cell, i) => (
              <th key={`csv-h-${i}`}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, ri) => (
            <tr key={`csv-r-${ri}`}>
              {row.map((cell, ci) => (
                <td key={`csv-c-${ri}-${ci}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── PdfPreview ──
// data: URL 在 Electron 中无法渲染大 PDF，改用 blob URL 触发 Chromium 内置查看器

function normalizeBase64Payload(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const dataUrlMatch = /^data:application\/pdf(?:;[^,]*)?;base64,(.*)$/is.exec(trimmed);
  const payload = (dataUrlMatch?.[1] ?? trimmed)
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  if (!payload || payload.length % 4 === 1) return null;
  return payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
}

function pdfContentToBuffer(content: string): ArrayBuffer | null {
  const payload = normalizeBase64Payload(content);
  if (!payload || typeof globalThis.atob !== 'function') return null;

  try {
    const raw = globalThis.atob(payload);
    const pdfHeaderAt = raw.slice(0, 1024).indexOf('%PDF-');
    if (pdfHeaderAt < 0) return null;

    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

function DocumentPreviewError({ filePath }: { filePath?: string }) {
  const canOpen = !!filePath && typeof window.platform?.openFile === 'function';

  return (
    <div className="preview-document-error" role="alert">
      <div className="preview-document-error-title">
        {tr('preview.documentUnavailable', 'Document preview unavailable')}
      </div>
      <div className="preview-document-error-hint">
        {tr('preview.documentOpenWithDefaultHint', 'The file could not be rendered here. You can open it with the default app.')}
      </div>
      {canOpen && (
        <button
          className="preview-document-error-open"
          type="button"
          onClick={() => window.platform?.openFile?.(filePath)}
        >
          {tr('desk.openWithDefault', 'Open with default app')}
        </button>
      )}
    </div>
  );
}

function missingPreviewTitle(status: Artifact['status']): string {
  if (status === 'expired') return tr('preview.fileExpired', 'File preview expired');
  return tr('preview.fileMissing', 'File no longer available');
}

function MissingPreviewTarget({ artifact }: { artifact: Artifact }) {
  const fileLabel = artifact.filePath || artifact.title;
  return (
    <div className={previewStyles.previewUnavailable} role="status">
      <p>{missingPreviewTitle(artifact.status)}</p>
      <span title={fileLabel}>{fileLabel}</span>
    </div>
  );
}

function PdfPreview({ content, filePath, sourceUrl }: { content: string; filePath?: string; sourceUrl?: string }) {
  const blobUrl = useMemo(() => {
    if (sourceUrl) return null;
    const buffer = pdfContentToBuffer(content);
    if (!buffer || typeof URL.createObjectURL !== 'function') return null;
    try {
      return URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
    } catch {
      return null;
    }
  }, [content, sourceUrl]);
  const url = sourceUrl || blobUrl;

  useEffect(() => {
    return () => {
      if (blobUrl && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  if (!url) return <DocumentPreviewError filePath={filePath} />;

  return <iframe className="preview-pdf" src={`${url}#toolbar=0&navpanes=0`} />;
}

// ── DesignDocumentPreview ──

function parseDesignDocument(content: string): DesignDocumentPreview | null {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.format !== 'string') return null;
    return parsed as DesignDocumentPreview;
  } catch {
    return null;
  }
}

function formatBytes(size?: number): string | null {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

interface MindMapPreviewNode {
  title: string;
  children: MindMapPreviewNode[];
}

function mindMapLevel(item: string): number {
  const leading = item.match(/^\s*/)?.[0].length || 0;
  return Math.max(0, Math.floor(leading / 2));
}

function mindMapTreeFromPreview(preview: DesignDocumentPreview): MindMapPreviewNode {
  const sections = Array.isArray(preview.sections) ? preview.sections : [];
  const topicSection = sections.find(section => /topics?/i.test(section.title)) || sections[0];
  const items = Array.isArray(topicSection?.items) ? topicSection.items : [];
  const fallbackTitle = preview.title || preview.fileName || tr('preview.mindmapTitle', '思维导图');
  const stack: MindMapPreviewNode[] = [];
  let root: MindMapPreviewNode | null = null;

  for (const rawItem of items) {
    const title = String(rawItem || '').trim();
    if (!title) continue;
    const level = mindMapLevel(String(rawItem));
    const node: MindMapPreviewNode = { title, children: [] };

    if (!root) {
      root = node;
      stack[0] = node;
      continue;
    }

    if (level === 0) {
      root.children.push(node);
      stack[1] = node;
      stack.length = 2;
      continue;
    }

    const parent = stack[level - 1] || root;
    parent.children.push(node);
    stack[level] = node;
    stack.length = level + 1;
  }

  return root || { title: fallbackTitle, children: [] };
}

const MIND_MAP_COLORS = [
  'var(--preview-mindmap-branch-1)',
  'var(--preview-mindmap-branch-2)',
  'var(--preview-mindmap-branch-3)',
  'var(--preview-mindmap-branch-4)',
  'var(--preview-mindmap-branch-5)',
  'var(--preview-mindmap-branch-6)',
];

function MindMapBranch({ node, depth, index }: { node: MindMapPreviewNode; depth: number; index: number }) {
  const color = MIND_MAP_COLORS[(depth + index) % MIND_MAP_COLORS.length];
  return (
    <div className="preview-mindmap-branch" style={{ '--branch-color': color } as CSSProperties}>
      <div className="preview-mindmap-connector" aria-hidden="true" />
      <div className="preview-mindmap-group">
        <div className="preview-mindmap-node">{node.title}</div>
        {node.children.length > 0 && (
          <div className="preview-mindmap-children">
            {node.children.map((child, childIndex) => (
              <MindMapBranch
                key={`${child.title}-${depth}-${childIndex}`}
                node={child}
                depth={depth + 1}
                index={childIndex}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MindMapPreviewCanvas({ preview }: { preview: DesignDocumentPreview }) {
  const root = mindMapTreeFromPreview(preview);
  return (
    <div className="preview-mindmap-canvas">
      <div className="preview-mindmap-stage">
        <div className="preview-mindmap-root">{root.title}</div>
        <div className="preview-mindmap-branches">
          {root.children.length > 0 ? root.children.map((child, index) => (
            <MindMapBranch key={`${child.title}-${index}`} node={child} depth={1} index={index} />
          )) : (
            <div className="preview-mindmap-empty">
              {tr('preview.mindmapEmpty', '未提取到子主题。')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DesignDocumentPreviewPane({ artifact }: { artifact: Artifact }) {
  const preview = parseDesignDocument(artifact.content);
  if (!preview) {
    return (
      <div className="preview-document-error" role="alert">
        <div className="preview-document-error-title">
          {tr('preview.designUnavailable', 'Design document preview unavailable')}
        </div>
        <div className="preview-document-error-hint">
          {tr('preview.designUnavailableHint', 'The built-in reader could not parse this design document summary.')}
        </div>
      </div>
    );
  }

  const sizeLabel = formatBytes(preview.fileSize);
  const sections = Array.isArray(preview.sections) ? preview.sections : [];
  const warnings = Array.isArray(preview.warnings) ? preview.warnings : [];
  const isMindMap = preview.kind === 'mindmap' || preview.ext === 'xmind' || preview.format.toLowerCase() === 'xmind';

  return (
    <div className="preview-design-document">
      <div className="preview-design-document-header">
        <div className="preview-design-document-label">
          {preview.kind || tr('preview.designDocument', 'Design document')}
        </div>
        <h2>{preview.format}</h2>
        <div className="preview-design-document-meta">
          {preview.fileName || artifact.title}
          {preview.ext ? ` · .${preview.ext}` : ''}
          {sizeLabel ? ` · ${sizeLabel}` : ''}
        </div>
      </div>

      <div className="preview-design-document-summary">
        {preview.summary || tr('preview.designSummaryEmpty', 'No summary was extracted.')}
      </div>

      <div className={`preview-design-document-status ${preview.canRenderNatively ? 'is-native' : 'is-limited'}`}>
        {preview.canRenderNatively
          ? tr('preview.designNativeSummary', 'Built-in reader extracted structured content without opening another app.')
          : tr('preview.designLimitedSummary', 'Built-in reader extracted metadata and identifiers; native geometry rendering is not available.')}
      </div>

      {warnings.length > 0 && (
        <div className="preview-design-document-warnings" role="note">
          {warnings.map((warning, index) => (
            <div key={`warning-${index}`} className="preview-design-document-warning">{warning}</div>
          ))}
        </div>
      )}

      {isMindMap ? (
        <MindMapPreviewCanvas preview={preview} />
      ) : (
        <div className="preview-design-document-sections">
          {sections.map((section, index) => (
            <section key={`${section.title}-${index}`} className="preview-design-document-section">
              <h3>{section.title}</h3>
              <ul>
                {(Array.isArray(section.items) ? section.items : []).map((item, itemIndex) => (
                  <li key={`${section.title}-${itemIndex}`}><span>{item}</span></li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// ── CodePreview ──

function HtmlPreview({ artifact }: { artifact: Artifact }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sandboxRoot = useMemo(() => resolveArtifactSandboxRoot(artifact.filePath), [artifact.filePath]);

  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    setError(null);

    gsapFetch('/api/preview/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: artifact.title,
        content: artifact.content,
        sourceFilePath: artifact.filePath,
        sandboxRoot,
      }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!data || typeof data.previewUrl !== 'string' || !data.previewUrl) {
          throw new Error('invalid html preview response');
        }
        if (!cancelled) setPreviewUrl(data.previewUrl);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.content, artifact.filePath, artifact.title, sandboxRoot]);

  if (error) {
    return <pre className="preview-code">{error}</pre>;
  }

  return (
    <iframe
      className="preview-html-frame"
      data-html-preview-frame=""
      title={artifact.title}
      src={previewUrl || 'about:blank'}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
    />
  );
}

function CodePreviewWithLines({ artifact }: { artifact: Artifact }) {
  const lines = artifact.content.length > 0 ? artifact.content.split('\n') : [''];

  return (
    <pre className="preview-code preview-code-with-lines">
      <code className={artifact.language ? `language-${artifact.language}` : undefined}>
        {lines.map((line, index) => (
          <span key={index} className="preview-code-line">
            <span className="preview-code-line-number" aria-hidden="true">{index + 1}</span>
            <span className="preview-code-line-content">{line || ' '}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}

// ── FileInfoPreview ──

function FileInfoPreview({ artifact }: { artifact: Artifact }) {
  const t = window.t ?? ((p: string) => p);
  const ext = artifact.ext || '';

  return (
    <div className="preview-file-info">
      <div
        className="preview-file-icon"
        dangerouslySetInnerHTML={{ __html: fileIconSvg(ext) }}
      />
      <div className="preview-file-name">{artifact.title}</div>
      <div className="preview-file-ext">
        {ext.toUpperCase()} {t('desk.fileLabel')}
      </div>
      <button type="button"
        className="preview-file-open-btn"
        onClick={() => {
          if (artifact.filePath) window.platform?.openFile?.(artifact.filePath);
        }}
      >
        {t('desk.openWithDefault')}
      </button>
    </div>
  );
}

// ── ArtifactRenderer ──

export function ArtifactRenderer({ artifact }: ArtifactRendererProps) {
  if (artifact.status === 'missing') {
    return <MissingPreviewTarget artifact={artifact} />;
  }

  switch (artifact.type) {
    case 'html':
      return <HtmlPreview artifact={artifact} />;

    case 'markdown':
      return <MarkdownPreview artifact={artifact} />;

    case 'code':
      return <CodePreviewWithLines artifact={artifact} />;

    case 'csv':
      return <CsvPreview content={artifact.content} />;

    case 'svg':
      return (
        <ZoomablePreviewImage
          src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(artifact.content)))}`}
          alt={artifact.title}
        />
      );

    case 'image': {
      const ext = artifact.ext === 'jpg' ? 'jpeg' : (artifact.ext || 'png');
      return (
        <ZoomablePreviewImage
          src={`data:image/${ext};base64,${artifact.content}`}
          alt={artifact.title}
        />
      );
    }

    case 'pdf':
      return <PdfPreview content={artifact.content} filePath={artifact.filePath} sourceUrl={artifact.sourceUrl} />;

    case 'design-document':
      return <DesignDocumentPreviewPane artifact={artifact} />;

    case 'docx':
    case 'xlsx':
      return <HtmlPreview artifact={artifact} />;

    case 'file-info':
      return <FileInfoPreview artifact={artifact} />;

    default:
      return (
        <pre className="preview-code">{artifact.content}</pre>
      );
  }
}
