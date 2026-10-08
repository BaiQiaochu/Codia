/**
 * DeskFileItem -书桌中的单个文件/文件夹条- */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import {
  loadDeskFiles,
  deskFullPath,
  deskCreateMindmapFromDocument,
  deskMoveFiles,
  deskRemoveFile,
} from '../../stores/desk-actions';
import { gsapFetch } from '../../hooks/use-gsap-fetch';
import { toSlash } from '../../utils/format';
import { resolveBrowserFilePaths } from '../../utils/browser-file-paths';
import { openFilePreview } from '../../utils/file-preview';
import type { DeskFile } from '../../types';
import type { ContextMenuItem } from '../ContextMenu';
import {
  ICONS,
  getFileIcon,
  getVsCodeFileIcon,
  getVsCodeFolderIcon,
  _deskDragNames,
  setDeskDragNames,
  type CtxMenuState,
} from './desk-types';
import st from './Desk.module.css';

const DOCUMENT_MINDMAP_EXTS = new Set([
  'md', 'markdown', 'txt', 'csv',
  'js', 'ts', 'jsx', 'tsx', 'py', 'css', 'json', 'yaml', 'yml',
  'xml', 'sql', 'sh', 'bash', 'c', 'cpp', 'h', 'java', 'rs', 'go', 'rb', 'php',
  'docx', 'xlsx', 'xls', 'pdf',
]);

// ── Props ──

export interface DeskFileItemProps {
  file: DeskFile;
  selected: boolean;
  onSelect: (name: string, meta: { multi: boolean; shift: boolean }) => void;
  allSelectedFiles: string[];
  renamingFile: string | null;
  renameValue: string;
  onRenameStart: (name: string) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onShowContextMenu: (state: CtxMenuState) => void;
}

//

async function handleExternalDropToFolder(
  e: React.DragEvent,
  folderName: string,
) {
  const s = useStore.getState();
  const basePath = s.deskBasePath;
  const curPath = s.deskCurrentPath;
  const curDir = curPath ? basePath + '/' + curPath : basePath;
  if (!curDir) return;

  const droppedFiles = e.dataTransfer.files;
  if (!droppedFiles || droppedFiles.length === 0) return;

  const { paths } = await resolveBrowserFilePaths(Array.from(droppedFiles));
  if (paths.length === 0) return;

  const curDirNorm = toSlash(curDir).replace(/\/+$/, '') + '/';
  const internalNames: string[] = [];
  const externalPaths: string[] = [];

  for (const p of paths) {
    const pNorm = toSlash(p);
    if (pNorm.startsWith(curDirNorm)) {
      const rel = pNorm.slice(curDirNorm.length);
      if (!rel.includes('/')) internalNames.push(rel);
      else externalPaths.push(p);
    } else {
      externalPaths.push(p);
    }
  }

  if (internalNames.length > 0) {
    const filtered = internalNames.filter(n => n !== folderName);
    if (filtered.length > 0) await deskMoveFiles(filtered, folderName);
  }

  if (externalPaths.length > 0) {
    const subdir = curPath ? curPath + '/' + folderName : folderName;
    await gsapFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upload', dir: basePath || undefined, subdir, paths: externalPaths }),
    });
    loadDeskFiles(curPath || '');
  }
}

// ── 组件 ──

export function DeskFileItem({
  file, selected, onSelect, allSelectedFiles,
  renamingFile, renameValue, onRenameStart, onRenameChange, onRenameCommit, onRenameCancel,
  onShowContextMenu,
}: DeskFileItemProps) {
  const vscodeFileIconThemes = useStore(st => st.vscodeFileIconThemes);
  const icon = file.isDir
    ? (getVsCodeFolderIcon(file.name, vscodeFileIconThemes) || ICONS.folder)
    : (getVsCodeFileIcon(file.name, vscodeFileIconThemes) || getFileIcon(file.name));
  const [dropTarget, setDropTarget] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isRenaming = renamingFile === file.name;

  // Focus and select the file name when entering rename mode.
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      const dotIdx = file.isDir ? -1 : file.name.lastIndexOf('.');
      if (dotIdx > 0) renameInputRef.current.setSelectionRange(0, dotIdx);
      else renameInputRef.current.select();
    }
  }, [isRenaming, file.name, file.isDir]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(file.name, { multi: e.metaKey || e.ctrlKey, shift: e.shiftKey });
  }, [file.name, onSelect]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const filesToDrag = selected ? allSelectedFiles : [file.name];
    setDeskDragNames(filesToDrag);
    const clearDrag = () => { setDeskDragNames(null); };
    e.currentTarget.addEventListener('dragend', clearDrag, { once: true });
    setTimeout(clearDrag, 2000);

    const paths = filesToDrag
      .map(n => deskFullPath(n))
      .filter(Boolean) as string[];
    if (paths.length > 0 && !window.__GSAP_E2E__) {
      window.platform?.startDrag?.(paths.length === 1 ? paths[0] : paths);
    }
  }, [file.name, selected, allSelectedFiles]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const s = useStore.getState();

    if (file.isDir) {
      const sub = s.deskCurrentPath ? s.deskCurrentPath + '/' + file.name : file.name;
      loadDeskFiles(sub);
      return;
    }

    const full = deskFullPath(file.name);
    if (!full) return;
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    openFilePreview(full, file.name, ext, { origin: 'desk' });
  }, [file]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const tFn = window.t ?? ((p: string) => p);
    const s = useStore.getState();
    const bulkNames = allSelectedFiles.length > 1 && allSelectedFiles.includes(file.name)
      ? allSelectedFiles : null;
    const items: ContextMenuItem[] = [];

    if (file.isDir) {
      const sub = s.deskCurrentPath ? s.deskCurrentPath + '/' + file.name : file.name;
      items.push({ label: tFn('desk.ctx.open'), action: () => loadDeskFiles(sub) });
      items.push({ label: tFn('desk.ctx.openInFinder'), action: () => { const p = deskFullPath(file.name); if (p) window.platform?.showInFinder?.(p); } });
    } else {
      items.push({ label: tFn('desk.ctx.open'), action: () => { const p = deskFullPath(file.name); if (p) window.platform?.openFile?.(p); } });
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (DOCUMENT_MINDMAP_EXTS.has(ext)) {
        items.push({ label: tFn('desk.ctx.createMindmapFromDocument'), action: () => deskCreateMindmapFromDocument(file.name) });
      }
    }
    if (!bulkNames) {
      items.push({ label: tFn('desk.ctx.rename'), action: () => onRenameStart(file.name) });
      items.push({ label: tFn('desk.ctx.copyPath'), action: () => { const p = deskFullPath(file.name); if (p) navigator.clipboard.writeText(p).catch(() => {}); /* clipboard may reject without focus or permission */ } });
    }
    items.push({ divider: true });
    const deleteLabel = bulkNames ? tFn('desk.ctx.deleteN', { n: bulkNames.length }) : tFn('desk.ctx.delete');
    items.push({ label: deleteLabel, danger: true, action: async () => {
      const names = bulkNames || [file.name];
      for (const n of names) {
        const fullPath = deskFullPath(n);
        if (fullPath && window.platform?.trashItem) {
          const ok = await window.platform.trashItem(fullPath);
          if (ok) {
            await loadDeskFiles(useStore.getState().deskCurrentPath || '');
            continue;
          }
        }
        await deskRemoveFile(n);
      }
    } });
    onShowContextMenu({ position: { x: e.clientX, y: e.clientY }, items });
  }, [file, allSelectedFiles, onRenameStart, onShowContextMenu]);

 //

  const handleFolderDragOver = useCallback((e: React.DragEvent) => {
    if (!file.isDir) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(true);
  }, [file.isDir]);

  const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
    if (!file.isDir) return;
    const el = e.currentTarget;
    if (!el.contains(e.relatedTarget as Node)) setDropTarget(false);
  }, [file.isDir]);

  const handleFolderDrop = useCallback(async (e: React.DragEvent) => {
    if (!file.isDir) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(false);

    // Prefer module-level drag state over platform-native callbacks.
    if (_deskDragNames && _deskDragNames.length > 0) {
      const names = _deskDragNames.filter(n => n !== file.name);
      setDeskDragNames(null);
      if (names.length > 0) await deskMoveFiles(names, file.name);
      return;
    }

 //
    await handleExternalDropToFolder(e, file.name);
  }, [file.isDir, file.name]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !(e.nativeEvent as KeyboardEvent & { isComposing: boolean }).isComposing) {
      e.preventDefault();
      onRenameCommit();
    }
    if (e.key === 'Escape') {
      onRenameCancel();
    }
  }, [onRenameCommit, onRenameCancel]);

  return (
    <div
      className={[st.item, file.isDir ? st.isDir : '', selected ? st.selected : '', dropTarget ? st.dropTarget : ''].filter(Boolean).join(' ')}
      data-name={file.name}
      data-desk-item=""
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      draggable
      onDragStart={handleDragStart}
      onDragOver={file.isDir ? handleFolderDragOver : undefined}
      onDragLeave={file.isDir ? handleFolderDragLeave : undefined}
      onDrop={file.isDir ? handleFolderDrop : undefined}
    >
      <span className={st.itemIcon} dangerouslySetInnerHTML={{ __html: icon }} />
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className={st.renameInput}
          data-desk-rename-input=""
          type="text"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={onRenameCommit}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className={st.itemName} title={file.name}>{file.name}</span>
      )}
    </div>
  );
}
