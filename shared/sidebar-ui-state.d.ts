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

export function normalizeSidebarUiPrefs(raw?: unknown): SidebarUiPrefs;
export function normalizeSidebarUiPrefsPatch(raw?: unknown): SidebarUiPrefsPatch;
export function mergeSidebarUiPrefs(current?: unknown, partial?: unknown): SidebarUiPrefs;
