import { useStore } from '../stores';
import type { Artifact } from '../types';
import { readFileForPreviewType } from './file-preview';

const refreshGenerations = new Map<string, number>();
const DEFAULT_RETRY_DELAYS_MS = [80, 240, 600] as const;

type PreviewReadResult = NonNullable<Awaited<ReturnType<typeof readFileForPreviewType>>>;

export interface PreviewFileRefreshOptions {
  retryMissing?: boolean;
  retryUnchanged?: boolean;
  retryDelaysMs?: readonly number[];
}

export const PREVIEW_FILE_CHANGE_REFRESH_OPTIONS: PreviewFileRefreshOptions = Object.freeze({
  retryMissing: true,
  retryUnchanged: true,
});

export const PREVIEW_FILE_CATCH_UP_REFRESH_OPTIONS: PreviewFileRefreshOptions = Object.freeze({
  retryMissing: true,
});

function beginRefresh(filePath: string): number {
  const next = (refreshGenerations.get(filePath) ?? 0) + 1;
  refreshGenerations.set(filePath, next);
  return next;
}

function isLatestRefresh(filePath: string, generation: number): boolean {
  return refreshGenerations.get(filePath) === generation;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function fileVersionsEqual(a: Artifact['fileVersion'], b: Artifact['fileVersion']): boolean {
  if (!a || !b) return a === b;
  return a.mtimeMs === b.mtimeMs
    && a.size === b.size
    && a.sha256 === b.sha256;
}

function readMatchesCurrentArtifact(artifact: Artifact, read: PreviewReadResult): boolean {
  if (artifact.fileVersion && read.fileVersion) return fileVersionsEqual(artifact.fileVersion, read.fileVersion);
  const sourceUrl = read.sourceUrl ?? artifact.sourceUrl;
  return read.content === artifact.content && sourceUrl === artifact.sourceUrl;
}

async function readFileForPreviewTypeWithRetry(
  filePath: string,
  artifact: Artifact,
  generation: number,
  options: PreviewFileRefreshOptions,
): Promise<PreviewReadResult | null | undefined> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    const read = await readFileForPreviewType(filePath, artifact.type);
    if (!isLatestRefresh(filePath, generation)) return undefined;

    const canRetry = attempt < retryDelaysMs.length;
    const shouldRetryMissing = !read && options.retryMissing;
    const shouldRetryUnchanged = !!read && options.retryUnchanged && readMatchesCurrentArtifact(artifact, read);
    if (!canRetry || (!shouldRetryMissing && !shouldRetryUnchanged)) return read;

    await delay(retryDelaysMs[attempt] ?? 0);
    if (!isLatestRefresh(filePath, generation)) return undefined;
  }
}

export function __resetPreviewFileRefreshStateForTests(): void {
  refreshGenerations.clear();
}

export async function refreshPreviewItemsFromFile(filePath: string, options: PreviewFileRefreshOptions = {}): Promise<void> {
  const generation = beginRefresh(filePath);
  const state = useStore.getState();
  const targets: Array<{ owner: string; artifact: Artifact }> = [];

  for (const [owner, preview] of Object.entries(state.previewByOwner || {})) {
    for (const artifact of preview.artifacts || []) {
      if (artifact.filePath === filePath) targets.push({ owner, artifact });
    }
  }

  for (const { owner, artifact } of targets) {
    const read = await readFileForPreviewTypeWithRetry(filePath, artifact, generation, options);
    if (!isLatestRefresh(filePath, generation) || read === undefined) return;

    useStore.setState((latestState) => {
      const preview = latestState.previewByOwner?.[owner];
      if (!preview) return {};

      const artifacts = (preview.artifacts || []).map((item) => {
        if (item.id !== artifact.id || item.filePath !== filePath) return item;
        if (!read) {
          return {
            ...item,
            status: 'missing',
            missingAt: Date.now(),
          };
        }
        return {
          ...item,
          content: read.content,
          sourceUrl: read.sourceUrl ?? item.sourceUrl,
          fileVersion: read.fileVersion ?? item.fileVersion,
          status: 'available',
          missingAt: null,
        };
      });

      return {
        previewByOwner: {
          ...latestState.previewByOwner,
          [owner]: {
            ...preview,
            artifacts,
          },
        },
      };
    });
  }
}
