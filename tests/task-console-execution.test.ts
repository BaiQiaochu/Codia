import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTaskConsoleRoute } from '../server/routes/task-console.ts';
import { createWorkflowTool } from '../lib/tools/workflow-tool.ts';
import { installRunBudgetStreamGuard } from '../lib/workflow/run-budget-stream.ts';
import { ActivityHub } from '../lib/activity-hub.ts';
import { TASK_TEMPLATES } from '../shared/task-console/templates.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function fixture(options: { unknownUsage?: boolean; qualification?: string; delayMs?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-template-execution-')); dirs.push(root);
  const hub = new ActivityHub();
  const model = { id: 'model', provider: 'fixture', api: 'openai-completions', contextWindow: 1000, maxTokens: 256, toolCalling: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 1 } };
  const store = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
  const calls: any[] = [];
  const execute = vi.fn(async (prompt: string, opts: any) => {
    calls.push({ prompt, opts });
    const output = `Verified fixture step ${calls.length}`;
    const session: any = { agent: { streamFn: async (_model: any, _context: any, request: any) => {
      await request.onPayload({ max_completion_tokens: 9000 }, model);
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      return (async function* () { yield { type: 'done', reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: output }], stopReason: 'stop', usage: options.unknownUsage ? undefined : { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } } }; })();
    } } };
    installRunBudgetStreamGuard(session, opts.runBudget);
    for await (const event of await session.agent.streamFn(opts.model, { messages: [] }, { signal: opts.signal })) {
      if (event.type === 'error') return { error: event.error.errorMessage, replyText: '' };
    }
    fs.writeFileSync(path.join(root, `step-${calls.length}.md`), output);
    return { error: null, replyText: output };
  });
  const workflow = createWorkflowTool({ executeIsolated: execute, getAgentId: () => 'a', getDeferredStore: () => store, getActivityHub: () => hub, getJournalDir: () => path.join(root, 'journals'), getWorkflowSessionDir: () => path.join(root, 'sessions') });
  const engine = { currentModel: model, currentSessionPath: path.join(root, 'parent.jsonl'), activityHub: hub,
    listAgents: () => [], getSessionFolderScope: () => ({ sandboxFolders: [root] }),
    agent: { id: 'a', agentDir: root, config: {}, tools: ['read', 'write', 'edit', 'bash', 'web_search', 'web_fetch'].map(name => ({ name })), workflowTool: workflow } };
  const qualification = { inspect: vi.fn(() => ({ state: options.qualification || 'pass', reason: 'deterministic fixture', fingerprint: 'test-only' })) };
  const app = new Hono().route('/api', createTaskConsoleRoute(engine, { listPending: () => [] }, { qualificationService: qualification }));
  const request = (templateId = 'research-brief', overrides: any = {}) => {
    const template = TASK_TEMPLATES.find(item => item.id === templateId)!;
    return { templateId, version: template.version, workspace: root,
      inputs: Object.fromEntries(template.inputs.map(key => [key, key === '项目目录' ? root : key === 'IANA 时区' ? 'UTC' : 'Fixture input'])),
      budget: { maxTokens: 3000, maxUsd: 1, maxSteps: 4, maxDurationMs: 10000, maxOutputTokensPerCall: 64, maxModelCalls: 16 },
      requestId: `request-${templateId}`, confirmExperimental: true, ...overrides };
  };
  const post = (body: any, endpoint = 'execute') => app.request(`/api/task-console/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { root, app, model, engine, store, hub, execute, calls, request, post, qualification };
}

describe('template execution through the existing workflow engine', () => {
  it.each(['research-brief', 'repository-check', 'weekly-draft'])('runs %s serially with bounded calls and persists actual results', async templateId => {
    const f = fixture(); const input = f.request(templateId);
    const preflight = await f.post(input, 'preflight');
    expect((await preflight.json()).executionAllowed).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
    const response = await f.post(input); expect(response.status).toBe(202);
    const result = await response.json();
    expect(result).toMatchObject({ qualification: 'mock-only', status: 'running', version: '1.0.0' });
    await vi.waitFor(() => expect(f.store.resolve).toHaveBeenCalledOnce());
    expect(f.store.fail).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(4);
    expect(fs.readFileSync(path.join(f.root, 'step-4.md'), 'utf8')).toBe('Verified fixture step 4');
    expect(f.hub.get(result.runId)).toMatchObject({ lifecycleStatus: 'succeeded', runBudget: { calls: 4, committedTokens: 440, reservedTokens: 0, providerInvoiceHardCap: false } });
    expect(f.calls[0].opts).toMatchObject({ cwd: f.root, workspaceFolders: [f.root], authorizedFolders: [], forceLocalRuntime: true, model: f.model });
    expect(f.calls[1].prompt).toContain('Verified fixture step 1');
    const snapshot = await (await f.app.request('/api/task-console')).json();
    expect(snapshot.runs.find((run: any) => run.sourceId === result.runId).budget.committedTokens).toBe(440);
  });
  it('deduplicates concurrent launch requests and rejects changed payload under the same request ID', async () => {
    const f = fixture(); const body = f.request();
    const responses = await Promise.all([f.post(body), f.post(body)]);
    const results = await Promise.all(responses.map(response => response.json()));
    expect(results[0].runId).toBe(results[1].runId); expect(f.store.defer).toHaveBeenCalledOnce();
    expect((await f.post({ ...body, inputs: { ...body.inputs, 主题: 'Changed' } })).status).toBe(409);
    await vi.waitFor(() => expect(f.store.resolve).toHaveBeenCalledOnce());
  });
  it('replays the original run after rebuilding the route instead of dispatching again', async () => {
    const f = fixture(); const body = f.request(); const original = await (await f.post(body)).json();
    await vi.waitFor(() => expect(f.store.resolve).toHaveBeenCalledOnce());
    const restarted = new Hono().route('/api', createTaskConsoleRoute(f.engine, { listPending: () => [] }, { qualificationService: f.qualification }));
    const response = await restarted.request('/api/task-console/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(202); expect((await response.json()).runId).toBe(original.runId);
    expect(f.store.defer).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledTimes(4);
  });
  it('keeps a lost-acknowledgment launch claim blocked across restart', async () => {
    const f = fixture(); const body = f.request();
    const { TemplateLaunchAdmissions } = await import('../server/routes/task-console-admissions.ts');
    const { createHash } = await import('node:crypto');
    const fingerprint = createHash('sha256').update(JSON.stringify([body.templateId, body.version, body.inputs, body.workspace, body.connectorTools, body.budget, f.engine.currentSessionPath, f.engine.agent.id])).digest('hex');
    new TemplateLaunchAdmissions(f.root).claim(body.requestId, fingerprint);
    const response = await f.post(body);
    expect(response.status).toBe(409); expect((await response.json()).error).toBe('template_launch_result_unknown');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.store.defer).not.toHaveBeenCalled();
  });
  it('does not duplicate an already-dispatched workflow when acknowledgment persistence fails', async () => {
    const f = fixture(); const body = f.request();
    const { TemplateLaunchAdmissions } = await import('../server/routes/task-console-admissions.ts');
    const persistence = vi.spyOn(TemplateLaunchAdmissions.prototype, 'complete').mockImplementationOnce(() => { throw new Error('simulated acknowledgment loss'); });
    const first = await f.post(body); expect(first.status).toBe(500); persistence.mockRestore();
    await vi.waitFor(() => expect(f.store.resolve).toHaveBeenCalledOnce());
    const restarted = new Hono().route('/api', createTaskConsoleRoute(f.engine, { listPending: () => [] }, { qualificationService: f.qualification }));
    const retry = await restarted.request('/api/task-console/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(retry.status).toBe(409); expect((await retry.json()).error).toBe('template_launch_result_unknown');
    expect(f.store.defer).toHaveBeenCalledOnce();
  });
  it('blocks forged qualification, unknown prices and missing explicit launch without dispatch', async () => {
    const f = fixture({ qualification: 'unknown' });
    expect((await f.post({ ...f.request(), ready: true, executionAllowed: true, evidence: { model: 'pass' } })).status).toBe(409);
    expect((await f.post(f.request('research-brief', { requestId: 'missing-explicit', confirmExperimental: false }))).status).toBe(400);
    f.qualification.inspect.mockReturnValue({ state: 'pass', reason: 'test', fingerprint: 'test-only' });
    f.engine.currentModel.cost.input = 0; f.engine.currentModel.cost.output = 0;
    expect((await f.post(f.request('research-brief', { requestId: 'unknown-prices' }))).status).toBe(409);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('stops dispatch after step budget exhaustion and never reports success', async () => {
    const f = fixture(); const body = f.request(); body.budget.maxSteps = 1;
    const result = await (await f.post(body)).json();
    await vi.waitFor(() => expect(f.store.fail).toHaveBeenCalledOnce());
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.store.resolve).not.toHaveBeenCalled();
    expect(f.hub.get(result.runId).lifecycleStatus).toBe('failed');
  });
  it('unknown provider usage retains cost reservation and halts the plan', async () => {
    const f = fixture({ unknownUsage: true }); const result = await (await f.post(f.request())).json();
    await vi.waitFor(() => expect(f.store.fail).toHaveBeenCalledOnce());
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.store.resolve).not.toHaveBeenCalled();
    expect(f.hub.get(result.runId).runBudget).toMatchObject({ state: 'blocked', committedTokens: 0, reservedTokens: 1064 });
  });
  it('deadline abort stops later steps and prevents completed status', async () => {
    const f = fixture({ delayMs: 100 }); const body = f.request(); body.budget.maxDurationMs = 30;
    const result = await (await f.post(body)).json();
    await vi.waitFor(() => expect(f.store.fail).toHaveBeenCalledOnce());
    expect(f.store.resolve).not.toHaveBeenCalled(); expect(f.execute.mock.calls.length).toBeLessThanOrEqual(1);
    expect(f.hub.get(result.runId).lifecycleStatus).toBe('failed');
    await new Promise(resolve => setTimeout(resolve, 120));
  });
  it('does not permit the injected qualification seam in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createTaskConsoleRoute({}, {}, { qualificationService: { inspect: () => ({ state: 'pass' }) } })).toThrow(/forbidden/);
  });
});
