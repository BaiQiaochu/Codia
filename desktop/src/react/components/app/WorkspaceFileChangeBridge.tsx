import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../stores';
import { resourceWatchKey, retainResourceWatch, type ResourceRef } from '../../services/resource-events';

function normalizeSubdir(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function joinWorkspaceRoot(basePath: string, subdir: string): string {
  const normalizedSubdir = normalizeSubdir(subdir);
  if (!normalizedSubdir) return basePath;
  const separator = /^[A-Za-z]:\\/.test(basePath) || (basePath.includes('\\') && !basePath.includes('/')) ? '\\' : '/';
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${normalizedSubdir.replace(/\//g, separator)}`;
}

function workspaceWatchRefs(basePath: string, mountId: string, expandedPaths: string[]): ResourceRef[] {
  const refs = new Map<string, ResourceRef>();
  const add = (ref: ResourceRef) => refs.set(resourceWatchKey(ref), ref);
  const expanded = Array.isArray(expandedPaths) ? expandedPaths : [];

  if (mountId) {
    add({ kind: 'mount', mountId, path: '' });
    for (const subdir of expanded) {
      const normalized = normalizeSubdir(subdir);
      if (normalized) add({ kind: 'mount', mountId, path: normalized });
    }
    return [...refs.values()];
  }

  if (!basePath) return [];
  add({ kind: 'local-file', path: basePath });
  for (const subdir of expanded) {
    const normalized = normalizeSubdir(subdir);
    if (normalized) add({ kind: 'local-file', path: joinWorkspaceRoot(basePath, normalized) });
  }
  return [...refs.values()];
}

export function WorkspaceFileChangeBridge() {
  const deskBasePath = useStore(st => st.deskBasePath);
  const deskWorkspaceMountId = useStore(st => st.deskWorkspaceMountId);
  const deskExpandedPaths = useStore(st => st.deskExpandedPaths);
  const resourceServerReady = useStore(st => Boolean(st.activeServerConnection || st.serverPort));
  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());
  const watchedRefs = useMemo(
    () => resourceServerReady
      ? workspaceWatchRefs(deskWorkspaceMountId ? '' : deskBasePath, deskWorkspaceMountId || '', deskExpandedPaths)
      : [],
    [deskBasePath, deskExpandedPaths, deskWorkspaceMountId, resourceServerReady],
  );
  const watchedRefsKey = watchedRefs.map(resourceWatchKey).join('\n');

  useEffect(() => {
    const nextKeys = new Set(watchedRefs.map(resourceWatchKey));
    for (const [key, unsubscribe] of subscriptionsRef.current) {
      if (nextKeys.has(key)) continue;
      unsubscribe();
      subscriptionsRef.current.delete(key);
    }
    for (const ref of watchedRefs) {
      const key = resourceWatchKey(ref);
      if (subscriptionsRef.current.has(key)) continue;
      subscriptionsRef.current.set(key, retainResourceWatch(ref));
    }
  }, [watchedRefsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- watchedRefsKey is the reconciled subscription identity.

  useEffect(() => () => {
    for (const unsubscribe of subscriptionsRef.current.values()) unsubscribe();
    subscriptionsRef.current.clear();
  }, []);

  return null;
}

export const WorkspaceFileWatchBridge = WorkspaceFileChangeBridge;
