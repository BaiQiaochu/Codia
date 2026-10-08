import { describe, expect, it } from 'vitest';
import {
  extractWorkflowTemplateJson,
  validateWorkflowTemplateDraft,
} from '../shared/workflow-template-draft.ts';

describe('workflow template draft validation', () => {
  it('extracts fenced JSON and validates known agents', () => {
    const value = extractWorkflowTemplateJson('```json\n{"title":"T","nodes":[{"id":"a","title":"A","prompt":"do A","agentId":"worker"},{"id":"b","title":"B","prompt":"do B","agentId":""}],"edges":[{"from":"a","to":"b"}]}\n```');
    const result = validateWorkflowTemplateDraft(value, { allowedAgentIds: ['worker'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft.nodes[0].agentId).toBe('worker');
  });

  it('rejects unknown agents and dangling edges', () => {
    const unknownAgent = validateWorkflowTemplateDraft({
      title: 'T',
      nodes: [{ id: 'a', title: 'A', prompt: 'do A', agentId: 'missing' }, { id: 'b', title: 'B', prompt: 'do B', agentId: '' }],
      edges: [],
    }, { allowedAgentIds: ['worker'] });
    expect(unknownAgent).toMatchObject({ ok: false });

    const agentWithoutRoster = validateWorkflowTemplateDraft({
      title: 'T',
      nodes: [{ id: 'a', title: 'A', prompt: 'do A', agentId: 'missing' }, { id: 'b', title: 'B', prompt: 'do B', agentId: '' }],
      edges: [],
    }, { allowedAgentIds: [] });
    expect(agentWithoutRoster).toMatchObject({ ok: false });

    const dangling = validateWorkflowTemplateDraft({
      title: 'T',
      nodes: [{ id: 'a', title: 'A', prompt: 'do A', agentId: '' }, { id: 'b', title: 'B', prompt: 'do B', agentId: '' }],
      edges: [{ from: 'a', to: 'missing' }],
    });
    expect(dangling).toMatchObject({ ok: false });
  });

  it('strictly enforces the generated template schema', () => {
    expect(validateWorkflowTemplateDraft({
      title: 'One node',
      nodes: [{ id: 'a', title: 'A', prompt: 'do A', agentId: '' }],
      edges: [],
    })).toMatchObject({ ok: false, error: expect.stringContaining('2 到 8') });

    expect(validateWorkflowTemplateDraft({
      title: '',
      nodes: [
        { id: 'a', title: 'A', prompt: 'do A', agentId: '' },
        { id: 'b', title: 'B', prompt: 'do B', agentId: '' },
      ],
      edges: [],
    })).toMatchObject({ ok: false, error: expect.stringContaining('名称') });

    expect(validateWorkflowTemplateDraft({
      title: 'Invalid Agent',
      nodes: [
        { id: 'a', title: 'A', prompt: 'do A', agentId: null },
        { id: 'b', title: 'B', prompt: 'do B', agentId: '' },
      ],
      edges: [],
    })).toMatchObject({ ok: false, error: expect.stringContaining('Agent ID') });
  });
});
