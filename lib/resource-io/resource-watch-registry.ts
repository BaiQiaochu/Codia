import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ResourceEventBus } from "./resource-event-bus.ts";
import { normalizeResourceRef, resourceKeyForRef } from "./resource-refs.ts";
import type { ResourceRef } from "./types.ts";

type WatchHandle = { close: () => void };
type WatchChange = string | { path?: string | null; rescan?: boolean } | null | undefined;
type WatchPath = (targetPath: string, handler: (change?: WatchChange) => void) => WatchHandle;
type WatchResourceSnapshot = {
  resourceKey: string;
  resource: any;
  filePath?: string;
};
type WatchTarget = WatchResourceSnapshot & {
  ref?: ResourceRef;
  filePath: string;
  isDirectory?: boolean;
  toResource?: (changedPath: string) => WatchResourceSnapshot;
};
type ResolveWatchTarget = (resource: unknown) => WatchTarget;
type StatPath = (targetPath: string) => {
  exists: boolean;
  isDirectory: boolean;
  mtimeMs?: number;
  size?: number | null;
};

type Options = {
  emitEvent: (event: object, sessionPath?: string | null) => void;
  debounceMs?: number;
  resolveWatchTarget?: ResolveWatchTarget;
  watchPath?: WatchPath;
  statPath?: StatPath;
};

type Entry = {
  ref: ResourceRef;
  filePath: string;
  resourceKey: string;
  resource: any;
  toResource?: (changedPath: string) => WatchResourceSnapshot;
  isDirectory: boolean;
  refCount: number;
  handle: WatchHandle;
  timer: ReturnType<typeof setTimeout> | null;
  pendingPath: string | null;
  pendingRescan: boolean;
};

type Subscription = {
  subscriptionId: string;
  purpose: string | null;
  sessionPath: string | null;
  resourceKeys: string[];
  releases: Array<() => void>;
};

export class ResourceWatchRegistry {
  declare entries: Map<string, Entry>;
  declare subscriptions: Map<string, Subscription>;
  declare debounceMs: number;
  declare resolveWatchTarget: ResolveWatchTarget;
  declare watchPath: WatchPath;
  declare statPath: StatPath;
  declare eventBus: ResourceEventBus;

  constructor({
    emitEvent,
    debounceMs = 80,
    resolveWatchTarget = defaultResolveWatchTarget,
    watchPath = defaultWatchPath,
    statPath = defaultStatPath,
  }: Options) {
    this.entries = new Map();
    this.subscriptions = new Map();
    this.debounceMs = debounceMs;
    this.resolveWatchTarget = resolveWatchTarget;
    this.watchPath = watchPath;
    this.statPath = statPath;
    this.eventBus = new ResourceEventBus({ emit: emitEvent });
  }

  subscribe(input: { resources?: unknown[]; resource?: unknown; purpose?: string | null; sessionPath?: string | null }) {
    const resources = Array.isArray(input?.resources)
      ? input.resources
      : input?.resource
        ? [input.resource]
        : [];
    if (!resources.length) throw new Error("ResourceWatchRegistry subscription requires resources");

    const releases: Array<() => void> = [];
    const resourceKeys: string[] = [];
    try {
      for (const resource of resources) {
        const normalized = this.normalizeWatchResource(resource);
        releases.push(this.retain(normalized.ref));
        resourceKeys.push(normalized.resourceKey);
      }
    } catch (err) {
      for (const release of releases.splice(0).reverse()) release();
      throw err;
    }

    const subscriptionId = crypto.randomUUID();
    this.subscriptions.set(subscriptionId, {
      subscriptionId,
      purpose: typeof input?.purpose === "string" ? input.purpose : null,
      sessionPath: typeof input?.sessionPath === "string" ? input.sessionPath : null,
      resourceKeys,
      releases,
    });
    return { subscriptionId, resourceKeys };
  }

  unsubscribe(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;
    this.subscriptions.delete(subscriptionId);
    for (const release of subscription.releases.reverse()) release();
    return true;
  }

  diagnostics() {
    return {
      subscriptions: this.subscriptions.size,
      watches: [...this.entries.values()].map((entry) => ({
        resourceKey: entry.resourceKey,
        refCount: entry.refCount,
        filePath: entry.filePath,
      })),
    };
  }

  retain(input: unknown): () => void {
    const { ref, filePath, resourceKey, resource, toResource, isDirectory } = this.normalizeWatchResource(input);
    const existing = this.entries.get(resourceKey);
    if (existing) {
      existing.refCount += 1;
      return () => this.release(resourceKey);
    }

    const entry: Entry = {
      ref,
      filePath,
      resourceKey,
      resource,
      toResource,
      isDirectory,
      refCount: 1,
      handle: this.watchPath(filePath, (changedPath) => this.schedule(entry, changedPath)),
      timer: null,
      pendingPath: null,
      pendingRescan: false,
    };
    this.entries.set(resourceKey, entry);
    return () => this.release(resourceKey);
  }

  normalizeWatchResource(input: unknown) {
    const target = this.resolveWatchTarget(input);
    if (!target?.filePath || !target?.resourceKey || !target?.resource) {
      throw new Error("ResourceWatchRegistry resolver returned an invalid watch target");
    }
    const filePath = normalizeWatchPath(target.filePath);
    return {
      ref: (target.ref || normalizeResourceRef(input)) as ResourceRef,
      filePath,
      resourceKey: target.resourceKey,
      resource: target.resource,
      toResource: target.toResource,
      isDirectory: target.isDirectory === true,
    };
  }

  release(resourceKey: string): void {
    const entry = this.entries.get(resourceKey);
    if (!entry) return;
    if (entry.refCount > 1) {
      entry.refCount -= 1;
      return;
    }
    this.entries.delete(resourceKey);
    if (entry.timer) clearTimeout(entry.timer);
    entry.handle.close();
  }

  schedule(entry: Entry, change?: WatchChange): void {
    if (!this.entries.has(entry.resourceKey)) return;
    const normalizedChange = normalizeWatchChange(entry, change);
    if (normalizedChange.path) entry.pendingPath = normalizedChange.path;
    if (normalizedChange.rescan) entry.pendingRescan = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.emitSnapshot(entry);
    }, this.debounceMs);
  }

  emitSnapshot(entry: Entry): void {
    if (!this.entries.has(entry.resourceKey)) return;
    const rescan = entry.pendingRescan;
    const eventPath = rescan
      ? entry.filePath
      : normalizeChangedPath(entry.filePath, entry.pendingPath, entry.isDirectory);
    entry.pendingPath = null;
    entry.pendingRescan = false;
    const stat = this.statPath(eventPath);
    const snapshot = entry.toResource?.(eventPath) || localWatchSnapshot(eventPath);
    const { resourceKey, resource } = snapshot;
    const resourceWithKind = {
      ...resource,
      isDirectory: stat.exists ? stat.isDirectory : resource?.isDirectory,
    };
    if (!stat.exists) {
      this.eventBus.deleted({
        resourceKey,
        resource: resourceWithKind,
        source: "provider_watch",
        sessionPath: null,
      });
      return;
    }
    this.eventBus.changed({
      changeType: "modified",
      resourceKey,
      resource: resourceWithKind,
      version: {
        mtimeMs: stat.mtimeMs,
        size: stat.isDirectory ? null : stat.size ?? null,
      },
      source: "provider_watch",
      sessionPath: null,
    });
  }
}

function normalizeWatchChange(entry: Entry, change?: WatchChange): { path: string | null; rescan: boolean } {
  if (!change) return { path: null, rescan: entry.isDirectory };
  if (typeof change === "object") {
    const pathValue = typeof change.path === "string" && change.path ? change.path : null;
    return {
      path: pathValue,
      rescan: change.rescan === true || (!pathValue && entry.isDirectory),
    };
  }
  const pathValue = String(change || "");
  if (entry.isDirectory && isDirectorySelfEcho(entry.filePath, pathValue)) {
    return { path: entry.filePath, rescan: true };
  }
  return { path: pathValue || null, rescan: false };
}

function defaultResolveWatchTarget(input: unknown): WatchTarget {
  const ref = normalizeResourceRef(input);
  if (ref.kind !== "local-file") {
    throw new Error(`ResourceWatchRegistry cannot resolve provider watch target for ${ref.kind}`);
  }
  const filePath = normalizeWatchPath(ref.path);
  const snapshot = localWatchSnapshot(filePath);
  return {
    ref: { kind: "local-file", path: filePath },
    filePath,
    isDirectory: safeIsDirectory(filePath),
    ...snapshot,
    toResource: localWatchSnapshot,
  };
}

function normalizeChangedPath(rootPath: string, changedPath?: string | null, rootIsDirectory = false): string {
  if (!changedPath) return rootPath;
  const value = String(changedPath);
  if (path.isAbsolute(value)) return normalizeWatchPath(value);
  return rootIsDirectory ? path.join(rootPath, value) : rootPath;
}

function localWatchSnapshot(filePath: string): WatchResourceSnapshot {
  const normalizedPath = normalizeWatchPath(filePath);
  return {
    resourceKey: resourceKeyForRef({ kind: "local-file", path: normalizedPath }),
    resource: {
      kind: "local-file" as const,
      provider: "local_fs",
      path: normalizedPath,
      filePath: normalizedPath,
      isDirectory: safeIsDirectory(normalizedPath),
    },
    filePath: normalizedPath,
  };
}

function defaultWatchPath(targetPath: string, handler: (change?: WatchChange) => void): WatchHandle {
  const rootPath = path.normalize(targetPath);
  const rootIsDirectory = safeIsDirectory(rootPath);
  const watcher = fs.watch(rootPath, { persistent: false }, (_eventType, filename) => {
    let changedPath = rootPath;
    if (rootIsDirectory && !filename) {
      handler({ path: rootPath, rescan: true });
      return;
    }
    if (rootIsDirectory && filename) {
      const value = String(filename);
      if (isDirectorySelfEcho(rootPath, value)) {
        handler({ path: rootPath, rescan: true });
        return;
      }
      changedPath = path.isAbsolute(value) ? normalizeWatchPath(value) : path.join(rootPath, value);
    }
    handler(changedPath);
  });
  return { close: () => watcher.close() };
}

function normalizeWatchPath(value: string): string {
  return path.resolve(value);
}

function safeIsDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isDirectorySelfEcho(rootPath: string, changedPath: string): boolean {
  const value = String(changedPath || "");
  if (!value) return true;
  const normalizedRoot = normalizeWatchPath(rootPath);
  const normalizedChanged = path.isAbsolute(value)
    ? normalizeWatchPath(value)
    : normalizeWatchPath(path.join(normalizedRoot, value));
  if (normalizedChanged === normalizedRoot) return true;
  return !path.isAbsolute(value) && path.basename(normalizedRoot) === path.normalize(value);
}

function defaultStatPath(targetPath: string) {
  try {
    const stat = fs.statSync(targetPath);
    return {
      exists: true,
      isDirectory: stat.isDirectory(),
      mtimeMs: stat.mtimeMs,
      size: stat.isDirectory() ? null : stat.size,
    };
  } catch (err) {
    if ((err as any)?.code === "ENOENT") {
      return { exists: false, isDirectory: false, size: null };
    }
    throw err;
  }
}
