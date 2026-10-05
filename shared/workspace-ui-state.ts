import { normalizeWorkspacePath } from "./workspace-history.ts";
import { normalizePreviewReadingPosition } from "./preview-reading-position.ts";

const MAX_WORKSPACES = 50;
const MAX_PATHS = 256;
const MAX_TABS = 32;
const MAX_STRING = 1024;
const WORKSPACE_UI_STATE_VERSION = 2;

export const WORKSPACE_UI_SURFACES = Object.freeze(["electron", "pwa"]);
export const DEFAULT_WORKSPACE_UI_SURFACE = "electron";

const WORKSPACE_UI_SURFACE_SET = new Set(WORKSPACE_UI_SURFACES);

type UnknownRecord = Record<string, any>;
type WorkspaceUiOptions = {
  now?: () => number;
  surface?: unknown;
  [key: string]: unknown;
};
type WorkspaceUiRecord = {
  updatedAt: number;
  surfaces: UnknownRecord;
};

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? value as UnknownRecord : {};
}

function cleanString(value: unknown, max = MAX_STRING): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeRelativePath(value: unknown): string {
  const raw = cleanString(value);
  if (!raw) return "";
  const slashed = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!slashed || slashed === "." || slashed === "..") return "";
  const parts = slashed.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) return "";
  return parts.join("/");
}

function normalizePreviewSourceRootPath(value: unknown): string {
  const root = normalizeWorkspacePath(value) || "";
  if (!root) return "";
  if (root.startsWith("/") || root.startsWith("//") || /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("studio:")) {
    return root;
  }
  return "";
}

function uniqueRelativePaths(values: unknown, limit = MAX_PATHS): string[] {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeRelativePath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizePreviewTab(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as UnknownRecord;
  const id = cleanString(source.id);
  if (!id) return null;
  const filePath = normalizeWorkspacePath(source.filePath) || "";
  const relativePath = normalizeRelativePath(source.relativePath);
  const sourceRootPath = normalizePreviewSourceRootPath(source.sourceRootPath);
  const readingPosition = normalizePreviewReadingPosition(source.readingPosition);
  if (!filePath && !relativePath) return null;
  return {
    id,
    ...(filePath ? { filePath } : {}),
    ...(relativePath ? { relativePath } : {}),
    title: cleanString(source.title, 256),
    type: cleanString(source.type, 64) || "file-info",
    ext: cleanString(source.ext, 32).toLowerCase(),
    language: cleanString(source.language, 64) || null,
    ...(sourceRootPath ? { sourceRootPath } : {}),
    ...(readingPosition ? { readingPosition } : {}),
  };
}

export function normalizeWorkspaceUiSurface(value: unknown, fallback = DEFAULT_WORKSPACE_UI_SURFACE): string | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return fallback;
  return WORKSPACE_UI_SURFACE_SET.has(raw) ? raw : null;
}

function normalizeRightWorkspaceTab(value: unknown): string {
  const raw = cleanString(value, 128);
  if (raw === "session-files" || raw === "workspace") return raw;
  if (raw.startsWith("plugin-widget:")) return raw;
  return "workspace";
}

export function normalizeWorkspaceUiEntry(raw: unknown = {}, { now = () => Date.now() }: WorkspaceUiOptions = {}) {
  const source = asRecord(raw);
  const previewTabs = [];
  const seenTabs = new Set();
  for (const item of Array.isArray(source.previewTabs) ? source.previewTabs : []) {
    const tab = normalizePreviewTab(item);
    if (!tab || seenTabs.has(tab.id)) continue;
    seenTabs.add(tab.id);
    previewTabs.push(tab);
    if (previewTabs.length >= MAX_TABS) break;
  }

  const tabIds = new Set(previewTabs.map(tab => tab.id));
  const openTabs = [];
  for (const rawId of Array.isArray(source.openTabs) ? source.openTabs : []) {
    const id = cleanString(rawId);
    if (!id || !tabIds.has(id) || openTabs.includes(id)) continue;
    openTabs.push(id);
    if (openTabs.length >= MAX_TABS) break;
  }
  if (openTabs.length === 0 && previewTabs.length > 0) openTabs.push(previewTabs[0].id);

  const requestedActive = cleanString(source.activeTabId);
  const activeTabId = openTabs.includes(requestedActive) ? requestedActive : (openTabs[0] || null);

  return {
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : now(),
    deskCurrentPath: normalizeRelativePath(source.deskCurrentPath),
    deskExpandedPaths: uniqueRelativePaths(source.deskExpandedPaths),
    deskSelectedPath: normalizeRelativePath(source.deskSelectedPath),
    rightWorkspaceTab: normalizeRightWorkspaceTab(source.rightWorkspaceTab),
    jianView: cleanString(source.jianView, 128) || "desk",
    jianDrawerOpen: source.jianDrawerOpen === true,
    previewOpen: source.previewOpen === true,
    openTabs,
    activeTabId,
    previewTabs,
  };
}

function normalizeWorkspaceUiRecord(rawEntry: unknown = {}, opts: WorkspaceUiOptions = {}): WorkspaceUiRecord {
  const source = asRecord(rawEntry);
  const surfaces: UnknownRecord = {};

  if (source.surfaces && typeof source.surfaces === "object") {
    for (const surface of WORKSPACE_UI_SURFACES) {
      if (!source.surfaces[surface]) continue;
      surfaces[surface] = normalizeWorkspaceUiEntry(source.surfaces[surface], opts);
    }
  } else {
    const entry = normalizeWorkspaceUiEntry(source, opts);
    const hasLegacyState = entry.deskCurrentPath
      || entry.deskExpandedPaths.length > 0
      || entry.deskSelectedPath
      || entry.previewTabs.length > 0
      || entry.previewOpen
      || entry.jianDrawerOpen
      || entry.rightWorkspaceTab !== "workspace"
      || entry.jianView !== "desk"
      || Number.isFinite(source.updatedAt);
    if (hasLegacyState) {
      surfaces[DEFAULT_WORKSPACE_UI_SURFACE] = entry;
    }
  }

  const surfaceEntries = Object.values(surfaces);
  const updatedAt = surfaceEntries.reduce((max, entry) => Math.max(max, entry.updatedAt || 0), 0);
  return {
    updatedAt: updatedAt || (Number.isFinite(source.updatedAt) ? source.updatedAt : opts.now?.() || Date.now()),
    surfaces,
  };
}

export function normalizeWorkspaceUiState(raw: unknown = {}, opts: WorkspaceUiOptions = {}) {
  const source = asRecord(raw);
  const entries: Array<[string, WorkspaceUiRecord]> = Object.entries(source.workspaces || {})
    .map(([workspace, entry]) => {
      const normalizedWorkspace = normalizeWorkspacePath(workspace);
      return normalizedWorkspace
        ? [normalizedWorkspace, normalizeWorkspaceUiRecord(entry, opts)] as [string, WorkspaceUiRecord]
        : null;
    })
    .filter((entry): entry is [string, WorkspaceUiRecord] => !!entry)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, MAX_WORKSPACES);
  return {
    version: WORKSPACE_UI_STATE_VERSION,
    workspaces: Object.fromEntries(entries),
  };
}

export function getWorkspaceUiStateEntry(raw: unknown, workspaceRoot: unknown, opts: WorkspaceUiOptions = {}) {
  const workspace = normalizeWorkspacePath(workspaceRoot);
  const surface = normalizeWorkspaceUiSurface(opts.surface);
  if (!workspace || !surface) return null;
  const state = normalizeWorkspaceUiState(raw, opts);
  const entry = state.workspaces[workspace]?.surfaces?.[surface] || null;
  return clone(entry);
}

export function upsertWorkspaceUiState(
  raw: unknown,
  workspaceRoot: unknown,
  entry: unknown,
  opts: WorkspaceUiOptions = {},
) {
  const workspace = normalizeWorkspacePath(workspaceRoot);
  if (!workspace) return normalizeWorkspaceUiState(raw, opts);
  const surface = normalizeWorkspaceUiSurface(opts.surface);
  if (!surface) return normalizeWorkspaceUiState(raw, opts);
  const state = normalizeWorkspaceUiState(raw, opts);
  const record: WorkspaceUiRecord = state.workspaces[workspace] || { updatedAt: 0, surfaces: {} };
  const normalizedEntry = normalizeWorkspaceUiEntry(entry, opts);
  record.surfaces = { ...(record.surfaces || {}), [surface]: normalizedEntry };
  record.updatedAt = Math.max(
    normalizedEntry.updatedAt || 0,
    ...Object.values(record.surfaces).map(item => (item as UnknownRecord)?.updatedAt || 0),
  );
  state.workspaces[workspace] = record;
  return normalizeWorkspaceUiState(state, opts);
}
