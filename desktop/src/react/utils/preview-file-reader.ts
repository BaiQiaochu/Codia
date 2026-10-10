import type { Artifact } from '../types';

export const PREVIEWABLE_EXTS: Record<string, string> = {
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
  py: 'code', css: 'code', json: 'code', yaml: 'code', yml: 'code',
  xml: 'code', sql: 'code', sh: 'code', bash: 'code',
  txt: 'code', c: 'code', cpp: 'code', h: 'code', java: 'code',
  rs: 'code', go: 'code', rb: 'code', php: 'code',
  csv: 'csv', pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', xls: 'xlsx',
};

export const BINARY_PREVIEW_TYPES = new Set(['pdf']);

export interface PreviewReadResult {
  content: string;
  sourceUrl?: string;
  fileVersion?: Artifact['fileVersion'];
}

export function normalizePreviewExt(ext: string): string {
  return String(ext || '').replace(/^\./, '').toLowerCase();
}

export async function readFileForPreviewType(filePath: string, previewType: string): Promise<PreviewReadResult | null> {
  const platform = window.platform;
  if (!platform) return null;
  if (previewType === 'file-info') return { content: '' };
  if (previewType === 'docx') {
    const content = await platform.readDocxHtml?.(filePath);
    return content == null ? null : { content };
  }
  if (previewType === 'xlsx') {
    const content = await platform.readXlsxHtml?.(filePath);
    return content == null ? null : { content };
  }
  if (BINARY_PREVIEW_TYPES.has(previewType)) {
    const sourceUrl = platform.getFileUrl?.(filePath);
    if (sourceUrl) return { content: '', sourceUrl };
    const content = await platform.readFileBase64?.(filePath);
    return content == null ? null : { content };
  }

  const snapshot = await platform.readFileSnapshot?.(filePath);
  if (snapshot) return { content: snapshot.content, fileVersion: snapshot.version };
  const content = await platform.readFile?.(filePath);
  return content == null ? null : { content };
}

export async function readFileForPreviewWithVersion(filePath: string, ext: string): Promise<PreviewReadResult | null> {
  const previewType = PREVIEWABLE_EXTS[normalizePreviewExt(ext)];
  return previewType ? readFileForPreviewType(filePath, previewType) : null;
}

export async function readFileForPreview(filePath: string, ext: string): Promise<string | null> {
  return (await readFileForPreviewWithVersion(filePath, ext))?.content ?? null;
}
