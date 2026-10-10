import { codiaFetch } from '../hooks/use-codia-fetch';
import registry from '../../shared/theme-registry';
import { refreshPreviewItemsFromFile } from './preview-file-refresh';
import {
  normalizeWorkbenchContentRef,
  refreshPreviewItemsFromRemoteWorkbenchTarget,
} from './remote-file-preview';
import type { RemoteWorkbenchContentRef } from '../types';

export type CoverThemeTone = 'light' | 'dark';
export type WorkbenchMarkdownCoverTarget = Pick<RemoteWorkbenchContentRef, 'kind' | 'mountId' | 'rootId' | 'subdir' | 'name'>;
export type MarkdownCoverTargetInput =
  | { filePath: string; target?: undefined }
  | { filePath?: undefined; target: WorkbenchMarkdownCoverTarget };
export type MarkdownCoverImageInput =
  | { imageFilePath: string; image?: undefined }
  | { imageFilePath?: undefined; image: { filename: string; contentBase64: string } };

export function getCoverThemeTone(): CoverThemeTone {
  const theme = document.documentElement.getAttribute('data-theme') || document.documentElement.dataset.theme || '';
  return registry.isPaperTextureBlockedTheme(theme) ? 'dark' : 'light';
}

export async function requestMarkdownCoverGeneration({
  filePath,
  target,
  executorAgentId,
  userGuidance,
}: {
  executorAgentId?: string;
  userGuidance?: string;
} & MarkdownCoverTargetInput): Promise<{ ok: true; activity?: unknown } | { ok: false; error: string }> {
  const res = await codiaFetch('/api/desk/beautify/cover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...coverTargetBody({ filePath, target } as MarkdownCoverTargetInput),
      themeTone: getCoverThemeTone(),
      ...(executorAgentId ? { executorAgentId } : {}),
      ...(userGuidance?.trim() ? { userGuidance: userGuidance.trim() } : {}),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  return { ok: true, activity: data?.activity };
}

export async function applyMarkdownCoverImage({
  filePath,
  target,
  imageFilePath,
  image,
}: MarkdownCoverTargetInput & MarkdownCoverImageInput): Promise<{ ok: true; cover?: unknown } | { ok: false; error: string }> {
  const targetInput = { filePath, target } as MarkdownCoverTargetInput;
  const res = await codiaFetch('/api/desk/beautify/cover/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...coverTargetBody(targetInput),
      ...(imageFilePath ? { imageFilePath } : { image }),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  await refreshAfterCover(targetInput);
  return { ok: true, cover: data?.cover };
}

export async function applyMarkdownCoverPreset({
  filePath,
  target,
  presetId,
}: MarkdownCoverTargetInput & {
  presetId: string;
}): Promise<{ ok: true; cover?: unknown } | { ok: false; error: string }> {
  const targetInput = { filePath, target } as MarkdownCoverTargetInput;
  const res = await codiaFetch('/api/desk/beautify/cover/preset/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...coverTargetBody(targetInput),
      presetId,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  await refreshAfterCover(targetInput);
  return { ok: true, cover: data?.cover };
}

function coverTargetBody(input: MarkdownCoverTargetInput): Record<string, unknown> {
  if ('filePath' in input && input.filePath) return { filePath: input.filePath };
  const target = normalizeWorkbenchContentRef(input.target as RemoteWorkbenchContentRef);
  return {
    target: {
      kind: 'workbench-file',
      mountId: target.mountId || target.rootId || 'default',
      subdir: target.subdir,
      name: target.name,
    },
  };
}

async function refreshAfterCover(input: MarkdownCoverTargetInput): Promise<void> {
  if ('filePath' in input && input.filePath) {
    await refreshPreviewItemsFromFile(input.filePath);
    return;
  }
  await refreshPreviewItemsFromRemoteWorkbenchTarget(input.target as RemoteWorkbenchContentRef);
}

export function dispatchCoverNotice(text: string, type: 'success' | 'error' = 'success'): void {
  window.dispatchEvent(new CustomEvent('codia-inline-notice', {
    detail: { text, type },
  }));
}
