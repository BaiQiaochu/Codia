import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('channel workflow window contract', () => {
  it('exposes a dedicated workflow graph window from the channel header', () => {
    const header = read('components/channels/ChannelHeader.tsx');

    expect(header).toContain('ChannelWorkflowWindow');
    expect(header).toContain('workflowOpen');
    expect(header).toContain('aria-label="工作流图"');
    expect(header).toContain('setWorkflowOpen(true)');
  });

  it('renders a ComfyUI-like node canvas without using the chat input surface', () => {
    const source = read('components/channels/ChannelWorkflowWindow.tsx');

    expect(source).toContain('createPortal');
    expect(source).toContain('WorkflowNodeCard');
    expect(source).toContain('workflowCanvas');
    expect(source).toContain('workflowEdges');
    expect(source).toContain('workflowNodePort');
    expect(source).toContain('workflowStageRail');
    expect(source).toContain('workflowInspector');
    expect(source).toContain('workflowMiniMap');
    expect(source).toContain('handleWorkflowCanvasWheel');
    expect(source).toContain('data-workflow-canvas-scroll');
    expect(source).toContain('channelMessages.length');
    expect(source).toContain('暂无工作流任务');
    expect(source).toContain('graph.isEmpty');
    expect(source).toContain('/api/plugins/company/companies/default/status');
    expect(source).toContain("aria-label={pageMode ? '工作流页面' : '工作流可视窗口'}");
    expect(source).toContain('workflowPageOverlay');
    expect(source).toContain('workflowDraftStorageKey');
    expect(source).toContain('关联执行Agent 小队');
    expect(source).toContain('工作流画布');
    expect(source).not.toContain('Codia 工作流画布');
  });

  it('lets the workflow canvas add nodes, connect nodes, delete the workflow, and dispatch agent tasks', () => {
    const source = read('components/channels/ChannelWorkflowWindow.tsx');
    const css = read('components/channels/Channels.module.css');

    expect(source).toContain('customWorkflowNodes');
    expect(source).toContain('handleAddWorkflowNode');
    expect(source).toContain('handleDeleteWorkflow');
    expect(source).toContain('handleWorkflowNodeClick');
    expect(source).toContain('connectFromNodeId');
    expect(source).toContain('/api/plugins/company/tasks/assign-from-workflow');
    expect(source).toContain('workflowPlan');
    expect(source).toContain('mentionedAgents');
    expect(css).toContain('.workflowWindowDangerButton');
    expect(css).toContain('.workflowNodeSelected');
    expect(css).toContain('.workflowNodeConnectTarget');
  });

  it('links task tree cards and workflow nodes in both directions', () => {
    const workflowSource = read('components/channels/ChannelWorkflowWindow.tsx');
    const panelSource = read('components/channels/ChannelWorkspacePanel.tsx');
    const css = read('components/channels/Channels.module.css');

    expect(workflowSource).toContain('codia-channel-task-focus-workflow');
    expect(workflowSource).toContain('codia-channel-workflow-focus-task');
    expect(workflowSource).toContain('scrollWorkflowNodeIntoView');
    expect(workflowSource).toContain('data-workflow-node-id');
    expect(panelSource).toContain('codia-channel-task-focus-workflow');
    expect(panelSource).toContain('codia-channel-workflow-focus-task');
    expect(panelSource).toContain('scrollTaskNodeIntoView');
    expect(panelSource).toContain('data-company-task-id');
    expect(css).toContain('.channelTaskNodeFocused');
  });

  it('shows an execution timeline that connects node time, agent, input, output, and failure', () => {
    const source = read('components/channels/ChannelWorkflowWindow.tsx');
    const css = read('components/channels/Channels.module.css');

    expect(source).toContain('interface WorkflowRunSnapshot');
    expect(source).toContain('workflowRunSnapshots');
    expect(source).toContain('hiddenTimelineItemIds');
    expect(source).toContain('handleDeleteTimelineItem');
    expect(source).toContain('handleClearTimeline');
    expect(source).toContain('retryState');
    expect(source).toContain('snapshotWorkflowRun');
    expect(source).toContain('persistStoredWorkflow');
    expect(source).toContain('interface WorkflowTimelineItem');
    expect(source).toContain('timelineItems');
    expect(source).toContain('workflowTimeline');
    expect(source).toContain('workflowTimelineItem');
    expect(source).toContain('detailText');
    expect(source).toContain('failure');
    expect(source).toContain('input');
    expect(source).toContain('output');
    expect(css).toContain('.workflowTimeline');
    expect(css).toContain('.workflowTimelineItem');
    expect(css).toContain('.workflowTimelineClearButton');
    expect(css).toContain('.workflowTimelineDeleteButton');
    expect(css).toMatch(/\.workflowTimeline \{[\s\S]*?padding:\s*0 14px 2px 0;/);
    expect(css).toMatch(/\.workflowTimelineActions \{[\s\S]*?max-height:\s*0;/);
    expect(css).toMatch(/\.workflowTimelineItem:hover \.workflowTimelineActions,[\s\S]*?max-height:\s*28px;/);
  });

  it('surfaces director supervision in the workflow canvas inspector', () => {
    const source = read('components/channels/ChannelWorkflowWindow.tsx');
    const css = read('components/channels/Channels.module.css');

    expect(source).toContain('directorSupervisors');
    expect(source).toContain('workflowDirectorPanel');
    expect(source).toContain('data-workflow-supervisor-id');
    expect(source).toContain('调度总监');
    expect(source).toContain('总监群监督');
    expect(source).toContain('待复核');
    expect(css).toContain('.workflowDirectorPanel');
    expect(css).toContain('.workflowDirectorMember');
  });

  it('keeps the workflow window above app chrome and scrolls its own canvas', () => {
    const css = read('components/channels/Channels.module.css');

    expect(css).toMatch(/\.workflowWindowOverlay \{[\s\S]*?position: fixed;/);
    expect(css).toMatch(/\.workflowWindowOverlay \{[\s\S]*?z-index: 3600;/);
    expect(css).toMatch(/\.workflowWindowOverlay \{[\s\S]*?isolation: isolate;/);
    expect(css).toMatch(/\.workflowWindowCanvasScroll \{[\s\S]*?overflow: auto;/);
    expect(css).toMatch(/\.workflowCanvas \{[\s\S]*?position: relative;/);
    expect(css).toMatch(/\.workflowWindowMain \{[\s\S]*?min-height: 0;/);
    expect(css).toMatch(/\.workflowInspector \{[\s\S]*?overflow: auto;/);
    expect(css).toContain('@media (max-width: 720px)');
  });

  it('uses an expanding workflow canvas instead of clamping nodes to a fixed right or bottom edge', () => {
    const source = read('components/channels/ChannelWorkflowWindow.tsx');
    const css = read('components/channels/Channels.module.css');

    expect(source).toContain('const WORKFLOW_CANVAS_BASE_W = 6400;');
    expect(source).toContain('const WORKFLOW_CANVAS_BASE_H = 4200;');
    expect(source).toContain('const WORKFLOW_CANVAS_EXPAND_MARGIN = 1400;');
    expect(source).toContain('WORKFLOW_CANVAS_EXPAND_MARGIN');
    expect(source).toContain('Math.max(WORKFLOW_CANVAS_BASE_W, maxX + WORKFLOW_CANVAS_EXPAND_MARGIN)');
    expect(source).toContain('Math.max(WORKFLOW_CANVAS_BASE_H, maxY + WORKFLOW_CANVAS_EXPAND_MARGIN)');
    expect(source).toContain('Math.max(12, Math.round(x))');
    expect(source).toContain('Math.max(12, Math.round(y))');
    expect(source).not.toContain('CANVAS_W - node.w - 12');
    expect(source).not.toContain('bounds.width - nodeW - 12');
    expect(source).not.toContain('bounds.height - nodeH - 12');
    expect(css).toMatch(/\.workflowCanvasStage \{[\s\S]*?width:\s*max-content;/);
    expect(css).toMatch(/\.workflowCanvas \{[\s\S]*?width:\s*max-content;/);
    expect(css).toContain('overscroll-behavior: contain;');
  });
});
