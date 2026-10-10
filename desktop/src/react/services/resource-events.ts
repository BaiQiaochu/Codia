import { codiaFetch } from '../hooks/use-codia-fetch';

export type ResourceRef =
  | { kind: 'local-file'; path: string }
  | { kind: 'mount'; mountId: string; path: string };

type WatchEntry = {
  ref: ResourceRef;
  refCount: number;
  subscriptionId: string | null;
  disposed: boolean;
  released: boolean;
  ready: Promise<void>;
};

const watches = new Map<string, WatchEntry>();
let lastResourceEventSequence = 0;

type ResourceCatchUpResult = {
  stale?: boolean;
  latestSequence?: number;
  events?: unknown[];
};

function normalizeResourceRef(ref: ResourceRef): ResourceRef {
  if (ref.kind === 'local-file') {
    return { kind: 'local-file', path: ref.path };
  }
  return {
    kind: 'mount',
    mountId: ref.mountId,
    path: String(ref.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
  };
}

export function resourceWatchKey(ref: ResourceRef): string {
  const normalized = normalizeResourceRef(ref);
  if (normalized.kind === 'local-file') {
    const slashed = normalized.path.replace(/\\/g, '/').replace(/\/+$/g, '');
    return `local-file:${/^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed}`;
  }
  return `mount:${normalized.mountId}:${normalized.path}`;
}

export function retainResourceWatch(ref: ResourceRef): () => void {
  const normalizedRef = normalizeResourceRef(ref);
  const key = resourceWatchKey(normalizedRef);
  const existing = watches.get(key);
  if (existing) {
    existing.refCount += 1;
    return () => releaseResourceWatch(key);
  }

  const entry: WatchEntry = {
    ref: normalizedRef,
    refCount: 1,
    subscriptionId: null,
    disposed: false,
    released: false,
    ready: Promise.resolve(),
  };
  entry.ready = subscribeEntry(entry)
    .catch((err) => {
      if (!entry.disposed) console.warn('[resource-events] watch failed:', err);
    });
  watches.set(key, entry);
  return () => releaseResourceWatch(key);
}

function subscribeEntry(entry: WatchEntry): Promise<void> {
  entry.released = false;
  return codiaFetch('/api/resource-io/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'resource-watch', resources: [entry.ref] }),
  })
    .then(res => res.json())
    .then((data) => {
      if (typeof data?.subscriptionId === 'string') entry.subscriptionId = data.subscriptionId;
      else console.warn('[resource-events] watch failed:', data?.error || entry.ref);
      if (entry.disposed) releaseEntry(entry);
    });
}

export function retainLocalFileResourceWatch(filePath: string): () => void {
  return retainResourceWatch({ kind: 'local-file', path: filePath });
}

function releaseResourceWatch(key: string): void {
  const entry = watches.get(key);
  if (!entry) return;
  if (entry.refCount > 1) {
    entry.refCount -= 1;
    return;
  }
  watches.delete(key);
  entry.disposed = true;
  void entry.ready.then(() => releaseEntry(entry));
}

function releaseEntry(entry: WatchEntry): void {
  if (entry.released || !entry.subscriptionId) return;
  const subscriptionId = entry.subscriptionId;
  entry.subscriptionId = null;
  entry.released = true;
  void codiaFetch(`/api/resource-io/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
  }).catch((err) => {
    console.warn('[resource-events] unwatch failed:', err);
  });
}

export function recordResourceEventCursor(message: unknown): void {
  if (!isResourceEvent(message)) return;
  const sequence = Number((message as { sequence?: unknown }).sequence);
  if (Number.isFinite(sequence) && sequence > lastResourceEventSequence) {
    lastResourceEventSequence = Math.floor(sequence);
  }
}

export async function catchUpResourceEventsAfterReconnect(
  onEvent?: (event: unknown) => void,
): Promise<ResourceCatchUpResult | null> {
  const since = lastResourceEventSequence;
  let result: ResourceCatchUpResult | null = null;
  try {
    const response = await codiaFetch(`/api/resource-io/events?since=${encodeURIComponent(String(since))}`);
    result = await response.json();
  } catch (err) {
    console.warn('[resource-events] catch-up failed:', err);
    return null;
  }

  if (Number.isFinite(Number(result?.latestSequence))) {
    lastResourceEventSequence = Math.max(lastResourceEventSequence, Math.floor(Number(result?.latestSequence)));
  }

  if (result?.stale) {
    await resubscribeActiveWatches();
    return result;
  }

  for (const event of Array.isArray(result?.events) ? result.events : []) {
    recordResourceEventCursor(event);
    onEvent?.(event);
  }
  return result;
}

export function bindResourceEventForegroundCatchUp(
  onEvent?: (event: unknown) => void,
  options: {
    windowObj?: Window;
    documentObj?: Document;
    catchUp?: typeof catchUpResourceEventsAfterReconnect;
    minIntervalMs?: number;
    now?: () => number;
  } = {},
): () => void {
  const windowObj = options.windowObj || (typeof window !== 'undefined' ? window : undefined);
  const documentObj = options.documentObj || (typeof document !== 'undefined' ? document : undefined);
  if (!windowObj || !documentObj) return () => undefined;

  const catchUp = options.catchUp || catchUpResourceEventsAfterReconnect;
  const minIntervalMs = options.minIntervalMs ?? 1500;
  const now = options.now || (() => Date.now());
  let lastRunAt = 0;
  let running = false;

  const run = () => {
    if (documentObj.visibilityState !== 'visible') return;
    const current = now();
    if (running || current - lastRunAt < minIntervalMs) return;
    running = true;
    lastRunAt = current;
    void catchUp(onEvent).finally(() => {
      running = false;
    });
  };

  windowObj.addEventListener('focus', run);
  documentObj.addEventListener('visibilitychange', run);
  return () => {
    windowObj.removeEventListener('focus', run);
    documentObj.removeEventListener('visibilitychange', run);
  };
}

async function resubscribeActiveWatches(): Promise<void> {
  const entries = Array.from(watches.values()).filter(entry => !entry.disposed);
  for (const entry of entries) {
    releaseEntry(entry);
    entry.ready = subscribeEntry(entry).catch((err) => {
      if (!entry.disposed) console.warn('[resource-events] watch resubscribe failed:', err);
    });
    await entry.ready.catch(() => undefined);
  }
}

function isResourceEvent(message: unknown): boolean {
  const type = (message as { type?: unknown } | null)?.type;
  return type === 'resource.changed' || type === 'resource.deleted' || type === 'resource.renamed';
}
