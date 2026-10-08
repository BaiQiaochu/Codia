const MAX_IDS = 256;
const MAX_ID_LENGTH = 240;

export interface SidebarUiProjectViewPrefs {
  collapsedProjectIds: string[];
  collapsedFolderIds: string[];
  showAllProjectIds: string[];
}

export type SidebarSessionListRowMode = "two-line" | "single-line";

export interface SidebarUiSessionListPrefs {
  rowMode: SidebarSessionListRowMode;
}

export interface SidebarUiPrefs {
  projectView: SidebarUiProjectViewPrefs;
  sessionList: SidebarUiSessionListPrefs;
}

export type SidebarUiPrefsPatch = {
  projectView?: Partial<SidebarUiProjectViewPrefs>;
  sessionList?: Partial<SidebarUiSessionListPrefs>;
};

const DEFAULT_SESSION_LIST_ROW_MODE: SidebarSessionListRowMode = "two-line";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return "";
  return trimmed;
}

function uniqueIds(values: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(values) ? values : []) {
    const id = cleanId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

function normalizeSessionListRowMode(value: unknown): SidebarSessionListRowMode {
  return value === "single-line" ? "single-line" : DEFAULT_SESSION_LIST_ROW_MODE;
}

export function normalizeSidebarUiPrefs(raw: unknown = {}): SidebarUiPrefs {
  const source = isRecord(raw) ? raw : {};
  const projectView = isRecord(source.projectView)
    ? source.projectView
    : {};
  const sessionList = isRecord(source.sessionList)
    ? source.sessionList
    : {};
  return {
    projectView: {
      collapsedProjectIds: uniqueIds(projectView.collapsedProjectIds),
      collapsedFolderIds: uniqueIds(projectView.collapsedFolderIds),
      showAllProjectIds: uniqueIds(projectView.showAllProjectIds),
    },
    sessionList: {
      rowMode: normalizeSessionListRowMode(sessionList.rowMode),
    },
  };
}

export function normalizeSidebarUiPrefsPatch(raw: unknown = {}): SidebarUiPrefsPatch {
  const source = isRecord(raw) ? raw : {};
  const patch: SidebarUiPrefsPatch = {};
  if (isRecord(source.projectView)) {
    const projectViewPatch: Partial<SidebarUiProjectViewPrefs> = {};
    for (const key of ["collapsedProjectIds", "collapsedFolderIds", "showAllProjectIds"] as const) {
      if (Object.prototype.hasOwnProperty.call(source.projectView, key)) {
        projectViewPatch[key] = uniqueIds(source.projectView[key]);
      }
    }
    if (Object.keys(projectViewPatch).length > 0) patch.projectView = projectViewPatch;
  }
  if (isRecord(source.sessionList) && Object.prototype.hasOwnProperty.call(source.sessionList, "rowMode")) {
    patch.sessionList = {
      rowMode: normalizeSessionListRowMode(source.sessionList.rowMode),
    };
  }
  return patch;
}

export function mergeSidebarUiPrefs(current: unknown = {}, partial: unknown = {}): SidebarUiPrefs {
  const base = normalizeSidebarUiPrefs(current);
  const patch = isRecord(partial) ? partial : {};
  const patchProjectView = isRecord(patch.projectView)
    ? patch.projectView
    : {};
  const patchSessionList = isRecord(patch.sessionList)
    ? patch.sessionList
    : {};
  const nextProjectView = { ...base.projectView };
  for (const key of ["collapsedProjectIds", "collapsedFolderIds", "showAllProjectIds"] as const) {
    if (Object.prototype.hasOwnProperty.call(patchProjectView, key)) {
      nextProjectView[key] = uniqueIds(patchProjectView[key]);
    }
  }
  const nextSessionList = { ...base.sessionList };
  if (Object.prototype.hasOwnProperty.call(patchSessionList, "rowMode")) {
    if (patchSessionList.rowMode === "single-line" || patchSessionList.rowMode === "two-line") {
      nextSessionList.rowMode = patchSessionList.rowMode;
    }
  }
  return normalizeSidebarUiPrefs({ projectView: nextProjectView, sessionList: nextSessionList });
}
