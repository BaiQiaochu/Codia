import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { Artifact, DeskFile } from '../../types';
import { TimelineRailNavigator, type TimelineRailItem } from '../shared/TimelineRailNavigator';
import { measureTimelineMarkerWidthEm } from '../shared/timeline-marker-width';
import {
  extractMarkdownLinks,
  formatMarkdownPropertyValue,
  parseMarkdownFrontMatter,
  type MarkdownDocumentLink,
  type MarkdownHeading,
} from '../../utils/markdown-document';
import { resolveLinkTarget } from '../../utils/link-open';
import styles from './MarkdownChrome.module.css';

export interface DocumentReferencesSummary {
  backlinks: Array<{ filePath: string; title: string; line: number; label: string }>;
  outgoing: MarkdownDocumentLink[];
  externalCount: number;
}

function iconPath(kind: 'search' | 'up' | 'down' | 'close'): string {
  if (kind === 'search') return 'M21 21l-4.3-4.3m1.8-5.2a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z';
  if (kind === 'up') return 'M18 15l-6-6-6 6';
  if (kind === 'down') return 'M6 9l6 6 6-6';
  return 'M18 6L6 18M6 6l12 12';
}

function Icon({ kind }: { kind: 'search' | 'up' | 'down' | 'close' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPath(kind)} />
    </svg>
  );
}

function basenamePortable(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
}

function joinPath(root: string, subdir: string, name: string): string {
  return [normalizePath(root), subdir.replace(/^\/+|\/+$/g, ''), name]
    .filter(Boolean)
    .join('/');
}

function markdownFilesFromTree(root: string, tree: Record<string, DeskFile[]>): string[] {
  const files: string[] = [];
  for (const [subdir, entries] of Object.entries(tree || {})) {
    for (const entry of entries || []) {
      if (entry.isDir || !/\.(md|markdown|mdx)$/i.test(entry.name)) continue;
      files.push(joinPath(root, subdir, entry.name));
    }
  }
  return Array.from(new Set(files));
}

function relativePath(root: string, filePath: string): string {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(filePath);
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

function normalizeLinkedFilePath(href: string, baseFilePath: string): string | null {
  const target = resolveLinkTarget(href, { baseFilePath });
  return target.kind === 'file' ? normalizePath(target.filePath) : null;
}

function linkPointsToFile(link: MarkdownDocumentLink, sourceFilePath: string, targetFilePath: string, root: string): boolean {
  if (link.kind === 'wiki') {
    const raw = link.href.replace(/#.*$/, '').trim();
    const targetBase = basenamePortable(targetFilePath).replace(/\.(md|markdown|mdx)$/i, '').toLowerCase();
    const targetRel = relativePath(root, targetFilePath).replace(/\.(md|markdown|mdx)$/i, '').toLowerCase();
    const normalizedRaw = raw.replace(/\.(md|markdown|mdx)$/i, '').replace(/\\/g, '/').toLowerCase();
    return normalizedRaw === targetBase || normalizedRaw === targetRel;
  }
  const linkedPath = normalizeLinkedFilePath(link.href, sourceFilePath);
  return !!linkedPath && linkedPath === normalizePath(targetFilePath);
}

function knownTreeFileStatus(root: string, tree: Record<string, DeskFile[]>, filePath: string): 'exists' | 'missing' | 'unknown' {
  const rel = relativePath(root, filePath);
  if (rel === filePath) return 'unknown';
  const slash = rel.lastIndexOf('/');
  const subdir = slash >= 0 ? rel.slice(0, slash) : '';
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  const entries = tree[subdir];
  if (!entries) return 'unknown';
  return entries.some(entry => !entry.isDir && entry.name === name) ? 'exists' : 'missing';
}

function headingIndentRem(level: number): number {
  const normalizedLevel = Number.isFinite(level) ? Math.min(3, Math.max(1, Math.trunc(level))) : 1;
  return (normalizedLevel - 1) * 0.875;
}

export function ChapterRail({
  headings,
  activeHeadingId,
  railVisible = false,
  onJump,
}: {
  headings: MarkdownHeading[];
  activeHeadingId: string | null;
  railVisible?: boolean;
  onJump: (heading: MarkdownHeading) => void;
}) {
  if (headings.length === 0) return null;
  const items: Array<TimelineRailItem<MarkdownHeading>> = headings.map(heading => ({
    id: heading.id,
    label: heading.text,
    labelIndentRem: headingIndentRem(heading.level),
    markerWidthScale: 1.5,
    markerWidthEm: measureTimelineMarkerWidthEm(Array.from(heading.text).length),
    payload: heading,
  }));

  return (
    <TimelineRailNavigator
      items={items}
      active
      activeId={activeHeadingId}
      railVisible={railVisible}
      side="left"
      ariaLabel="Markdown sections"
      jumpLabel={item => `Jump to ${item.label}`}
      onJump={item => onJump(item.payload)}
    />
  );
}

export function MarkdownPropertiesBlock({ content }: { content: string }) {
  const frontMatter = useMemo(() => parseMarkdownFrontMatter(content), [content]);
  const entries = useMemo(() => (
    frontMatter ? Object.entries(frontMatter.attributes).filter(([, value]) => formatMarkdownPropertyValue(value)) : []
  ), [frontMatter]);
  if (!frontMatter || (entries.length === 0 && !frontMatter.error)) return null;

  return (
    <details className={styles.propertiesBlock}>
      <summary>
        <span>Properties</span>
        <span>{frontMatter.error ? 'YAML error' : `${entries.length}`}</span>
      </summary>
      {frontMatter.error ? (
        <div className={styles.propertiesError}>{frontMatter.error}</div>
      ) : (
        <dl>
          {entries.map(([key, value]) => (
            <div key={key} className={styles.propertyRow}>
              <dt>{key}</dt>
              <dd>{formatMarkdownPropertyValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}

export function ClassicFindBox({
  open,
  query,
  resultIndex,
  resultCount,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: {
  open: boolean;
  query: string;
  resultIndex: number;
  resultCount: number;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);
  if (!open) return null;
  const countLabel = query ? `${resultCount ? resultIndex + 1 : 0}/${resultCount}` : '0/0';
  return (
    <div className={styles.findBox} role="search">
      <Icon kind="search" />
      <input
        ref={inputRef}
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        aria-label="Find"
      />
      <span className={styles.findCount}>{countLabel}</span>
      <button type="button" onClick={onPrevious} aria-label="Previous match"><Icon kind="up" /></button>
      <button type="button" onClick={onNext} aria-label="Next match"><Icon kind="down" /></button>
      <button type="button" onClick={onClose} aria-label="Close find"><Icon kind="close" /></button>
    </div>
  );
}

export function LinkDiagnosticsBadge({
  previewItem,
  headings,
}: {
  previewItem: Artifact;
  headings: MarkdownHeading[];
}) {
  const deskBasePath = useStore(s => s.deskWorkspaceNativeRoot || s.deskBasePath);
  const tree = useStore(s => s.deskTreeFilesByPath);
  const issues = useMemo(() => {
    if (!previewItem.filePath) return [];
    const headingIds = new Set(headings.map(heading => heading.id));
    const next: string[] = [];
    for (const link of extractMarkdownLinks(previewItem.content)) {
      if (link.href.startsWith('#')) {
        const id = decodeURIComponent(link.href.slice(1));
        if (id && !headingIds.has(id)) next.push(`Line ${link.line + 1}: heading #${id} not found`);
        continue;
      }
      const target = resolveLinkTarget(link.href, { baseFilePath: previewItem.filePath, label: link.label });
      if (target.kind === 'file' && deskBasePath) {
        const status = knownTreeFileStatus(deskBasePath, tree, target.filePath);
        if (status === 'missing') next.push(`Line ${link.line + 1}: ${basenamePortable(target.filePath)} not found`);
      }
      if (target.kind === 'external' && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(link.href)) {
        try {
          new URL(link.href);
        } catch {
          next.push(`Line ${link.line + 1}: invalid URL`);
        }
      }
    }
    return next.slice(0, 4);
  }, [deskBasePath, headings, previewItem.content, previewItem.filePath, tree]);

  if (issues.length === 0) return null;
  return (
    <div className={styles.diagnosticsBadge} title={issues.join('\n')}>
      {issues.length} link issue{issues.length > 1 ? 's' : ''}
    </div>
  );
}

export function DocumentReferencesBlock({ previewItem }: { previewItem: Artifact }) {
  const root = useStore(s => previewItem.sourceRootPath || s.deskWorkspaceNativeRoot || s.deskBasePath);
  const tree = useStore(s => s.deskTreeFilesByPath);
  const [summary, setSummary] = useState<DocumentReferencesSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function scan() {
      if (!previewItem.filePath || !root) {
        setSummary(null);
        return;
      }
      const outgoing = extractMarkdownLinks(previewItem.content);
      const externalCount = outgoing.filter(link => {
        const target = resolveLinkTarget(link.href, { baseFilePath: previewItem.filePath, label: link.label });
        return target.kind === 'web' || target.kind === 'external';
      }).length;
      const candidates = markdownFilesFromTree(root, tree)
        .filter(filePath => normalizePath(filePath) !== normalizePath(previewItem.filePath || ''))
        .slice(0, 120);
      const backlinks: DocumentReferencesSummary['backlinks'] = [];
      await Promise.all(candidates.map(async (filePath) => {
        const snapshot = await window.platform?.readFileSnapshot?.(filePath).catch(() => null);
        const content = snapshot?.content;
        if (!content) return;
        const links = extractMarkdownLinks(content);
        const found = links.find(link => linkPointsToFile(link, filePath, previewItem.filePath || '', root));
        if (!found) return;
        backlinks.push({
          filePath,
          title: basenamePortable(filePath),
          line: found.line,
          label: found.label || found.href,
        });
      }));
      if (cancelled) return;
      setSummary({ backlinks, outgoing, externalCount });
    }
    void scan();
    return () => {
      cancelled = true;
    };
  }, [previewItem.content, previewItem.filePath, root, tree]);

  if (!summary || (summary.backlinks.length === 0 && summary.outgoing.length === 0)) return null;
  const outgoingPreview = summary.outgoing.slice(0, 8);
  return (
    <details className={styles.referencesBlock}>
      <summary>
        <span>References</span>
        <span>{summary.backlinks.length} in / {summary.outgoing.length} out</span>
      </summary>
      {summary.backlinks.length > 0 && (
        <section>
          <h4>Links to this note</h4>
          <ul>
            {summary.backlinks.slice(0, 8).map(link => (
              <li key={`${link.filePath}:${link.line}`}>
                <span>{link.title}</span>
                <small>line {link.line + 1}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {outgoingPreview.length > 0 && (
        <section>
          <h4>Links from this note</h4>
          <ul>
            {outgoingPreview.map((link, index) => (
              <li key={`${link.href}:${index}`}>
                <span>{link.label || link.href}</span>
                <small>{link.kind === 'wiki' ? 'wiki' : link.href}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </details>
  );
}
