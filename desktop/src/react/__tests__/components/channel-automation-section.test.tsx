// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockStoreState = {
  currentChannel: string | null;
  channelMembers: string[];
};

let storeState: MockStoreState;
const jobsSectionMock = vi.fn((props: { allowedAgentIds?: readonly string[]; listId?: string }) => (
  <div data-testid="automation-jobs-section" data-agent-ids={props.allowedAgentIds?.join(',')} data-list-id={props.listId} />
));

vi.mock('../../stores', () => ({
  useStore: <T,>(selector: (state: MockStoreState) => T): T => selector(storeState),
}));

vi.mock('../../components/automation/AutomationJobsSection', () => ({
  AutomationJobsSection: (props: { allowedAgentIds?: readonly string[]; listId?: string }) => jobsSectionMock(props),
}));

describe('ChannelAutomationSection', () => {
  beforeEach(() => {
    storeState = { currentChannel: null, channelMembers: [] };
    jobsSectionMock.mockClear();
    window.t = (key: string) => key;
  });

  afterEach(() => {
    cleanup();
  });

  it('asks the user to select a channel before showing plans', async () => {
    const { ChannelAutomationSection } = await import('../../components/channels/ChannelAutomationSection');
    render(<ChannelAutomationSection />);

    expect(screen.getByText('请先选择一个 Agent 小队查看任务计划')).toBeInTheDocument();
    expect(screen.queryByTestId('automation-jobs-section')).not.toBeInTheDocument();
  });

  it('scopes plan management to the selected channel members', async () => {
    storeState = {
      currentChannel: 'design-team',
      channelMembers: ['agent-a', 'agent-b'],
    };
    const { ChannelAutomationSection } = await import('../../components/channels/ChannelAutomationSection');
    render(<ChannelAutomationSection />);

    const section = screen.getByTestId('automation-jobs-section');
    expect(section).toHaveAttribute('data-agent-ids', 'agent-a,agent-b');
    expect(section).toHaveAttribute('data-list-id', 'channelAutomationList');
  });
});
