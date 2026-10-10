export const WORKSPACE_TOOL_SELECT_EVENT = 'codia-workspace-tool-select';

export type {
  WorkspaceToolId,
  WorkspaceToolSelection,
} from '../../../../shared/workspace-tools.ts';
export {
  WORKSPACE_TOOL_OPTIONS,
  isWorkspaceToolId,
  normalizeWorkspaceToolSelection,
} from '../../../../shared/workspace-tools.ts';

import type { WorkspaceToolSelection } from '../../../../shared/workspace-tools.ts';
import {
  isWorkspaceToolId,
  normalizeWorkspaceToolSelection,
} from '../../../../shared/workspace-tools.ts';

export function requestWorkspaceToolSelection(selection: WorkspaceToolSelection): boolean {
  if (typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<WorkspaceToolSelection>(WORKSPACE_TOOL_SELECT_EVENT, {
    detail: selection,
  }));
  return true;
}

export function readWorkspaceToolSelectionDetail(value: unknown): WorkspaceToolSelection | null {
  if (!value || typeof value !== 'object') return null;
  const detail = value as Partial<WorkspaceToolSelection>;
  if (!isWorkspaceToolId(detail.id)) return null;
  return normalizeWorkspaceToolSelection(detail);
}
