import { normalizeWorkspacePath } from '../../../../shared/workspace-history';

const LEGACY_HOME_MIGRATION_KEY = 'codia.workflow.legacy-default-home';

export function resolveWorkflowWorkspaceKey(state: {
  selectedWorkspaceMountId?: string | null;
  selectedFolder?: string | null;
  deskWorkspaceMountId?: string | null;
  deskBasePath?: string | null;
  homeFolder?: string | null;
}) {
  return state.selectedWorkspaceMountId || state.selectedFolder
    || state.deskWorkspaceMountId || state.deskBasePath || state.homeFolder || 'default';
}

export function workflowDraftStorageKey(workspaceKey: string) {
  return `codia.channel.workflow.draft.${encodeURIComponent(workspaceKey || 'default')}`;
}

export function workflowExecutionBindingKey(workspaceKey: string) {
  return `codia.workflow.execution-channel.${encodeURIComponent(workspaceKey || 'default')}`;
}

// Older versions used the transient new-session folder selection as the draft
// scope. Opening a chat clears that selection, so home drafts landed in default.
// Adopt that legacy draft once, only for home, without overwriting a scoped draft
// or discarding the original. The marker prevents deleted drafts reappearing.
export function restoreLegacyHomeWorkflowDraft(
  storage: Storage,
  workspaceKey: string,
  homeFolder: string | null,
) {
  if (!homeFolder || workspaceKey === 'default'
    || normalizeWorkspacePath(workspaceKey) !== normalizeWorkspacePath(homeFolder)
    || storage.getItem(LEGACY_HOME_MIGRATION_KEY) !== null) return;

  const legacyDraft = storage.getItem(workflowDraftStorageKey('default'));
  const targetDraftKey = workflowDraftStorageKey(workspaceKey);
  if (legacyDraft !== null && storage.getItem(targetDraftKey) === null) {
    storage.setItem(targetDraftKey, legacyDraft);
    const legacyBinding = storage.getItem(workflowExecutionBindingKey('default'));
    const targetBindingKey = workflowExecutionBindingKey(workspaceKey);
    if (legacyBinding !== null && storage.getItem(targetBindingKey) === null) {
      storage.setItem(targetBindingKey, legacyBinding);
    }
  }
  storage.setItem(LEGACY_HOME_MIGRATION_KEY, workspaceKey);
}
