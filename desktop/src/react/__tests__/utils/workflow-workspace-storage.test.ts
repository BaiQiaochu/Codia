// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  restoreLegacyHomeWorkflowDraft,
  resolveWorkflowWorkspaceKey,
  workflowDraftStorageKey,
  workflowExecutionBindingKey,
} from '../../utils/workflow-workspace-storage';

const home = '/workspace/home';
const legacy = JSON.stringify({ nodes: [{ id: 'saved-node' }], edges: [] });

describe('workflow workspace scope', () => {
  it('keeps folder selections ahead of stale desk mounts and actual desks ahead of home', () => {
    expect(resolveWorkflowWorkspaceKey({ selectedWorkspaceMountId: 'selected-mount', selectedFolder: home })).toBe('selected-mount');
    expect(resolveWorkflowWorkspaceKey({ selectedFolder: home, deskWorkspaceMountId: 'old-mount' })).toBe(home);
    expect(resolveWorkflowWorkspaceKey({ deskWorkspaceMountId: 'actual-mount', deskBasePath: 'studio:actual-mount', homeFolder: home })).toBe('actual-mount');
    expect(resolveWorkflowWorkspaceKey({ deskBasePath: '/project', homeFolder: home })).toBe('/project');
    expect(resolveWorkflowWorkspaceKey({ homeFolder: home })).toBe(home);
    expect(resolveWorkflowWorkspaceKey({})).toBe('default');
  });
});

describe('legacy home workflow draft recovery', () => {
  beforeEach(() => localStorage.clear());

  it('copies the legacy draft and execution binding together without removing the original', () => {
    localStorage.setItem(workflowDraftStorageKey('default'), legacy);
    localStorage.setItem(workflowExecutionBindingKey('default'), 'saved-channel');
    restoreLegacyHomeWorkflowDraft(localStorage, home, home);
    expect(localStorage.getItem(workflowDraftStorageKey(home))).toBe(legacy);
    expect(localStorage.getItem(workflowExecutionBindingKey(home))).toBe('saved-channel');
    expect(localStorage.getItem(workflowDraftStorageKey('default'))).toBe(legacy);
  });

  it('does not replace or rebind an existing home draft', () => {
    localStorage.setItem(workflowDraftStorageKey('default'), legacy);
    localStorage.setItem(workflowExecutionBindingKey('default'), 'legacy-channel');
    localStorage.setItem(workflowDraftStorageKey(home), '{"nodes":[]}');
    restoreLegacyHomeWorkflowDraft(localStorage, home, home);
    expect(localStorage.getItem(workflowDraftStorageKey(home))).toBe('{"nodes":[]}');
    expect(localStorage.getItem(workflowExecutionBindingKey(home))).toBeNull();
  });

  it('never assigns the unscoped draft to another workspace or a later home', () => {
    localStorage.setItem(workflowDraftStorageKey('default'), legacy);
    restoreLegacyHomeWorkflowDraft(localStorage, '/workspace/other', home);
    restoreLegacyHomeWorkflowDraft(localStorage, 'default', home);
    expect(localStorage.getItem(workflowDraftStorageKey('/workspace/other'))).toBeNull();
    restoreLegacyHomeWorkflowDraft(localStorage, home, home);
    restoreLegacyHomeWorkflowDraft(localStorage, '/workspace/new-home', '/workspace/new-home');
    expect(localStorage.getItem(workflowDraftStorageKey('/workspace/new-home'))).toBeNull();
  });

  it('does not resurrect a deleted draft on reopen or restart', () => {
    localStorage.setItem(workflowDraftStorageKey('default'), legacy);
    restoreLegacyHomeWorkflowDraft(localStorage, home, home);
    localStorage.removeItem(workflowDraftStorageKey(home));
    restoreLegacyHomeWorkflowDraft(localStorage, home, home);
    expect(localStorage.getItem(workflowDraftStorageKey(home))).toBeNull();
    expect(localStorage.getItem(workflowDraftStorageKey('default'))).toBe(legacy);
  });
});
