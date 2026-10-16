import { useStore } from '../stores';
import { resolveWorkflowWorkspaceKey } from './workflow-workspace-storage';
const EVENT = 'codia-workflow-template-request';
let pending: { description: string; workspace: string } | null = null;
function workspace() {
  const state = useStore.getState();
  return resolveWorkflowWorkspaceKey(state);
}
export function requestWorkflowTemplate(description: string) {
  pending = { description, workspace: workspace() };
  window.dispatchEvent(new Event(EVENT));
}
export function consumeWorkflowTemplateRequest() {
  if (!pending || pending.workspace !== workspace()) return null;
  const request = pending;
  pending = null;
  return request.description;
}
export const WORKFLOW_TEMPLATE_REQUEST_EVENT = EVENT;
