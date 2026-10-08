import { describe, expect, it } from 'vitest';
import {
  createAgentActivitySlice,
  selectAgentActivities,
  type AgentActivityEntry,
  type AgentActivitySlice,
} from '../../stores/agent-activity-slice';

const SESSION = '/sessions/main.jsonl';

function activity(id: string, patch: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    id,
    kind: 'subagent',
    status: 'running',
    sessionPath: SESSION,
    agentId: 'agent-a',
    agentName: 'Agent A',
    summary: 'running',
    childSessionPath: null,
    startedAt: 1,
    finishedAt: null,
    ...patch,
  };
}

describe('agent activity slice', () => {
  it('selects a stable array when persisted activity buckets are object maps', () => {
    const state = {
      agentActivitiesBySession: {
        [SESSION]: {
          'task-a': activity('task-a'),
          'task-b': activity('task-b', { status: 'done' }),
        },
      },
    } as unknown as AgentActivitySlice;

    const selected = selectAgentActivities(SESSION)(state);
    const selectedAgain = selectAgentActivities(SESSION)(state);

    expect(selected.map((entry) => entry.id)).toEqual(['task-a', 'task-b']);
    expect(selectedAgain).toBe(selected);
  });

  it('normalizes malformed buckets before upserting new activity', () => {
    let state: AgentActivitySlice = {
      ...createAgentActivitySlice((partial) => {
        const patch = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...patch };
      }),
      agentActivitiesBySession: {
        [SESSION]: {
          'task-a': activity('task-a'),
        },
      } as unknown as AgentActivitySlice['agentActivitiesBySession'],
    };

    state.upsertAgentActivity(activity('task-b', { status: 'done' }));

    expect(selectAgentActivities(SESSION)(state).map((entry) => entry.id)).toEqual(['task-a', 'task-b']);
  });
});
