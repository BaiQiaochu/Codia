import type { WorkspaceChangePayload } from '../types';

type WorkspaceChangeHandler = (payload: WorkspaceChangePayload) => void;

const handlers = new Set<WorkspaceChangeHandler>();
let attachedApi: typeof window.platform | null = null;

function isWorkspaceChangePayload(value: unknown): value is WorkspaceChangePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<WorkspaceChangePayload>;
  return typeof payload.rootPath === 'string'
    && typeof payload.changedPath === 'string'
    && typeof payload.affectedDir === 'string'
    && typeof payload.eventType === 'string';
}

function ensureBridgeAttached(): void {
  const api = window.platform;
  if (!api?.onWorkspaceChanged) return;
  if (attachedApi === api) return;
  attachedApi = api;
  api.onWorkspaceChanged((payload: WorkspaceChangePayload) => {
    if (!isWorkspaceChangePayload(payload)) return;
    for (const handler of [...handlers]) handler(payload);
  });
}

export function subscribeWorkspaceChanges(handler: WorkspaceChangeHandler): () => void {
  ensureBridgeAttached();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
