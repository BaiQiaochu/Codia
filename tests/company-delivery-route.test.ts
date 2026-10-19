import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskConsoleRoute } from '../server/routes/task-console.ts';
import { createCompanyService } from '../plugins/company/lib/company-service.ts';
import { ResourceService } from '../core/resource-service.ts';
import { ResourceAccessService } from '../core/resource-access-service.ts';
import { SessionFileRegistry } from '../lib/session-files/session-file-registry.ts';
import { classifyHttpRoute } from '../server/http/route-security.ts';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
async function setup(deny = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-')); dirs.push(home);
  const agentsDir = path.join(home, 'agents'); const sessionPath = path.join(agentsDir, 'a', 'sessions', 'a.jsonl');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true }); fs.writeFileSync(sessionPath, '{}\n');
  const filePath = path.join(home, 'result.txt'); fs.writeFileSync(filePath, 'first result');
  const registry = new SessionFileRegistry(); const file = registry.registerFile({ sessionPath, filePath });
  const runtime = { studioId: 's', userId: 'u', connectionKind: 'local', credentialKind: 'loopback_token' };
  const resourceService = new ResourceService({ agentsDir, sessionFiles: registry, runtimeContext: runtime });
  const resourceAccess = new ResourceAccessService({ resourceService, ...(deny ? { authorizeCapability: () => ({ allowed: false }) } : {}) });
  const service = createCompanyService({ dataDir: path.join(home, 'company') });
  await service.store.addTasks([{ id: 't', companyId: 'c', status: 'reported', title: 'Test', report: 'result', sessionPath, acceptanceCriteria: ['accurate'], acceptanceResults: [{ criterion: 'accurate', passed: true, evidence: file.id }], artifacts: [{ fileId: file.id }] }]);
  const engine = { codiaHome: home, agentsDir, listAgents: () => [], getRuntimeContext: () => runtime, getResourceAccessService: () => resourceAccess,
    getSessionFile: (id: string, options: any) => registry.get(id, options), listSessionFiles: (p: string) => registry.list(p),
    pluginManager: { getPlugin: () => ({ ctx: { _company: { service } } }) } };
  const app = new Hono().route('/api', createTaskConsoleRoute(engine, { listPending: () => [] }));
  const get = () => app.request('/api/task-console/company/t/delivery');
  const review = (version: string, verdict = 'pass') => app.request('/api/task-console/company/t/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, items: [{ criterion: 'accurate', verdict, note: 'Checked the file' }] }) });
  return { app, service, file, filePath, get, review, sessionPath, home, registry, resourceAccess };
}
describe('owner-only team delivery review', () => {
  it('separates self-report and manual review, binds review to exact content, and invalidates after changes', async () => {
    const x = await setup(); const first = await (await x.get()).json();
    expect(first.review.state).toBe('unreviewed'); expect(first.artifacts[0].state).toBe('available');
    expect(first.artifacts[0].resource.links.content).toContain('/api/resources/');
    expect(first.criteria[0].selfReport.passed).toBe(true);
    expect((await x.review(first.version)).status).toBe(200);
    expect((await (await x.get()).json()).review.state).toBe('current');
    fs.writeFileSync(x.filePath, 'different result');
    const changed = await (await x.get()).json();
    expect(changed.review.state).toBe('stale'); expect(changed.version).not.toBe(first.version);
    expect((await x.review(first.version)).status).toBe(409);
    expect((await x.service.store.listTasks())[0].status).toBe('reported');
  });
  it('invalidates stale review when a report/criterion changes and rejects stale writes', async () => {
    const x = await setup(); const first = await (await x.get()).json(); await x.review(first.version);
    await x.service.store.updateTask('t', { report: 'new report' });
    expect((await (await x.get()).json()).review.state).toBe('stale');
    expect((await x.review(first.version)).status).toBe(409);
  });
  it('does not publish unavailable resources or accept success review for inaccessible artifacts', async () => {
    const x = await setup(true); const body = await (await x.get()).json();
    expect(body.artifacts[0].state).toBe('forbidden'); expect(body.artifacts[0].resource).toBeUndefined();
    expect((await x.review(body.version)).status).toBe(409);
    expect((await x.review(body.version, 'fail')).status).toBe(200);
  });
  it('labels missing/unregistered references clearly without opening arbitrary paths', async () => {
    const x = await setup(); fs.unlinkSync(x.filePath);
    await x.service.store.updateTask('t', { artifacts: [{ fileId: x.file.id }, { path: '/etc/passwd' }, { url: 'https://example.com/private' }] });
    const body = await (await x.get()).json(); expect(body.artifacts.map((a: any) => a.state)).toEqual(['missing', 'unregistered', 'unregistered']);
    expect(body.artifacts.every((a: any) => !a.resource?.links?.content)).toBe(true);
    expect((await x.review(body.version)).status).toBe(409);
  });
  it('does not expose review API to agent/ordinary delegated tool routes', () => {
    expect(classifyHttpRoute({ method: 'POST', path: '/api/task-console/company/t/review' }).kind).toBe('studio_owner');
  });
});
it('invalidates approval even if content changes with the same size and restored mtime', async () => {
  const x = await setup(); const beforeStat = fs.statSync(x.filePath); const first = await (await x.get()).json(); await x.review(first.version);
  fs.writeFileSync(x.filePath, 'other result'); fs.utimesSync(x.filePath, beforeStat.atime, beforeStat.mtime);
  expect(fs.statSync(x.filePath).size).toBe(beforeStat.size);
  expect((await (await x.get()).json()).review.state).toBe('stale');
});
it('rejects incomplete or forged review evidence and does not accept a client reviewer identity', async () => {
  const x = await setup(); const first = await (await x.get()).json();
  const res = await x.app.request('/api/task-console/company/t/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: first.version, reviewedBy: 'somebody-else', items: [{ criterion: 'accurate', verdict: 'pass', note: '' }] }) });
  expect(res.status).toBe(400); expect((await x.service.store.listTasks())[0].humanReview).toBeUndefined();
  await x.review(first.version); expect((await x.service.store.listTasks())[0].humanReview.reviewedBy).not.toBe('somebody-else');
});


it('fails closed when a registered resource ancestor is swapped after authorization and before hashing', async () => {
  const x = await setup();
  const allowed = path.join(x.home, 'allowed'); const other = path.join(x.home, 'other');
  fs.mkdirSync(allowed); fs.mkdirSync(other);
  const allowedPath = path.join(allowed, 'report.txt'); fs.writeFileSync(allowedPath, 'registered result');
  fs.writeFileSync(path.join(other, 'report.txt'), 'unregistered synthetic content');
  const file = x.registry.registerFile({ sessionPath: x.sessionPath, filePath: allowedPath });
  await x.service.store.updateTask('t', { artifacts: [{ fileId: file.id }] });
  const resolve = x.resourceAccess.resolveContent.bind(x.resourceAccess);
  vi.spyOn(x.resourceAccess, 'resolveContent').mockImplementation((id, context) => {
    const authorized = resolve(id, context);
    fs.renameSync(allowed, `${allowed}-original`); fs.symlinkSync(other, allowed, 'dir');
    return authorized;
  });
  const body = await (await x.get()).json();
  expect(body.artifacts[0].state).not.toBe('available');
  expect(body.artifacts[0].sha256).toBeUndefined(); expect(body.artifacts[0].resource).toBeUndefined();
});

it('fails closed on a platform without verified descriptor-path binding', async () => {
  const x = await setup();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const body = await (await x.get()).json();
  expect(body.artifacts[0].state).toBe('unversioned');
  expect(body.artifacts[0].sha256).toBeUndefined();
  expect((await x.review(body.version)).status).toBe(409);
});
