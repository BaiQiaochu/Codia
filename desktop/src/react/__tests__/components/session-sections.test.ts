import { describe, expect, it } from 'vitest';
import type { Session } from '../../types';
import { buildSessionProjectView, buildSessionSections } from '../../components/session-sections';

function makeSession(overrides: Partial<Session>): Session {
  return {
    path: '/sessions/default.jsonl',
    title: null,
    firstMessage: '',
    modified: '2026-04-29T01:00:00.000Z',
    messageCount: 1,
    agentId: 'codia',
    agentName: 'Codia',
    cwd: null,
    ...overrides,
  };
}

describe('session sections', () => {
  it('sorts pinned time-view sessions by modified time instead of pin time', () => {
    const sections = buildSessionSections([
      makeSession({
        path: '/sessions/recent-pin.jsonl',
        modified: '2026-04-29T09:00:00.000Z',
        pinnedAt: '2026-04-28T07:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/freshly-pinned-old-chat.jsonl',
        modified: '2026-04-28T07:00:00.000Z',
        pinnedAt: '2026-04-29T08:00:00.000Z',
      }),
    ], {
      mode: 'time',
      now: new Date('2026-04-29T12:00:00.000Z'),
    });

    expect(sections[0].kind).toBe('pinned');
    expect(sections[0].items.map(item => item.path)).toEqual([
      '/sessions/recent-pin.jsonl',
      '/sessions/freshly-pinned-old-chat.jsonl',
    ]);
  });

  it('sorts pinned project-view sessions by modified time instead of pin time', () => {
    const view = buildSessionProjectView([
      makeSession({
        path: '/sessions/recent-pin.jsonl',
        modified: '2026-05-28T09:00:00.000Z',
        pinnedAt: '2026-05-27T08:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/freshly-pinned-old-chat.jsonl',
        modified: '2026-05-28T07:00:00.000Z',
        pinnedAt: '2026-05-28T10:00:00.000Z',
      }),
    ], { projects: [] });

    expect(view.pinned.map(item => item.path)).toEqual([
      '/sessions/recent-pin.jsonl',
      '/sessions/freshly-pinned-old-chat.jsonl',
    ]);
  });
});
