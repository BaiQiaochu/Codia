import { describe, expect, it } from 'vitest';
import { getSessionDisplayTitle } from '../../utils/session-title-display';
import type { Session } from '../../types';

function makeSession(patch: Partial<Session>): Session {
  return {
    path: 'C:/Users/ghost/.gsap/agents/a/sessions/2026-06-04T07-47-05-360Z_019e9199-a210-7b4e-a22e-7f5000000000.jsonl',
    title: null,
    firstMessage: '',
    modified: '2026-06-04T07:48:05.000Z',
    messageCount: 0,
    agentId: 'a',
    agentName: 'G-SAP',
    cwd: null,
    ...patch,
  };
}

describe('session title display', () => {
  it('hides generated session file names from the sidebar title', () => {
    const session = makeSession({
      title: '2026-06-04T07-47-05-360Z_019e9199-a210-7b4e-a22e-7f5000000000',
      firstMessage: '',
    });

    expect(getSessionDisplayTitle(session, '新对话')).toBe('新对话');
  });

  it('falls back from an internal title to the first real user message', () => {
    const session = makeSession({
      title: '2026-06-04T07-47-05-360Z_019e9199-a210-7b4e-a22e-7f5000000000',
      firstMessage: '检查模型是否在线',
    });

    expect(getSessionDisplayTitle(session, '新对话')).toBe('检查模型是否在线');
  });

  it('hides timestamp session names with non-standard generated suffixes', () => {
    const session = makeSession({
      title: 'F:/G-SAP/sessions/2026-06-04T07-47-05-360Z_019e9199-a210-7b4e-a22e-7f5.jsonl',
      firstMessage: '是否在线?',
    });

    expect(getSessionDisplayTitle(session, '新对话')).toBe('是否在线?');
  });
});
