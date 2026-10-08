import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('channel agent workflow visualization', () => {
  it('renders per-agent workflow steps from channel phone activity', () => {
    const source = read('components/ChannelsPanel.tsx');

    expect(source).toContain('function buildAgentWorkflowSteps');
    expect(source).toContain('function AgentWorkflowStrip');
    expect(source).toContain('收件');
    expect(source).toContain('研判');
    expect(source).toContain('执行');
    expect(source).toContain('回报');
    expect(source).toContain('history.length > 0');
    expect(source).toContain('AgentWorkflowStrip steps={buildAgentWorkflowSteps(history, t)}');
  });

  it('maps live stream events into a compact execution timeline', () => {
    const source = read('components/ChannelsPanel.tsx');

    expect(source).toContain('function AgentLiveWorkflowTimeline');
    expect(source).toContain('setLiveWorkflowEvents');
    expect(source).toContain("case 'tool_start'");
    expect(source).toContain("case 'tool_end'");
    expect(source).toContain("case 'turn_end'");
    expect(source).toContain('streamBlockWorkflow');
    expect(source).toContain('<AgentLiveWorkflowTimeline events={liveWorkflowEvents} />');
  });

  it('keeps workflow visualization scoped and responsive in the channel inspector', () => {
    const css = read('components/channels/Channels.module.css');

    expect(css).toContain('.agentWorkflowStrip');
    expect(css).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
    expect(css).toContain('.agentWorkflowStep[data-state="active"]');
    expect(css).toContain('.agentWorkflowStep[data-state="error"]');
    expect(css).toContain('.agentLiveWorkflowTimeline');
    expect(css).toContain('.agentLiveWorkflowItem[data-state="done"]');
  });
});
