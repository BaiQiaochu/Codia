// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowJournal } from '../lib/workflow/journal.ts';
import { createWorkflowRecoveryRoute } from '../server/routes/workflow-recovery.ts';
import { createWorkflowTool } from '../lib/tools/workflow-tool.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-route-')); dirs.push(dir);
  const journal = new WorkflowJournal(path.join(dir, 'workflow-journals', 'run-1.jsonl'));
  journal.setMetadata({ runId: 'run-1', definitionKey: 'key', definition: { script: "export const meta = {name:'a',description:'b'}; return await agent('read', {access:'read'});", args: null, hasArgs: true, parentSessionPath: '/session' } });
  const route = createWorkflowRecoveryRoute({ listAgents: () => [{ id: 'a' }], getAgent: () => ({ agentDir: dir }) });
  return { route, journal, dir };
}
describe('workflow recovery routes', () => {
  it('prepares exact persisted parameters without executing and supports cancel', async () => {
    const { route, journal } = fixture();
    journal.record(1, 'read-key', null, 'error', { access: 'read' }); journal.finish();
    const inspect = await route.request('/workflow-recovery/run-1');
    expect(await inspect.json()).toMatchObject({ canPrepare: true, actions: [{ access: 'read', status: 'error' }] });
    const draft = await route.request('/workflow-recovery/run-1/draft', { method: 'POST' });
    const body = await draft.json();
    expect(body.draft).toContain('"resumeFromRunId": "run-1"');
    expect(body.draft).toContain('"args": null');
    expect(body.sessionPath).toBe('/session');
    expect((await route.request('/workflow-recovery/run-1/cancel', { method: 'POST' })).status).toBe(200);
    expect((await route.request('/workflow-recovery/run-1/draft', { method: 'POST' })).status).toBe(409);
    expect(WorkflowJournal.load(path.join(journal._path)).inspectRecovery().blockedReason).toMatch(/cancelled/);
  });
  it('shows unknown writes but never offers an executable recovery draft', async () => {
    const { route, journal } = fixture();
    journal.record(1, 'send-key', null, 'unknown', { access: 'write' }); journal.finish();
    expect(await (await route.request('/workflow-recovery/run-1')).json()).toMatchObject({ canPrepare: false, blockedReason: expect.stringMatching(/unknown external result/) });
    expect((await route.request('/workflow-recovery/run-1/draft', { method: 'POST' })).status).toBe(409);
  });
  it('does not follow journal symlinks', async () => {
    const { route, journal, dir } = fixture();
    fs.renameSync(journal._path, path.join(dir, 'private.jsonl'));
    fs.symlinkSync(path.join(dir, 'private.jsonl'), journal._path);
    expect(await (await route.request('/workflow-recovery/run-1')).json()).toMatchObject({ error: expect.stringMatching(/unsafe/) });
  });
});

it.each(['file', 'http'])('does not repeat a confirmed %s side effect after client timeout', async kind => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-effects-')); dirs.push(dir);
  let externalWrites = 0;
  const server = http.createServer((_req, res) => { externalWrites++; res.end('stored'); });
  if (kind === 'http') await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
  const file = path.join(dir, 'artifact.txt');
  const executeIsolated = vi.fn(async () => {
    if (kind === 'file') { fs.appendFileSync(file, 'artifact\n'); externalWrites++; }
    else { const address = server.address() as any; await fetch(`http://127.0.0.1:${address.port}/upload`, { method: 'POST', body: 'artifact' }); }
    throw new Error('client lost confirmation after external write');
  });
  try {
    const tool = createWorkflowTool({ executeIsolated, getJournalDir: () => path.join(dir, 'journals'), getDeferredStore: () => store });
    const script = "export const meta = {name:'side effect',description:'test'}; return await agent('save', {access:'write'});";
    const ctx = { sessionManager: { getSessionFile: () => '/session', getCwd: () => dir } };
    const first = await tool.execute('one', { script }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(store.fail).toHaveBeenCalled());
    const second = await tool.execute('two', { script, resumeFromRunId: first.details.runId }, undefined, undefined, ctx);
    expect(second.details.error).toMatch(/unknown external result/);
    expect(executeIsolated).toHaveBeenCalledTimes(1);
    expect(externalWrites).toBe(1);
    if (kind === 'file') expect(fs.readFileSync(file, 'utf8')).toBe('artifact\n');
  } finally { if (kind === 'http') await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('cancels only a workflow still owned by the live engine', async () => {
  const cancelRun = vi.fn(id => id === 'live');
  const route = createWorkflowRecoveryRoute({ listAgents: () => [{ id: 'a' }], getAgent: () => ({ workflowTool: { cancelRun } }) });
  expect((await route.request('/workflow-runs/live/cancel', { method: 'POST' })).status).toBe(200);
  expect((await route.request('/workflow-runs/old/cancel', { method: 'POST' })).status).toBe(409);
});
