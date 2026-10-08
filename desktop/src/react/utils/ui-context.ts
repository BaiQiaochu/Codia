/**
 * UI Context 收集器
 *
 * 每次发 WS prompt 前调用一次，把用户当下视野（浏览目录 / 预览焦点 /
 * 派生 viewer 钉住的文件）拼成后端约定的 uiContext payload。
 *
 * 后端在 context extension hook 里根据这份 payload 生成 reminder 注入
 * 到 last user message（见 core/ui-context-reminder.js）。
 *
 * 所有字段都空时返回 null，节省 WS 传输；后端收到 null 会清空旧值。
 */

import type { StoreState } from '../stores';
import type { Artifact } from '../types';
import { selectActiveTabId, selectArtifacts } from '../stores/preview-slice';
import type { WorkspaceToolSelection } from './workspace-tool-events';
import { normalizeWorkspaceToolSelection } from './workspace-tool-events';

export interface UiWorkspaceToolContext {
  id: string;
  title: string;
  description?: string;
}

export interface UiContextPayload {
  currentViewed: string | null;
  activeFile: string | null;
  activeArtifact: string | null;
  pinnedFiles: string[];
  workspaceTool?: UiWorkspaceToolContext;
}

export function normalizeWorkspaceToolContext(tool: WorkspaceToolSelection | UiWorkspaceToolContext | null | undefined): UiWorkspaceToolContext | null {
  const normalized = normalizeWorkspaceToolSelection(tool);
  if (!normalized) return null;
  return {
    id: normalized.id,
    title: normalized.title,
    ...(normalized.description ? { description: normalized.description } : {}),
  };
}

export function collectUiContext(
  state: StoreState,
  options: { workspaceTool?: WorkspaceToolSelection | UiWorkspaceToolContext | null } = {},
): UiContextPayload | null {
  const currentViewed = state.deskCurrentPath || null;

  const activeTabId = selectActiveTabId(state);
  const activeTab: Artifact | undefined = selectArtifacts(state).find(
    (a: Artifact) => a.id === activeTabId,
  );
  const activeFile = activeTab?.filePath ?? null;
  const activeArtifact =
    activeTab && !activeTab.filePath ? activeTab.title : null;

  const pinnedFiles = state.pinnedViewers.map((v) => v.filePath);
  const workspaceTool = normalizeWorkspaceToolContext(options.workspaceTool);

  if (
    !currentViewed &&
    !activeFile &&
    !activeArtifact &&
    pinnedFiles.length === 0 &&
    !workspaceTool
  ) {
    return null;
  }

  return {
    currentViewed,
    activeFile,
    activeArtifact,
    pinnedFiles,
    ...(workspaceTool ? { workspaceTool } : {}),
  };
}
