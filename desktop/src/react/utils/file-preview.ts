import type { Artifact } from '../types';
import { openPreview } from '../stores/preview-actions';
import { inferKindByExt, isMediaKind } from './file-kind';
import { openMediaViewerFromContext } from './open-media-viewer';
import { openSvgDiagramPreviewForRef } from './svg-diagram-preview';
import { showError } from './ui-helpers';

export const PREVIEWABLE_EXTS: Record<string, string> = {
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
  py: 'code', css: 'code', json: 'code', yaml: 'code', yml: 'code',
  xml: 'code', sql: 'code', sh: 'code', bash: 'code',
  txt: 'code',
  c: 'code', cpp: 'code', h: 'code', java: 'code',
  rs: 'code', go: 'code', rb: 'code', php: 'code',
  csv: 'csv', pdf: 'pdf',
  docx: 'docx', xlsx: 'xlsx', xls: 'xlsx',
};

export const BINARY_PREVIEW_TYPES = new Set(['pdf']);
export const DESIGN_DOCUMENT_EXTS = new Set(['dwg', 'dwt', 'dxf', 'max', '3ds', 'fbx', 'obj', 'stl', 'xmind']);

interface PreviewReadResult {
  content: string;
  sourceUrl?: string;
  fileVersion?: Artifact['fileVersion'];
}

interface SkillPreviewSource {
  skillName?: unknown;
  baseDir?: unknown;
  filePath?: unknown;
  installed?: unknown;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function inferSkillBaseDir(filePath: string): string {
  const normalized = filePath.trim().replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (lastSeparator < 0) return '';

  const fileName = normalized.slice(lastSeparator + 1).toLowerCase();
  if (fileName !== 'skill.md') return '';

  return lastSeparator === 0 ? normalized.slice(0, 1) : normalized.slice(0, lastSeparator);
}

export async function readFileForPreviewType(filePath: string, previewType: string): Promise<PreviewReadResult | null> {
  const p = window.platform;
  if (!p) return null;
  if (previewType === 'file-info') return { content: '' };
  if (previewType === 'docx') {
    const content = await p.readDocxHtml?.(filePath);
    return content == null ? null : { content };
  }
  if (previewType === 'xlsx') {
    const content = await p.readXlsxHtml?.(filePath);
    return content == null ? null : { content };
  }
  if (BINARY_PREVIEW_TYPES.has(previewType)) {
    const sourceUrl = p.getFileUrl?.(filePath);
    if (sourceUrl) return { content: '', sourceUrl };
    const content = await p.readFileBase64?.(filePath);
    return content == null ? null : { content };
  }

  const snapshot = await p.readFileSnapshot?.(filePath);
  if (snapshot) return { content: snapshot.content, fileVersion: snapshot.version };

  const content = await p.readFile?.(filePath);
  return content == null ? null : { content };
}

export async function readFileForPreviewWithVersion(filePath: string, ext: string): Promise<PreviewReadResult | null> {
  const normalizedExt = normalizePreviewExt(ext);
  const previewType = PREVIEWABLE_EXTS[normalizedExt];
  if (!previewType) return null;
  return readFileForPreviewType(filePath, previewType);
}

export async function readFileForPreview(filePath: string, ext: string): Promise<string | null> {
  return (await readFileForPreviewWithVersion(filePath, ext))?.content ?? null;
}

export async function openFilePreview(
  filePath: string,
  label: string,
  ext: string,
  context?: {
    origin?: 'desk' | 'session';
    sessionPath?: string;
    messageId?: string;
    fileId?: string;
    blockIdx?: number;
    sourceRootPath?: string;
  },
): Promise<void> {
  const fileName = label || filePath.split('/').pop() || filePath;
  const normalizedExt = normalizePreviewExt(ext);

  try {
    if (normalizedExt === 'skill') {
      const name = fileName.replace(/\.skill$/, '');
      const content = await window.platform?.readFile?.(filePath);
      if (content != null) {
        const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
        const artifact: Artifact = {
          id: `skill-${name}`,
          type: 'markdown',
          title: name,
          content: body,
        };
        openPreview(artifact);
        return;
      }
      window.platform?.openSkillViewer?.({ skillPath: filePath });
      return;
    }

    const mediaKind = inferKindByExt(normalizedExt);
    if (mediaKind === 'svg') {
      openSvgDiagramPreviewForRef({
        id: `file-${filePath}`,
        kind: 'svg',
        source: context?.origin === 'session' ? 'session-attachment' : 'desk',
        name: fileName,
        path: filePath,
        fileId: context?.fileId,
        ext: normalizedExt,
        sessionMessageId: context?.messageId,
      });
      return;
    }

    if (isMediaKind(mediaKind)) {
      openMediaViewerFromContext({
        ext: normalizedExt,
        filePath,
        label: fileName,
        kind: mediaKind,
        origin: context?.origin,
        sessionPath: context?.sessionPath,
        messageId: context?.messageId,
        fileId: context?.fileId,
        blockIdx: context?.blockIdx,
      });
      return;
    }

    if (DESIGN_DOCUMENT_EXTS.has(normalizedExt)) {
      const preview = await window.platform?.readDesignDocumentPreview?.(filePath);
      if (preview) {
        openPreview({
          id: `file-${filePath}`,
          type: 'design-document',
          title: fileName,
          content: JSON.stringify(preview),
          filePath,
          ext: normalizedExt,
        });
        return;
      }
    }

    const canPreview = normalizedExt in PREVIEWABLE_EXTS;
    if (canPreview) {
      const readResult = await readFileForPreviewWithVersion(filePath, normalizedExt);
      if (readResult != null) {
        const previewType = PREVIEWABLE_EXTS[normalizedExt];
        const artifact: Artifact = {
          id: `file-${filePath}`,
          type: previewType,
          title: fileName,
          content: readResult.content,
          sourceUrl: readResult.sourceUrl,
          sourceRootPath: context?.sourceRootPath,
          filePath,
          ext: normalizedExt,
          fileVersion: readResult.fileVersion,
          language: previewType === 'code' ? normalizedExt : undefined,
        };
        openPreview(artifact);
        return;
      }
    }

    openPreview({
      id: `file-${filePath}`,
      type: 'file-info',
      title: fileName,
      content: '',
      filePath,
      ext: normalizedExt,
    });
  } catch (err) {
    console.error('[file-preview] open preview failed:', err);
    showError(getErrorMessage(err));
  }
}

export function normalizePreviewExt(ext: string): string {
  return String(ext || '').replace(/^\./, '').toLowerCase();
}

export async function openSkillPreview(
  skillName: string,
  skillFilePath: string,
  source?: SkillPreviewSource | null,
): Promise<void> {
  try {
    const sourceFilePath = nonEmptyString(source?.filePath);
    const filePath = sourceFilePath || nonEmptyString(skillFilePath);
    const baseDir = nonEmptyString(source?.baseDir) || inferSkillBaseDir(filePath);

    if (!baseDir) {
      showError('skill preview path missing');
      return;
    }

    if (!window.platform?.openSkillViewer) {
      showError('skill viewer unavailable');
      return;
    }

    window.platform.openSkillViewer({
      name: nonEmptyString(source?.skillName) || nonEmptyString(skillName) || 'Skill',
      baseDir,
      filePath: filePath || undefined,
      installed: typeof source?.installed === 'boolean' ? source.installed : true,
    });
  } catch (err) {
    console.error('[file-preview] open skill preview failed:', err);
    showError(getErrorMessage(err));
  }
}
