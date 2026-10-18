import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('canvas dispatch truth', () => {
  it('does not manufacture success after a trigger response', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../components/channels/ChannelWorkflowWindow.tsx'), 'utf8');
    const dispatch = source.slice(source.indexOf('const handleExecuteWorkflow'), source.indexOf('const handleExecuteWorkflow') + 4000);
    expect(dispatch).not.toContain("status: 'succeeded'");
    expect(dispatch).toContain('assignRes.json()');
  });
});

import { workflowTaskState, workflowRunState } from '../../utils/workflow-run-state';
describe('authoritative task evidence', () => {
  it('dispatch and reported output are not success', () => {
    expect(workflowTaskState('assigned')).toBe('queued');
    expect(workflowTaskState('reported')).toBe('running');
    expect(workflowTaskState('completed')).toBe('succeeded');
    expect(workflowRunState([])).toBe('queued');
  });
  it('retains approval, partial failure and cancellation', () => {
    expect(workflowRunState(['succeeded', 'awaiting_approval'])).toBe('awaiting_approval');
    expect(workflowRunState(['succeeded', 'failed'])).toBe('failed');
    expect(workflowRunState(['failed', 'running'])).toBe('partial_failure');
    expect(workflowRunState(['succeeded', 'cancelled'])).toBe('cancelled');
    expect(workflowRunState(['succeeded', 'queued'])).toBe('queued');
    expect(workflowRunState(['succeeded', 'succeeded'])).toBe('succeeded');
  });
});
