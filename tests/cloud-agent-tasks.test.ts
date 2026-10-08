import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { normalizePrincipal } from '../core/security-principal.ts';
import { CloudWorkspaceStore } from '../lib/cloud-workspace/store.ts';
import { CloudWorkspaceService } from '../lib/cloud-workspace/service.ts';
import { CloudWorkspaceWorker } from '../lib/cloud-workspace/worker.ts';
import { CloudRecordService } from '../lib/cloud-workspace/records.ts';
import { CloudTaskService } from '../lib/cloud-workspace/agent-tasks.ts';
import { LocalObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { CodiaDocumentAgentExecutor } from '../lib/cloud-workspace/agent-executor.ts';
import { createCloudWorkspacesRoute } from '../server/routes/cloud-workspaces.ts';
const actor = { userId: 'owner', studioId: 'studio' }, other = { userId: 'another', studioId: 'studio' };
let root: string, store: CloudWorkspaceStore, service: CloudWorkspaceService, tasks: CloudTaskService;
const servers: http.Server[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-tool-tasks-')); store = new CloudWorkspaceStore(path.join(root, 'meta.db'));
  service = new CloudWorkspaceService(store, new LocalObjectStore(path.join(root, 'objects'))); tasks = new CloudTaskService(service);
});
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } store.close(); fs.rmSync(root, { recursive: true, force: true }); });
function app(scopes = ['files.read', 'files.write', 'chat'], owner = actor) {
  const a = new Hono(); a.use('*', async (c, next) => { (c as any).set('authPrincipal', normalizePrincipal({ ...owner, kind: 'account_user', credentialKind: 'user_session', connectionKind: 'cloud', scopes })); await next(); });
  a.route('/api', createCloudWorkspacesRoute(service)); return a;
}
const post = (a: Hono, url: string, body: unknown, method = 'POST') => a.request(`/api/cloud${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cloud-studio' }, body: JSON.stringify(body) });
type FixtureStep = { tool: string; args: Record<string, unknown> } | { text: string } | { wait: true };
async function modelFixture(steps: FixtureStep[]) {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push(JSON.parse(raw)); const step = steps[Math.min(requests.length - 1, steps.length - 1)];
    if ('wait' in step) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const tool = 'tool' in step;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] } : { role: 'assistant', content: step.text };
    for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 } }]) res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', ...chunk })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server);
  const model = { id: 'fixture-model', name: 'Synthetic local tool model', provider: 'openai', api: 'openai-completions', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 };
  const executor = new CodiaDocumentAgentExecutor({ resolve: async a => a.userId === actor.userId && a.studioId === actor.studioId ? { model, apiKey: 'synthetic-local-only-key' } : null }, { timeoutMs: 15000 });
  return { executor, requests };
}
async function setupPlan() {
  const workspace = store.createWorkspace(actor, 'Scoped tasks');
  const file = await service.upload(actor, workspace.id, 'selected.txt', Buffer.from('PINNED ORIGINAL CONTENT'));
  const plan = await tasks.create(actor, workspace.id, { title: 'Read selected file', instruction: 'Read the selected document and save result.txt.', inputVersions: [file.version.id], requestKey: 'make-plan-key' });
  return { workspace, file, plan };
}
async function waitFor(check: () => boolean) { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error('fixture_timeout'); await new Promise(r => setTimeout(r, 20)); } }

describe('capability-scoped durable Pi tool tasks', () => {
  it('runs actual SDK tool turns and commits exact pinned session/artifacts atomically; survives reopening', async () => {
    const { workspace, file, plan } = await setupPlan();
    await service.upload(actor, workspace.id, 'selected.txt', Buffer.from('LATER EDIT NEVER PASSED'), file.file.id, file.version.id);
    const fixture = await modelFixture([{ tool: 'list_cloud_files', args: {} }, { tool: 'read_cloud_file', args: { versionId: file.version.id } }, { tool: 'create_artifact', args: { name: 'result.txt', content: 'A bounded artifact from the pinned source.' } }, { text: 'Completed the pinned task.' }]);
    service.agentExecutor = fixture.executor;
    const run = await service.store.createRun(actor, workspace.id, plan.currentVersion, 'tool-task-run-key', 'agent-task');
    await new CloudWorkspaceWorker(service).tick();
    expect(store.run(actor, run.id).run).toMatchObject({ status: 'succeeded', attempt: 1 });
    store.close(); store = new CloudWorkspaceStore(path.join(root, 'meta.db')); service = new CloudWorkspaceService(store, service.objects, fixture.executor); tasks = new CloudTaskService(service);
    const session = await tasks.session(actor, run.id);
    expect(session.inputVersion).toBe(plan.currentVersion); expect(session.inputVersions).toEqual([file.version.id]);
    expect(session.finalText).toBe('Completed the pinned task.'); expect(session.artifacts).toHaveLength(1); expect(session.artifacts[0]).toMatchObject({ name: 'result.txt', content: 'A bounded artifact from the pinned source.' });
    expect(session.messages.filter(m => m.role === 'toolCall').map(m => m.toolName)).toEqual(['list_cloud_files', 'read_cloud_file', 'create_artifact']);
    expect(JSON.stringify(session)).toContain('PINNED ORIGINAL CONTENT'); expect(JSON.stringify(session)).not.toContain('LATER EDIT NEVER PASSED'); expect(JSON.stringify(session)).not.toContain('synthetic-local-only-key');
    expect(fixture.requests).toHaveLength(4);
    expect(fixture.requests[0].tools.map((t: any) => t.function.name)).toEqual(['list_cloud_files', 'read_cloud_file', 'create_artifact']);
    expect(store.run(actor, run.id).artifacts[0].name).toContain('.json');
    await expect(tasks.session(other, run.id)).rejects.toThrow('not_found');
  }, 20000);
  it('denies unselected versions and unknown legacy tools without any host or cloud mutation', async () => {
    const { workspace, plan } = await setupPlan();
    const privateFile = await service.upload(actor, workspace.id, 'unselected.txt', Buffer.from('NOT SELECTED SECRET'));
    const fixture = await modelFixture([{ tool: 'read_cloud_file', args: { versionId: privateFile.version.id } }, { tool: 'bash', args: { command: 'touch /tmp/should-never-execute' } }, { tool: 'create_artifact', args: { name: '../escape.txt', content: 'bad' } }, { tool: 'create_artifact', args: { name: 'folder\\escape.txt', content: 'bad' } }, { text: 'The requested tools were rejected.' }]);
    service.agentExecutor = fixture.executor;
    const run = await service.store.createRun(actor, workspace.id, plan.currentVersion, 'denied-tool-run', 'agent-task'); await new CloudWorkspaceWorker(service).tick();
    const session = await tasks.session(actor, run.id); expect(session.artifacts).toEqual([]); expect(session.messages.filter(m => m.isError)).toHaveLength(4);
    expect(JSON.stringify(session)).not.toContain('NOT SELECTED SECRET'); expect(store.listFiles(actor, workspace.id)).toHaveLength(4);
  }, 20000);
  it('cancels a running child after staged tool output without publishing artifacts or reviving the lease', async () => {
    const { workspace, plan } = await setupPlan();
    const fixture = await modelFixture([{ tool: 'create_artifact', args: { name: 'not-committed.txt', content: 'Never externally visible' } }, { wait: true }]); service.agentExecutor = fixture.executor;
    const run = await service.store.createRun(actor, workspace.id, plan.currentVersion, 'cancel-tool-run', 'agent-task'); const worker = new CloudWorkspaceWorker(service); const pending = worker.tick();
    await waitFor(() => fixture.requests.length === 2); await expect(service.store.cancelRun(other, run.id)).rejects.toThrow('not_found');
    const cancelled = await service.store.cancelRun(actor, run.id); expect(cancelled).toMatchObject({ status: 'failed', error: 'cancelled' });
    await pending; expect(store.run(actor, run.id).artifacts).toEqual([]); expect(store.listFiles(actor, workspace.id)).toHaveLength(2);
    expect(await service.store.cancelRun(actor, run.id)).toMatchObject({ error: 'cancelled' }); expect(await service.store.claim()).toBeNull();
  }, 20000);
  it('bounds endlessly repeating model tool calls and publishes no partial artifact', async () => {
    const { workspace, plan } = await setupPlan(); const fixture = await modelFixture([{ tool: 'list_cloud_files', args: {} }]); service.agentExecutor = fixture.executor;
    const run = await service.store.createRun(actor, workspace.id, plan.currentVersion, 'bounded-tool-run', 'agent-task'); await new CloudWorkspaceWorker(service).tick();
    expect(store.run(actor, run.id).run.status).toBe('failed'); expect(fixture.requests.length).toBeLessThanOrEqual(12); expect(store.run(actor, run.id).artifacts).toEqual([]);
  }, 20000);
  it('rejects extra output metadata, wrong workflow provenance and invalid nested artifact data', async () => {
    const { workspace, plan } = await setupPlan();
    const changes = [
      { apiKey: 'unexpected-sensitive-diagnostic' }, { sourceWorkflowVersion: '00000000-0000-0000-0000-000000000001' },
      { messages: [{ role: 'assistant', text: 'answer', isError: 'false' }] },
      { artifacts: [{ id: 'artifact-1', name: 'fine.txt', content: 'text', size: 4, sha256: 'wrong' }] },
      { artifacts: [{ id: 'artifact-1', name: '../bad.txt', content: '', size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }] },
      { messages: [{ role: 'assistant', text: 'answer', headers: { authorization: 'bad' } }] },
    ];
    for (const [index, change] of changes.entries()) {
      service.agentExecutor = { availability: async () => ({ available: true }), execute: async run => Buffer.from(JSON.stringify({ schemaVersion: 1, runId: run.id, attempt: run.attempt, inputVersion: run.input_version, finalText: 'answer', inputVersions: plan.inputVersions, messages: [], artifacts: [], ...change })) };
      const run = await service.store.createRun(actor, workspace.id, plan.currentVersion, `invalid-bundle-${index}`, 'agent-task'); await new CloudWorkspaceWorker(service).tick();
      expect(store.run(actor, run.id).run).toMatchObject({ status: 'failed', error: 'task_output_invalid' }); expect(store.run(actor, run.id).artifacts).toEqual([]);
    }
  });
  it('rejects forged child output before object publication', async () => {
    const { workspace, plan } = await setupPlan(); service.agentExecutor = { availability: async () => ({ available: true }), execute: async () => Buffer.from('{"schemaVersion":1,"runId":"wrong-run"}') };
    const run = await service.store.createRun(actor, workspace.id, plan.currentVersion, 'forged-task-output', 'agent-task'); await new CloudWorkspaceWorker(service).tick();
    expect(store.run(actor, run.id).run).toMatchObject({ status: 'failed', error: 'task_output_invalid' }); expect(store.run(actor, run.id).artifacts).toEqual([]);
  });
});

describe('task plans, workflow conversion and schedule API authorization', () => {
  it('creates idempotent plans and denies other workspaces even for the same actor', async () => {
    const { workspace, file, plan } = await setupPlan(); const input = { title: plan.title, instruction: plan.instruction, inputVersions: [file.version.id], requestKey: 'make-plan-key' };
    expect((await tasks.create(actor, workspace.id, input)).id).toBe(plan.id);
    await expect(tasks.create(actor, workspace.id, { ...input, instruction: 'changed' })).rejects.toThrow('idempotency_conflict');
    const otherWorkspace = store.createWorkspace(actor, 'Same owner, other workspace');
    await expect(tasks.create(actor, otherWorkspace.id, input)).rejects.toThrow('not_found');
    await expect(tasks.create(other, workspace.id, input)).rejects.toThrow('not_found');
    const binary = await service.upload(actor, workspace.id, 'bad.bin', Buffer.from([0, 255]));
    await expect(tasks.create(actor, workspace.id, { ...input, requestKey: 'binary-plan-key', inputVersions: [binary.version.id] })).rejects.toThrow('unsupported_document');
    const large = await service.upload(actor, workspace.id, 'large.txt', Buffer.alloc(128 * 1024, 97));
    await expect(tasks.create(actor, workspace.id, { ...input, requestKey: 'large-plan-key', inputVersions: [large.version.id] })).rejects.toThrow('agent_input_too_large');
  });
  it('skips corrupt task-plan files without hiding valid plans', async () => {
    const { workspace, plan } = await setupPlan();
    await service.upload(actor, workspace.id, `task-plan-${'a'.repeat(64)}.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, type: 'cloud-agent-task', title: '../bad', instruction: 'no', inputVersions: [], createdAt: new Date().toISOString() })));
    expect((await tasks.list(actor, workspace.id)).map(p => p.id)).toEqual([plan.id]);
  });
  it('converts an exact saved workflow instruction without replaying arbitrary legacy step code', async () => {
    const workspace = store.createWorkspace(actor, 'Draft conversion'); const records = new CloudRecordService(service);
    const workflow = await records.create(actor, workspace.id, 'workflow', 'Old draft', { instruction: 'Review the selected evidence', steps: [{ code: 'arbitrary legacy script is inert' }], enabled: true });
    const plan = await tasks.create(actor, workspace.id, { title: 'Approved bounded conversion', sourceWorkflowVersion: workflow.currentVersion, requestKey: 'workflow-convert-key' });
    await records.update(actor, workflow.id, workflow.currentVersion, { instruction: 'Newer unscheduled draft' });
    expect(plan.instruction).toBe('Review the selected evidence'); expect(plan.sourceWorkflowVersion).toBe(workflow.currentVersion); expect(store.listRuns(actor, workspace.id)).toEqual([]); expect(await service.store.listSchedules(actor, workspace.id)).toEqual([]);
    const bytes = (await service.read(actor, plan.currentVersion)).bytes.toString(); expect(bytes).not.toContain('arbitrary legacy script'); expect(bytes).not.toContain('enabled');
  });
  it('requires chat/model to start or enable AI, permits inert drafts and fixed schedules, and scopes cancellation/session reads', async () => {
    const { workspace, file, plan } = await setupPlan(); const filesOnly = app(['files.read', 'files.write']);
    service.agentExecutor = { availability: async () => ({ available: true }), execute: async () => Buffer.from('unused') };
    expect((await post(filesOnly, `/workspaces/${workspace.id}/runs`, { operation: 'agent-task', inputVersion: plan.currentVersion, requestKey: 'route-task-run' })).status).toBe(403);
    const scheduleBody = { name: 'Paused AI', inputVersion: plan.currentVersion, operation: 'agent-task', requestKey: 'route-ai-schedule', firstRunAt: Date.now() + 60000, intervalMs: null, enabled: false };
    const paused = await post(filesOnly, `/workspaces/${workspace.id}/schedules`, scheduleBody); expect(paused.status).toBe(201); const { schedule } = await paused.json();
    expect((await post(filesOnly, `/schedules/${schedule.id}`, { expectedRevision: schedule.revision, enabled: true }, 'PUT')).status).toBe(403);
    expect((await post(filesOnly, `/workspaces/${workspace.id}/schedules`, { ...scheduleBody, requestKey: 'fixed-schedule-key', name: 'Fixed process', operation: 'document-summary', inputVersion: file.version.id, enabled: true })).status).toBe(201);
    const response = await post(app(), `/workspaces/${workspace.id}/runs`, { operation: 'agent-task', inputVersion: plan.currentVersion, requestKey: 'route-task-run' }); expect(response.status).toBe(202); const { run } = await response.json();
    expect((await post(app(undefined, other), `/runs/${run.id}/cancel`, {})).status).toBe(404);
    expect((await post(app(), `/runs/${run.id}/cancel`, {})).status).toBe(200);
    expect((await app(undefined, other).request(`/api/cloud/runs/${run.id}/task-session`)).status).toBe(404);
    expect((await post(app(), `/workspaces/${workspace.id}/runs`, { operation: 'agent-task', inputVersion: file.version.id, requestKey: 'not-a-plan-run' })).status).toBe(400);
  });
});
