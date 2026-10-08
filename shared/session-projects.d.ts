export const SESSION_PROJECTS_VERSION: 1;
export const SESSION_PROJECTS_FILENAME: "session-projects.json";
export const UNCATEGORIZED_PROJECT_ID: "cwd:";

export interface SessionProjectRecord {
  id: string;
  name: string;
  folderId: string | null;
  order: number;
}

export interface SessionProjectFolderRecord {
  id: string;
  name: string;
  order: number;
}

export interface SessionProjectCatalogRecord {
  folders: SessionProjectFolderRecord[];
  projects: SessionProjectRecord[];
}

export function normalizeProjectName(value: unknown, fallback?: string): string;
export function normalizeSessionProjectId(value: unknown): string | null;
export function autoProjectIdForCwd(cwd: unknown): string;
export function isAutoProjectId(projectId: unknown): boolean;
export function cwdFromAutoProjectId(projectId: unknown): string | null;
export function autoProjectNameForCwd(cwd: unknown, fallback?: string): string;
export function normalizeSessionProjectCatalog(input?: unknown): SessionProjectCatalogRecord;
export function serializeSessionProjectCatalog(catalog: unknown): {
  version: typeof SESSION_PROJECTS_VERSION;
  folders: SessionProjectFolderRecord[];
  projects: SessionProjectRecord[];
};
