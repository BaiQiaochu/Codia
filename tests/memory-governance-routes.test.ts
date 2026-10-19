import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createConfigRoute } from '../server/routes/config.ts';
import { FactStore } from '../lib/memory/fact-store.ts';
import { openExperienceStore } from '../lib/experience-store.ts';
import { classifyHttpRoute } from '../server/http/route-security.ts';

describe('memory governance routes', () => {
  let dir: string, agent: any, engine: any, app: Hono, principal: any;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-governance-'));
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    agent = { id: 'alpha', agentDir: dir, memoryMdPath: path.join(dir, 'memory/memory.md'), summariesDir: path.join(dir, 'memory/summaries'), factStore: new FactStore(path.join(dir, 'memory/facts.db')), summaryManager: { clearCache: vi.fn() } };
    engine = { config: {}, getAgent: (id: string) => id === 'alpha' ? agent : null, updateConfig: vi.fn().mockResolvedValue(undefined) };
    principal = { kind: 'account_user', principalId: 'user:owner', scopes: ['settings.read', 'settings.write'] };
    app = new Hono();
    app.use('*', async (c, next) => { c.set('authPrincipal' as never, principal); await next(); });
    app.route('/api', createConfigRoute(engine));
  });
  afterEach(() => { agent.factStore.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = async (url: string, body: unknown, method = 'POST') => app.request(`/api/memories${url}?agentId=alpha`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const candidate = () => {
    const store = openExperienceStore(dir);
    try { return store.createCandidate({ category: 'Build', content: 'Read lockfile', sourceRefs: [{ type: 'run', id: 'run-source' }], applicability: { scope: 'project', projectId: 'repo-alpha', platform: 'linux' } }).entry; }
    finally { store.close(); }
  };
  const review = (revision: number) => ({ expectedRevision: revision, confirmed: true, eventId: 'review-1', runId: 'run-actual', evidenceRef: 'tests:actual', summary: 'Test report confirms success', outcome: 'success', environment: { projectId: 'repo-alpha', platform: 'linux' }, reviewerId: 'forged-user' });

  it('uses existing settings scopes for all new routes', () => {
    for (const suffix of ['/experiences', '/extractions']) expect(classifyHttpRoute({ method: 'GET', path: `/api/memories${suffix}` })).toEqual({ kind: 'scope', scope: 'settings.read' });
    for (const [method, suffix] of [['PATCH', '/experiences/e1'], ['POST', '/experiences/e1/review'], ['POST', '/extractions/retry']]) expect(classifyHttpRoute({ method, path: `/api/memories${suffix}` })).toEqual({ kind: 'scope', scope: 'settings.write' });
  });
  it('requires read and write scope, and rejects unknown agents', async () => {
    principal.scopes = [];
    expect((await app.request('/api/memories/experiences?agentId=alpha')).status).toBe(403);
    expect((await send('/experiences/e1', { expectedRevision: 1, state: 'enabled' }, 'PATCH')).status).toBe(403);
    principal.scopes = ['settings.read'];
    expect((await app.request('/api/memories/experiences?agentId=missing')).status).toBe(404);
  });
  it('never enables a candidate without reviewed evidence and a separate validation', async () => {
    const entry = candidate();
    expect((await send(`/experiences/${entry.id}`, { expectedRevision: 1, state: 'enabled' }, 'PATCH')).status).toBe(400);
    expect((await send(`/experiences/${entry.id}`, { expectedRevision: 1, state: 'validated' }, 'PATCH')).status).toBe(400);
    const reviewed = await (await send(`/experiences/${entry.id}/review`, review(1))).json();
    expect(reviewed.entry.state).toBe('candidate');
    expect(reviewed.entry.stats.verifiedSuccess).toBe(1);
    expect(reviewed.entry.evidence[0].reviewerId).toBe('user:owner');
    const validated = await (await send(`/experiences/${entry.id}`, { expectedRevision: reviewed.entry.revision, state: 'validated' }, 'PATCH')).json();
    const enabled = await send(`/experiences/${entry.id}`, { expectedRevision: validated.entry.revision, state: 'enabled' }, 'PATCH');
    expect(enabled.status).toBe(200); expect((await enabled.json()).entry.state).toBe('enabled');
  });
  it('review is idempotent and cannot be forged by model principals or unconfirmed requests', async () => {
    const entry = candidate();
    principal.kind = 'agent';
    expect((await send(`/experiences/${entry.id}/review`, review(1))).status).toBe(403);
    principal.kind = 'account_user';
    expect((await send(`/experiences/${entry.id}/review`, { ...review(1), confirmed: false })).status).toBe(400);
    expect((await send(`/experiences/${entry.id}/review`, { ...review(1), environment: { projectId: 'other', platform: 'linux' } })).status).toBe(400);
    expect((await send(`/experiences/${entry.id}/review`, review(1))).status).toBe(200);
    const retried = await (await send(`/experiences/${entry.id}/review`, review(1))).json();
    expect(retried.entry.stats.verifiedSuccess).toBe(1); expect(retried.entry.evidence).toHaveLength(1);
  });
  it('unknown outcome cannot validate a candidate', async () => {
    const entry = candidate();
    const result = await (await send(`/experiences/${entry.id}/review`, { ...review(1), outcome: 'unknown' })).json();
    expect(result.entry.stats.unknown).toBe(1); expect(result.entry.stats.verifiedSuccess).toBe(0);
    expect((await send(`/experiences/${entry.id}`, { expectedRevision: result.entry.revision, state: 'validated' }, 'PATCH')).status).toBe(400);
  });
  it('returns current revision on stale writes, and scope corrections require new validation', async () => {
    const entry = candidate();
    const reviewed = await (await send(`/experiences/${entry.id}/review`, review(1))).json();
    const stale = await send(`/experiences/${entry.id}`, { expectedRevision: 1, state: 'validated' }, 'PATCH');
    expect(stale.status).toBe(409); expect((await stale.json()).current.revision).toBe(reviewed.entry.revision);
    const revised = await (await send(`/experiences/${entry.id}`, { expectedRevision: reviewed.entry.revision, patch: { content: 'Corrected method', applicability: { scope: 'project', projectId: 'other', platform: 'linux' } } }, 'PATCH')).json();
    expect(revised.entry.state).toBe('candidate');
    expect((await send(`/experiences/${entry.id}`, { expectedRevision: revised.entry.revision, state: 'validated' }, 'PATCH')).status).toBe(400);
    expect((await send(`/experiences/${entry.id}`, { expectedRevision: revised.entry.revision, patch: { state: 'enabled' } }, 'PATCH')).status).toBe(400);
  });
  it('clears compiled and editable artifacts and awaits prompt refresh before acknowledging correction', async () => {
    agent.factStore.add({ fact: 'Old fact', source: 'session:s1' });
    const item = agent.factStore.getAll()[0];
    for (const file of ['memory.md', 'facts.md', 'editable-facts.md']) fs.writeFileSync(path.join(dir, 'memory', file), 'Old fact');
    let release!: () => void;
    engine.updateConfig.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let completed = false;
    const request = send(`/${item.id}`, { expectedRevision: item.revision, fact: 'New fact', status: 'active' }, 'PATCH').then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(engine.updateConfig).toHaveBeenCalled());
    expect(completed).toBe(false);
    for (const file of ['memory.md', 'facts.md', 'editable-facts.md']) expect(fs.readFileSync(path.join(dir, 'memory', file), 'utf8')).toBe('');
    release(); expect((await request).status).toBe(200);
    expect(agent.factStore.getById(item.id).fact).toBe('New fact');
  });
  it('exposes failed extraction records and requeues without claiming success', async () => {
    const claim = agent.factStore.beginExtraction('job-1', { sessionId: 'session-failed', sourceRevision: 'r1', extractorVersion: 'v1' });
    agent.factStore.failExtraction('job-1', new Error('invalid model JSON'), claim, { maxAttempts: 1 });
    const jobs = await (await app.request('/api/memories/extractions?agentId=alpha')).json();
    expect(jobs.jobs[0]).toMatchObject({ key: 'job-1', status: 'quarantined', attempts: 1, error: 'invalid model JSON' });
    const retried = await send('/extractions/retry', { key: 'job-1' });
    expect(retried.status).toBe(200);
    expect((await retried.json()).jobs[0]).toMatchObject({ status: 'failed', attempts: 0, error: null });
    expect((await send('/extractions/retry', { key: 'missing' })).status).toBe(404);
    const completedClaim = agent.factStore.beginExtraction('job-2', { sessionId: 'session-ok', sourceRevision: 'r1', extractorVersion: 'v1' });
    agent.factStore.commitExtraction('job-2', [], completedClaim);
    expect((await send('/extractions/retry', { key: 'job-2' })).status).toBe(409);
    principal.scopes = ['settings.read'];
    expect((await send('/extractions/retry', { key: 'job-1' })).status).toBe(403);
  });
  it('protects stale deletion and validates scope and expiry before mutation', async () => {
    agent.factStore.add({ fact: 'Keep current fact' });
    const item = agent.factStore.getAll()[0];
    expect((await send(`/${item.id}`, { expectedRevision: item.revision + 1 }, 'DELETE')).status).toBe(409);
    for (const patch of [{ scope: 'project', projectId: '' }, { expiresAt: 'not-a-date' }, { status: 'deleted' }]) {
      expect((await send(`/${item.id}`, { expectedRevision: item.revision, ...patch }, 'PATCH')).status).toBe(400);
    }
    expect(agent.factStore.getById(item.id).fact).toBe('Keep current fact');
    expect((await send(`/${item.id}`, { expectedRevision: item.revision }, 'DELETE')).status).toBe(200);
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: 'alpha' });
  });
});
