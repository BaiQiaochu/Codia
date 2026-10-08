type FileChangeHandler = (filePath: string) => void;

const handlers = new Set<FileChangeHandler>();
const WATCH_RETRY_DELAYS_MS = [250, 750, 1500, 3000] as const;

interface WatchedFileEntry {
  filePath: string;
  refCount: number;
  active: boolean;
  attempt: number;
  token: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const watchedFiles = new Map<string, WatchedFileEntry>();
let attachedApi: typeof window.platform | null = null;

function normalizeFilePath(filePath: string): string {
  const slashed = String(filePath || '').trim().replace(/\\/g, '/');
  const normalized = slashed.length > 1 ? slashed.replace(/\/+$/g, '') : slashed;
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function ensureBridgeAttached(): void {
  if (typeof window === 'undefined') return;
  const api = window.platform;
  if (!api?.onFileChanged) return;
  if (attachedApi === api) return;

  attachedApi = api;
  api.onFileChanged((filePath: string) => {
    for (const handler of [...handlers]) {
      handler(filePath);
    }
  });
}

export function subscribeFileChanges(handler: FileChangeHandler): () => void {
  ensureBridgeAttached();
  handlers.add(handler);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    handlers.delete(handler);
  };
}

function retainPlatformWatch(filePath: string, fileKey: string): void {
  const current = watchedFiles.get(fileKey);
  if (current) {
    current.refCount += 1;
    return;
  }
  const entry: WatchedFileEntry = {
    filePath,
    refCount: 1,
    active: false,
    attempt: 0,
    token: 0,
    retryTimer: null,
  };
  watchedFiles.set(fileKey, entry);
  void startPlatformWatch(fileKey, entry);
}

function releasePlatformWatch(fileKey: string): void {
  const current = watchedFiles.get(fileKey);
  if (!current) return;
  if (current.refCount <= 1) {
    watchedFiles.delete(fileKey);
    if (current.retryTimer) clearTimeout(current.retryTimer);
    if (current.active) {
      void window.platform?.unwatchFile?.(current.filePath)?.catch((err: unknown) => {
        console.warn('[file-change-events] unwatch failed:', current.filePath, err);
      });
    }
    return;
  }
  current.refCount -= 1;
}

async function startPlatformWatch(fileKey: string, entry: WatchedFileEntry): Promise<void> {
  const api = window.platform;
  if (!api?.watchFile) return;
  const token = ++entry.token;
  let ok = false;
  try {
    ok = (await api.watchFile(entry.filePath)) !== false;
  } catch (err) {
    console.warn('[file-change-events] watch failed:', entry.filePath, err);
  }

  if (watchedFiles.get(fileKey) !== entry || entry.token !== token) {
    if (ok) {
      void api.unwatchFile?.(entry.filePath)?.catch((err: unknown) => {
        console.warn('[file-change-events] unwatch failed:', entry.filePath, err);
      });
    }
    return;
  }

  if (ok) {
    entry.active = true;
    entry.attempt = 0;
    return;
  }

  schedulePlatformWatchRetry(fileKey, entry);
}

function schedulePlatformWatchRetry(fileKey: string, entry: WatchedFileEntry): void {
  if (watchedFiles.get(fileKey) !== entry) return;
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  const delayMs = WATCH_RETRY_DELAYS_MS[Math.min(entry.attempt, WATCH_RETRY_DELAYS_MS.length - 1)];
  entry.attempt += 1;
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    if (watchedFiles.get(fileKey) !== entry) return;
    void startPlatformWatch(fileKey, entry);
  }, delayMs);
}

export function watchFileChanges(filePath: string, handler: FileChangeHandler): () => void {
  const watchedPath = String(filePath || '').trim();
  const watchedKey = normalizeFilePath(watchedPath);
  if (!watchedPath || !watchedKey) return () => {};

  retainPlatformWatch(watchedPath, watchedKey);
  const unsubscribe = subscribeFileChanges((changedPath) => {
    const changed = normalizeFilePath(changedPath);
    if (changed !== watchedKey) return;
    handler(watchedPath);
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    releasePlatformWatch(watchedKey);
  };
}
