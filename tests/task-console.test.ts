import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createTaskConsoleRoute } from '../server/routes/task-console.ts';
import { normalizeConsoleRun } from '../shared/task-console/records.ts';
import { TASK_TEMPLATES, preflightTemplate, buildTemplateDraft } from '../shared/task-console/templates.ts';
import { classifyHttpRoute } from '../server/http/route-security.ts';

function app(model: unknown = { id: 'test-model' }, pluginManager: unknown = null) {
  const engine = {
    currentModel: model, pluginManager,
    activityHub: { list: () => [{ id: 'run-1', lifecycleStatus: 'queued', status: 'running', startedAt: 10, artifacts: [{ path: '/outputs/report.md' }] }] },
    listAgents: () => [{ id: 'a', name: 'Agent A' }],
    getActivityStore: () => ({ list: () => [{ id: 'run-1', status: 'error', startedAt: 20 }] }),
  };
  return new Hono().route('/api', createTaskConsoleRoute(engine, { listPending: () => [{ id: 'approval-1', kind: 'tool_action_approval', sessionPath: '/session' }] }));
}

describe('task console projection', () => {
  it('retains real statuses and namespaces records instead of claiming dispatch success', async () => {
    const res = await app().request('/api/task-console');
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.runs.map((r: { id: string }) => r.id)).toEqual(['activity:run-1', 'workflow:run-1']);
    expect(result.runs.map((r: { status: string }) => r.status)).toEqual(['failed', 'queued']);
    expect(result.runs[1].artifacts).toEqual(['/outputs/report.md']);
    expect(result.approvals[0].id).toBe('approval-1');
    expect(result.runs[0].cost.state).toBe('unknown');
  });
  it('projects already-loaded company deliverables and acceptance failures without creating records', async () => {
    const service = { listCompanies: async () => [{ id: 'c' }], store: { listTasks: async () => [{ id: 'task', title: 'Candidate', status: 'blocked', acceptanceFailure: 'Tests failed', artifacts: ['patch.diff'], source: { runId: 'canvas-run' }, createdAt: '2026-10-16T00:00:00Z' }] } };
    const res = await app(null, { getPlugin: () => ({ ctx: { _company: { service } } }) }).request('/api/task-console');
    const { runs } = await res.json();
    expect(runs.find((r: { id: string }) => r.id === 'company:task')).toMatchObject({ status: 'blocked', summary: 'Tests failed', parentTaskId: 'canvas-run', artifacts: ['patch.diff'] });
  });
  it('routes workflow node artifacts to the child session instead of the parent', () => {
    expect(normalizeConsoleRun({ id: 'node', sessionPath: '/parent', childSessionPath: '/child' }, 'workflow').sessionPath).toBe('/child');
    expect(normalizeConsoleRun({ id: 'root', sessionPath: '/parent' }, 'workflow').sessionPath).toBe('/parent');
  });
  it('never substitutes zero for unknown cost, tokens, dates or state', () => {
    expect(normalizeConsoleRun({ id: 'empty' }, 'workflow')).toMatchObject({ status: 'unknown', tokens: null, startedAt: null, cost: { state: 'unknown' } });
  });
  it('keeps new aggregation and preflight owner-only in the HTTP boundary', () => {
    expect(classifyHttpRoute({ method: 'GET', path: '/api/task-console' }).kind).toBe('studio_owner');
    expect(classifyHttpRoute({ method: 'POST', path: '/api/task-console/preflight' }).kind).toBe('studio_owner');
    expect(classifyHttpRoute({ method: 'POST', path: '/api/task-console/execute' }).kind).toBe('studio_owner');
  });
});

describe('versioned draft-only templates', () => {
  it('has three immutable templates, all honestly mock-qualified', () => {
    expect(TASK_TEMPLATES).toHaveLength(3);
    for (const t of TASK_TEMPLATES) {
      expect(t.qualification).toBe('mock-only');
      expect(Object.isFrozen(t)).toBe(true);
      expect(Object.isFrozen(t.inputs)).toBe(true);
      expect(t.version).toBe('1.0.0');
      expect(buildTemplateDraft(t, {})).toContain(`${t.id}@${t.version}`);
    }
  });
  it('fails incomplete inputs and treats missing evidence as unknown', () => {
    const result = preflightTemplate(TASK_TEMPLATES[0], {});
    expect(result.ready).toBe(false);
    expect(result.checks[0].state).toBe('fail');
    expect(result.checks.slice(1).every(c => c.state === 'unknown')).toBe(true);
  });
  it('rejects unknown versions rather than silently upgrading', async () => {
    const res = await app().request('/api/task-console/preflight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: 'research-brief', version: '9' }) });
    expect(res.status).toBe(400);
  });
  it('uses configured model evidence but never launches from caller-supplied checks', async () => {
    const res = await app(null).request('/api/task-console/preflight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: 'research-brief', version: '1.0.0', inputs: { 主题: 'Testing', 范围: 'Local', 截止时间: 'Today' }, evidence: { model: 'pass', connectors: 'pass', directory: 'pass', budget: 'pass' } }) });
    const result = await res.json();
    expect(result.executionAllowed).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.checks.find((c: { id: string }) => c.id === 'model').state).toBe('fail');
    expect(result.draft).toContain('Testing');
  });
  it('validates weekly timezone and prepares only a draft', async () => {
    const res = await app().request('/api/task-console/preflight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: 'weekly-draft', version: '1.0.0', inputs: { 'IANA 时区': 'Mars/Olympus' } }) });
    const result = await res.json();
    expect(result.checks.find((c: { id: string }) => c.id === 'timezone').state).toBe('fail');
    expect(result.draft).toContain('此草稿不会创建计划');
  });
});

describe('template runtime diagnostics', () => {
  it('does not call unknown or absent pricing free', async () => {
    const { diagnoseTemplateRuntime } = await import('../server/routes/task-console-diagnostics.ts');
    const result = diagnoseTemplateRuntime({ currentModel: { id: 'unknown', input: ['text'] } }, { maxTokens: 1000, maxUsd: 1 });
    expect(result.budget).toMatchObject({ state: 'unknown', estimateUsd: null, pricing: 'unknown' });
    expect(result.model.liveQualification).toBe('not-run');
    expect(diagnoseTemplateRuntime({ currentModel: { id: 'unpriced', cost: { input: 0, output: 0 } } }, { maxTokens: 1000, maxUsd: 1 }).budget.estimateUsd).toBeNull();
    expect(diagnoseTemplateRuntime({}, null).budget.state).toBe('fail');
  });
  it('compares configured token price estimates with the budget and rejects invalid budgets', async () => {
    const { diagnoseTemplateRuntime } = await import('../server/routes/task-console-diagnostics.ts');
    const engine = { currentModel: { id: 'configured', input: ['text'], cost: { input: 2, output: 10 } } };
    expect(diagnoseTemplateRuntime(engine, { maxTokens: 100000, maxUsd: .5 }).budget).toMatchObject({ state: 'fail', estimateUsd: 1 });
    expect(diagnoseTemplateRuntime(engine, { maxTokens: 100000, maxUsd: 2 }).budget.state).toBe('pass');
    expect(diagnoseTemplateRuntime(engine, { maxTokens: -1, maxUsd: 2 }).budget.state).toBe('fail');
  });
});
