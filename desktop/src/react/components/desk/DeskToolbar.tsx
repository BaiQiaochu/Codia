/**
  *
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { deskNativeRootDir, jumpToDeskSearchResult, loadDeskFiles, searchDeskFiles } from '../../stores/desk-actions';
import { canUseNativeResourcePath } from '../../services/resource-access';
import { resolveServerConnection } from '../../services/server-connection';
import type { DeskSearchResult } from '../../types';
import { isWebRuntime } from '../../utils/platform-runtime';
import {
  ICONS,
  getSortOptions,
  getSortShort,
  getFileTypeFilterOptions,
  getFilterShort,
  type SortMode,
  type FileTypeFilter,
  type CtxMenuState,
} from './desk-types';
import s from './Desk.module.css';

function canUseNativeDeskPath() {
  return canUseNativeResourcePath({ connection: resolveServerConnection(useStore.getState()) });
}

function openDeskNativeFolder(): void {
  if (!canUseNativeDeskPath()) return;
  const root = deskNativeRootDir(useStore.getState());
  if (root) window.platform?.openFolder?.(root);
}

// ── Open in Finder 按钮 ──

export function DeskOpenButton() {
  const webRuntime = isWebRuntime();
  const hasNativeRoot = useStore(st => (
    canUseNativeResourcePath({ connection: resolveServerConnection(st) })
    && !!deskNativeRootDir(st)
  ));
  const handleClick = useCallback(() => {
    openDeskNativeFolder();
  }, []);

  if (webRuntime || !hasNativeRoot) return null;

  return (
    <button type="button" className={s.openBtn} onClick={handleClick}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.finderOpen }} />
      <span>{(window.t ?? ((p: string) => p))('desk.openInFinder')}</span>
    </button>
  );
}

//

export function DeskOpenIconButton() {
  const webRuntime = isWebRuntime();
  const hasNativeRoot = useStore(st => (
    canUseNativeResourcePath({ connection: resolveServerConnection(st) })
    && !!deskNativeRootDir(st)
  ));
  const label = (window.t ?? ((p: string) => p))('desk.openInFinder');
  const handleClick = useCallback(() => {
    openDeskNativeFolder();
  }, []);

  if (webRuntime || !hasNativeRoot) return null;

  return (
    <button type="button" className={`${s.sortBtn} ${s.iconBtn}`} onClick={handleClick} title={label} aria-label={label} disabled={!hasNativeRoot}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.finderOpen }} />
    </button>
  );
}

export function DeskPreviewIconButton() {
  const previewOpen = useStore(st => st.previewOpen);
  const label = (window.t ?? ((p: string) => p))('preview.toggle');
  const handleClick = useCallback(() => {
    const state = useStore.getState();
    state.setPreviewOpen(!state.previewOpen);
  }, []);

  return (
    <button
      type="button"
      className={`${s.sortBtn} ${s.iconBtn}`}
      onClick={handleClick}
      title={label}
      aria-label={label}
      aria-pressed={previewOpen}
    >
      <span aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6.5 3.7h7.8c.5 0 .9.2 1.2.5l3.1 3.1c.3.3.5.8.5 1.2v9.1c0 1.4-1.1 2.6-2.6 2.6h-10c-1.4 0-2.6-1.1-2.6-2.6V6.3c0-1.4 1.1-2.6 2.6-2.6z" />
          <path d="M14.5 4.2v3c0 .8.6 1.4 1.4 1.4h3" />
          <path d="M8.1 12.4h7.8M8.1 15.8h6.1" />
        </svg>
      </span>
    </button>
  );
}

export function DeskBreadcrumb() {
  const deskCurrentPath = useStore(s => s.deskCurrentPath);

  const handleBack = useCallback(() => {
    const s = useStore.getState();
    const cur = s.deskCurrentPath;
    if (!cur) return;
    const parent = cur.includes('/')
      ? cur.substring(0, cur.lastIndexOf('/'))
      : '';
    loadDeskFiles(parent);
  }, []);

  if (!deskCurrentPath) return null;

  return (
    <div className={s.nav}>
      <button type="button" className={s.backBtn} onClick={handleBack}>
        <span dangerouslySetInnerHTML={{ __html: ICONS.back }} />
        <span>{deskCurrentPath}</span>
      </button>
    </div>
  );
}

// ── 排序按钮 ──

export function DeskRefreshButton() {
  const hasDesk = useStore(s => !!s.deskBasePath);
  const handleClick = useCallback(() => {
    if (!useStore.getState().deskBasePath) return;
    void loadDeskFiles();
  }, []);
  const label = (window.t ?? ((p: string) => p))('desk.refresh');

  return (
    <button type="button" className={`${s.sortBtn} ${s.iconBtn}`} onClick={handleClick} title={label} aria-label={label} disabled={!hasDesk}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.refresh }} />
    </button>
  );
}

export function DeskSortButton({ sortMode, onSort, onShowMenu }: {
  sortMode: SortMode;
  onSort: (m: SortMode) => void;
  onShowMenu: (state: CtxMenuState) => void;
}) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onShowMenu({
      position: { x: rect.left, y: rect.bottom + 4 },
      items: getSortOptions().map(o => ({
        label: (o.key === sortMode ? '路 ' : '   ') + o.label,
        action: () => {
          localStorage.setItem('codia-desk-sort', o.key);
          onSort(o.key);
        },
      })),
    });
  }, [sortMode, onSort, onShowMenu]);

  return (
    <button type="button" className={s.sortBtn} onClick={handleClick}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.sort }} />
      <span>{getSortShort(sortMode)}</span>
    </button>
  );
}

export function DeskFilterButton({ filters, onFiltersChange, onShowMenu }: {
  filters: FileTypeFilter[];
  onFiltersChange: (filters: FileTypeFilter[]) => void;
  onShowMenu: (state: CtxMenuState) => void;
}) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onShowMenu({
      position: { x: rect.left, y: rect.bottom + 4 },
      items: [
        ...getFileTypeFilterOptions().map(o => ({
          label: o.label,
          checked: filters.includes(o.key),
          action: () => {
            const next = filters.includes(o.key)
              ? filters.filter(item => item !== o.key)
              : [...filters, o.key];
            onFiltersChange(next);
          },
        })),
        ...(filters.length > 0 ? [{
          divider: true as const,
        }, {
          label: (window.t ?? ((p: string) => p))('desk.filter.clear'),
          action: () => onFiltersChange([]),
        }] : []),
      ],
    });
  }, [filters, onFiltersChange, onShowMenu]);

  const label = (window.t ?? ((p: string) => p))('desk.filter.label');
  return (
    <button type="button"
      className={`${s.sortBtn}${filters.length > 0 ? ` ${s.filterBtnActive}` : ''}`}
      onClick={handleClick}
      aria-label={label}
      title={label}
    >
      <span dangerouslySetInnerHTML={{ __html: ICONS.filter }} />
      <span>{getFilterShort(filters)}</span>
    </button>
  );
}

export function DeskSearchBox() {
  const hasDesk = useStore(s => !!s.deskBasePath);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DeskSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const versionRef = useRef(0);
  const t = window.t ?? ((p: string) => p);

  useEffect(() => {
    const trimmed = query.trim();
    const version = ++versionRef.current;
    if (!trimmed || !hasDesk) {
      setResults([]);
      setOpen(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      void searchDeskFiles(trimmed).then((items) => {
        if (versionRef.current !== version) return;
        setResults(items);
        setOpen(true);
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [hasDesk, query]);

  const handlePick = useCallback(async (result: DeskSearchResult) => {
    setOpen(false);
    await jumpToDeskSearchResult(result);
  }, []);

  return (
    <div className={s.searchWrap}>
      <input
        className={s.searchInput}
        value={query}
        placeholder={t('desk.search.placeholder')}
        aria-label={t('desk.search.label')}
        disabled={!hasDesk}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      {open && query.trim() && (
        <div className={s.searchResults} role="listbox" aria-label={t('desk.search.results')}>
          {results.length === 0 ? (
            <div className={s.searchEmpty}>{t('desk.search.empty')}</div>
          ) : (
            results.map(result => (
              <button
                key={result.relativePath}
                type="button"
                className={s.searchResult}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void handlePick(result)}
              >
                <span className={s.searchResultName}>{result.name}</span>
                <span className={s.searchResultPath}>{result.parentSubdir || t('desk.search.root')}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
