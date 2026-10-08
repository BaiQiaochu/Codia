import type { AttachedFile } from '../stores/input-slice';
import type { Agent, DeskFile, DeskSearchResult } from '../types';
import type { FileRef } from '../types/file-ref';
import type { EditorFileRef } from './editor-serializer';

export type FileMentionSource = 'assistant' | 'attached' | 'session' | 'workspace';
export type FileMentionKind = 'assistant' | 'image' | 'file';

export interface FileMentionItem {
  id: string;
  source: FileMentionSource;
  kind: FileMentionKind;
  agentId?: string;
  fileId?: string;
  path: string;
  name: string;
  isDirectory?: boolean;
  mimeType?: string;
  detail: string;
}

interface BuildFileMentionItemsParams {
  query: string;
  agents?: readonly Agent[];
  attachedFiles: readonly AttachedFile[];
  sessionFiles: readonly FileRef[];
  deskFiles: readonly DeskFile[];
  deskBasePath: string;
  deskCurrentPath: string;
  searchResults: readonly DeskSearchResult[];
  limit?: number;
}

function isImageMention(name: string, mimeType?: string): boolean {
  if (mimeType?.toLowerCase().startsWith('image/')) return true;
  return /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|webp)$/i.test(name);
}

function joinWorkspacePath(base: string, subdir: string, name: string): string {
  const joined = [base, subdir, name].filter(Boolean).join('/');
  return joined.startsWith('//')
    ? '//' + joined.slice(2).replace(/\/+/g, '/')
    : joined.replace(/\/+/g, '/');
}

function dedupeKey(fileId: string | undefined, path: string): string {
  return fileId ? `id:${fileId}` : `path:${path}`;
}

function referenceKeys(fileId: string | undefined, path: string): string[] {
  const normalizedPath = path.replace(/\\/g, '/');
  const comparablePath = /^(?:[a-z]:\/|\/\/)/i.test(normalizedPath)
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  return [fileId ? `id:${fileId}` : '', comparablePath ? `path:${comparablePath}` : ''].filter(Boolean);
}

function matchesQuery(query: string, name: string, path: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return name.toLowerCase().includes(needle) || path.toLowerCase().includes(needle);
}

function pushUnique(items: FileMentionItem[], seen: Set<string>, item: FileMentionItem): void {
  const keys = referenceKeys(item.fileId, item.path);
  if (keys.some(key => seen.has(key))) return;
  for (const key of keys) seen.add(key);
  items.push(item);
}

export function buildFileMentionItems({
  query,
  agents = [],
  attachedFiles,
  sessionFiles,
  deskFiles,
  deskBasePath,
  deskCurrentPath,
  searchResults,
  limit = 20,
}: BuildFileMentionItemsParams): FileMentionItem[] {
  const items: FileMentionItem[] = [];
  const seen = new Set<string>();

  for (const agent of agents) {
    const agentPath = `agent:${agent.id}`;
    if (!matchesQuery(query, agent.name, agent.id)) continue;
    pushUnique(items, seen, {
      id: `assistant:${agent.id}`,
      source: 'assistant',
      kind: 'assistant',
      agentId: agent.id,
      path: agentPath,
      name: agent.name,
      detail: agent.isPrimary ? '默认助手' : '助手',
    });
  }

  for (const file of attachedFiles) {
    if (!matchesQuery(query, file.name, file.path)) continue;
    pushUnique(items, seen, {
      id: `attached:${dedupeKey(file.fileId, file.path)}`,
      source: 'attached',
      kind: !file.isDirectory && isImageMention(file.name, file.mimeType) ? 'image' : 'file',
      fileId: file.fileId,
      path: file.path,
      name: file.name,
      isDirectory: file.isDirectory,
      mimeType: file.mimeType,
      detail: file.path,
    });
  }

  for (const file of sessionFiles) {
    if (!file.path || file.status === 'expired') continue;
    if (!matchesQuery(query, file.name, file.path)) continue;
    pushUnique(items, seen, {
      id: `session:${file.id}`,
      source: 'session',
      kind: isImageMention(file.name, file.mime) ? 'image' : 'file',
      fileId: file.fileId,
      path: file.path,
      name: file.name,
      isDirectory: false,
      mimeType: file.mime,
      detail: file.path,
    });
  }

  const workspaceItems = query.trim()
    ? searchResults.map((file) => ({
      name: file.name,
      path: joinWorkspacePath(deskBasePath, '', file.relativePath),
      isDirectory: file.isDir,
      detail: file.parentSubdir || '/',
    }))
    : deskFiles.map((file) => ({
      name: file.name,
      path: joinWorkspacePath(deskBasePath, deskCurrentPath, file.name),
      isDirectory: file.isDir,
      detail: deskCurrentPath || '/',
    }));

  for (const file of workspaceItems) {
    if (!file.path || !matchesQuery(query, file.name, file.path)) continue;
    pushUnique(items, seen, {
      id: `workspace:${file.path}`,
      source: 'workspace',
      kind: !file.isDirectory && isImageMention(file.name) ? 'image' : 'file',
      path: file.path,
      name: file.name,
      isDirectory: file.isDirectory,
      detail: file.detail,
    });
  }

  const assistants = items.filter(item => item.kind === 'assistant');
  const images = items.filter(item => item.kind === 'image');
  const files = items.filter(item => item.kind === 'file');
  return [...assistants, ...images, ...files].slice(0, limit);
}

export function mergeEditorFileRefs(
  attachedFiles: readonly AttachedFile[],
  fileRefs: readonly EditorFileRef[],
): AttachedFile[] {
  const merged: AttachedFile[] = [];
  const seen = new Set<string>();

  for (const file of [...attachedFiles, ...fileRefs]) {
    if (!file.path && !file.fileId) continue;
    const keys = referenceKeys(file.fileId, file.path);
    if (keys.some(key => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    merged.push({
      ...(file.fileId ? { fileId: file.fileId } : {}),
      path: file.path,
      name: file.name || file.path,
      ...(file.isDirectory ? { isDirectory: true } : {}),
      ...(file.base64Data ? { base64Data: file.base64Data } : {}),
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      ...(file.presentation ? { presentation: file.presentation } : {}),
      ...(file.listed !== undefined ? { listed: file.listed } : {}),
      ...(file.waveform ? { waveform: file.waveform } : {}),
      ...(file.transcription ? { transcription: file.transcription } : {}),
      ...(file.resource ? { resource: file.resource } : {}),
    });
  }

  return merged;
}
