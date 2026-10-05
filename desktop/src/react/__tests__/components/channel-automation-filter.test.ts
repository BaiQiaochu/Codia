import { describe, expect, it } from 'vitest';
import type { CronJob } from '../../components/automation/automation-types';
import { filterJobsForAgentIds } from '../../components/automation/automation-utils';

describe('channel automation filtering', () => {
  const jobs: CronJob[] = [
    { id: 'one', enabled: true, schedule: '0 9 * * *', actorAgentId: 'agent-a' },
    { id: 'two', enabled: true, schedule: '0 10 * * *', executor: { kind: 'agent_session', agentId: 'agent-b' } },
    { id: 'three', enabled: false, schedule: '0 11 * * *', actorAgentId: 'agent-c' },
    { id: 'legacy', enabled: false, schedule: '0 12 * * *' },
  ];

  it('keeps only jobs owned by current channel members', () => {
    expect(filterJobsForAgentIds(jobs, ['agent-a', 'agent-b'], 'agent-a').map(job => job.id))
      .toEqual(['one', 'two']);
  });

  it('keeps unowned legacy jobs in the global plan view instead of leaking them across channels', () => {
    expect(filterJobsForAgentIds(jobs, ['agent-a'], 'agent-a').map(job => job.id))
      .toEqual(['one']);
  });

  it('does not expose jobs from agents outside the channel', () => {
    expect(filterJobsForAgentIds(jobs, ['agent-b'], 'agent-a').map(job => job.id))
      .toEqual(['two']);
  });
});
