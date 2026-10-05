import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = path.resolve(ROOT, '..', '..', '..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('feature completion UI contracts', () => {
  it('wires yuan prompt template preview, reset, and diff into the agent settings tab', () => {
    const agentTab = read('settings/tabs/AgentTab.tsx');
    expect(agentTab).toContain('/prompt-templates');
    expect(agentTab).toContain('/prompt-templates/${promptTemplateKind}/reset');
    expect(agentTab).toContain("promptTemplateMode, setPromptTemplateMode");
    expect(agentTab).toContain("loadPromptTemplates('diff')");
    expect(agentTab).toContain('selectedPromptTemplate.diff');
  });

  it('keeps assistant card primary-agent controls wired to the primary route', () => {
    const actions = read('settings/actions.ts');
    const agentTab = read('settings/tabs/AgentTab.tsx');
    const agentCardStack = read('settings/tabs/agent/AgentCardStack.tsx');

    expect(actions).toContain('export async function setPrimaryAgent');
    expect(actions).toContain("gsapFetch('/api/agents/primary'");
    expect(agentTab).toContain('setPrimaryAgent');
    expect(agentTab).toContain('onSetPrimary=');
    expect(agentCardStack).toContain('onSetPrimary');
    expect(agentCardStack).toContain('agent.isPrimary && <div');
    expect(agentCardStack).not.toContain('agent.id === currentAgentId && <div');
  });

  it('adds a session resource library tab with chat, channel, and workflow reuse actions', () => {
    const rightWorkspace = read('components/right-workspace/RightWorkspacePanel.tsx');
    const library = read('components/right-workspace/SessionResourceLibraryPanel.tsx');
    const workflow = read('components/channels/ChannelWorkflowWindow.tsx');
    expect(rightWorkspace).toContain("id: 'session-library'");
    expect(library).toContain('hideSessionResources');
    expect(library).toContain("attachToInput(file, 'channel')");
    expect(library).toContain("target: 'workflow'");
    expect(library).toContain('setPendingChannelResourceAction');
    expect(workflow).toContain('gsap-channel-workflow-add-resource');
  });

  it('keeps workflow replay UI contracts without backend diagnostic workspace tabs', () => {
    const rightWorkspace = read('components/right-workspace/RightWorkspacePanel.tsx');
    const linkOpen = read('utils/link-open.ts');
    const workflow = read('components/channels/ChannelWorkflowWindow.tsx');
    const workflowCss = read('components/channels/Channels.module.css');
    expect(rightWorkspace).not.toContain("id: 'migration-audit'");
    expect(rightWorkspace).not.toContain("id: 'link-preview'");
    expect(rightWorkspace).not.toContain('<MigrationAuditPanel />');
    expect(rightWorkspace).not.toContain('<LinkSafetyPreviewPanel />');
    expect(linkOpen).not.toContain("setRightWorkspaceTab?.('link-preview')");
    expect(workflow).toContain('workflowReplayItemId');
    expect(workflow).toContain('workflowReplayPlaying');
    expect(workflow).toContain('handleRerunWorkflowReplayItem');
    expect(workflow).toContain("source: 'workflow_replay'");
    expect(workflow).toContain('handleReplayTimelineItem');
    expect(workflow).toContain('data-workflow-replay-active');
    expect(workflowCss).toContain('.workflowReplayPanel');
    expect(workflowCss).toContain('.workflowTimelineReplayButton');
  });

  it('does not keep the non-original migration audit or link preview feature blocks', () => {
    const rightWorkspace = read('components/right-workspace/RightWorkspacePanel.tsx');
    const rightWorkspaceCss = read('components/right-workspace/RightWorkspacePanel.module.css');
    const uiSlice = read('stores/ui-slice.ts');
    const linkOpen = read('utils/link-open.ts');
    const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const systemHealthRoute = fs.readFileSync(path.join(PROJECT_ROOT, 'server/routes/system-health.ts'), 'utf8');

    expect(fs.existsSync(path.join(ROOT, 'components/right-workspace/MigrationAuditPanel.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'components/right-workspace/LinkSafetyPreviewPanel.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'scripts/cli-migration-map.mjs'))).toBe(false);
    expect(rightWorkspace).not.toMatch(/MigrationAudit|LinkSafetyPreview|migration-audit|link-preview/);
    expect(rightWorkspaceCss).not.toMatch(/auditPanel|linkPreview/);
    expect(uiSlice).not.toMatch(/LinkSafetyPreview|linkSafetyPreview|setLinkSafetyPreview/);
    expect(linkOpen).not.toMatch(/previewInternalLink|gsap-link-safety-preview|setLinkSafetyPreview/);
    expect(systemHealthRoute).not.toContain('/system/migration-audit');
    expect(packageJson.scripts).not.toHaveProperty('audit:cli-migration');
    expect(packageJson.scripts['test:core']).not.toContain('tests/cli-migration-map.test.js');
  });

  it('adds a plugin capability matrix and one-click diagnostic package export', () => {
    const plugins = read('settings/tabs/PluginsTab.tsx');
    const diagnostics = read('settings/tabs/DiagnosticsTab.tsx');
    expect(plugins).toContain('/api/plugins/capability-matrix');
    expect(plugins).toContain('capabilityMatrix');
    expect(diagnostics).toContain('/api/system/diagnostic-package');
    expect(diagnostics).toContain('captureUiSnapshot');
    expect(diagnostics).toContain('downloadJson(`gsap-diagnostic-package-');
  });
});
