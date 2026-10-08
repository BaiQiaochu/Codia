/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SubagentSessionPreview } from '../../components/chat/SubagentSessionPreview';
import { loadMessages } from '../../stores/session-actions';
import { requestStreamResume } from '../../services/stream-resume';

vi.mock('../../stores/session-actions', async () => {
  const actual = await vi.importActual<typeof import('../../stores/session-actions')>('../../stores/session-actions');
  return {
    ...actual,
    loadMessages: vi.fn(async () => {}),
  };
});

vi.mock('../../services/stream-resume', () => ({
  requestStreamResume: vi.fn(),
}));

function makeScrollContainerRef() {
  return { current: null };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SubagentSessionPreview session binding', () => {
  it('shows terminal failure summary instead of connecting forever when sessionPath is missing', () => {
    render(
      <SubagentSessionPreview
        taskId="task-a"
        sessionPath={null}
        streamStatus="failed"
        summary="Historical subagent session link is unrecoverable."
        scrollContainerRef={makeScrollContainerRef()}
      />,
    );

    expect(screen.getByText('Historical subagent session link is unrecoverable.')).toBeTruthy();
    expect(vi.mocked(loadMessages)).not.toHaveBeenCalled();
  });

  it('requests stream resume for a running child session when preview opens', () => {
    render(
      <SubagentSessionPreview
        taskId="task-a"
        sessionPath="/session/subagent.jsonl"
        streamStatus="running"
        scrollContainerRef={makeScrollContainerRef()}
      />,
    );

    expect(vi.mocked(requestStreamResume)).toHaveBeenCalledWith('/session/subagent.jsonl');
  });
});
