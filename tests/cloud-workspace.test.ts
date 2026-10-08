import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { CloudWorkspaceStore, type CloudActor } from '../lib/cloud-workspace/store.ts';
import { LocalObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { CloudWorkspaceService } from '../lib/cloud-workspace/service.ts';
import { CloudWorkspaceWorker } from '../lib/cloud-workspace/worker.ts';
import { createCloudWorkspacesRoute } from '../server/routes/cloud-workspaces.ts';
import { createResourceIoRoute } from '../server/routes/resource-io.ts';
import { classifyHttpRoute } from '../server/http/route-security.ts';
import { ensureLocalIdentityRegistries, loadServerIdentity } from '../core/server-identity.ts';
const alice: CloudActor = { userId: 'alice', studioId: 'studio-a' };
const bob: CloudActor = { userId: 'bob', studioId: 'studio-a' };
const otherStudio: CloudActor = { userId: 'alice', studioId: 'studio-b' };
let directory: string, store: CloudWorkspaceStore, service: CloudWorkspaceService;
let workers: CloudWorkspaceWorker[] = [];
const bytes = Buffer.from('# 发布说明\n\n这是持久化文件测试。\n关闭浏览器后任务继续。');
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-workspace-test-')); store = new CloudWorkspaceStore(path.join(directory, 'metadata.db')); service = new CloudWorkspaceService(store, new LocalObjectStore(path.join(directory, 'objects'))); });
afterEach(async () => { for (const worker of workers) await worker.stop(); workers = []; store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
function api(actor: CloudActor | null = alice, scopes = ['files.read', 'files.write']) {
  const app = new Hono();
  if (actor) app.use('*', async (c, next) => { (c as any).set('authPrincipal', { ...actor, kind: 'account_user', credentialKind: 'user_session', connectionKind: 'cloud', scopes }); await next(); });
  app.route('/api', createCloudWorkspacesRoute(service)); app.route('/api', createResourceIoRoute({ resourceIO: null }, service)); return app;
}
function post(app: Hono, pathname: string, body: unknown, extra: Record<string,string> = {}) { return app.request(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cloud-studio', ...extra }, body: JSON.stringify(body) }); }
async function fixture() { const workspace = store.createWorkspace(alice, '设计资料'); const upload = await service.upload(alice, workspace.id, '发布说明.md', bytes); return { workspace, ...upload }; }

describe('Codia cloud workspace persistence', () => {
  it('roundtrips bytes and versions while preventing cross-user/studio access', async () => {
    const f = await fixture(); expect((await service.read(alice, f.version.id)).bytes).toEqual(bytes);
    expect(f.file).toMatchObject({ size: bytes.length, version_count: 1, sha256: f.version.sha256 });
    for (const actor of [bob, otherStudio]) { expect(store.listWorkspaces(actor)).toEqual([]); expect(() => store.file(actor, f.file.id)).toThrow('not_found'); await expect(service.read(actor, f.version.id)).rejects.toThrow('not_found'); expect(() => store.events(actor, f.workspace.id)).toThrow('not_found'); }
  });
  it('preserves immutable old version and reports stale concurrent writes', async () => {
    const f = await fixture(); const second = await service.upload(alice, f.workspace.id, f.file.name, Buffer.from('second'), f.file.id, f.version.id);
    await expect(service.upload(alice, f.workspace.id, f.file.name, Buffer.from('stale'), f.file.id, f.version.id)).rejects.toThrow('version_conflict');
    expect((await service.read(alice, f.version.id)).bytes).toEqual(bytes); expect(store.file(alice, f.file.id).current_version).toBe(second.version.id); expect(store.versions(alice, f.file.id)).toHaveLength(2);
  });
  it('competing staged uploads have only one winner', async () => {
    const f = await fixture(); const a = store.stageVersion(alice, f.workspace.id, f.file.name, 1, 'hash-a', f.file.id, f.version.id); const b = store.stageVersion(alice, f.workspace.id, f.file.name, 1, 'hash-b', f.file.id, f.version.id);
    store.finalizeVersion(alice, a.version.id, f.version.id); expect(() => store.finalizeVersion(alice, b.version.id, f.version.id)).toThrow('version_conflict');
  });
  it('never publishes an object upload failure as successful and permits retry', async () => {
    const workspace = store.createWorkspace(alice, '失败恢复'); const failed = new CloudWorkspaceService(store, { kind: 'failure-test', putImmutable: async () => { throw new Error('object_failure'); }, get: async () => Buffer.alloc(0) });
    await expect(failed.upload(alice, workspace.id, 'retry.md', bytes)).rejects.toThrow('object_failure'); expect(store.listFiles(alice, workspace.id)).toEqual([]); await expect(service.upload(alice, workspace.id, 'retry.md', bytes)).resolves.toBeTruthy();
  });
  it('reconciles expired crash-staged uploads after database reopen', async () => {
    const workspace = store.createWorkspace(alice, 'Crash'); store.stageVersion(alice, workspace.id, 'crash.md', 2, 'sha');
    store.close(); store = new CloudWorkspaceStore(path.join(directory, 'metadata.db')); service = new CloudWorkspaceService(store, service.objects);
    expect(store.reconcileStaging(Date.now() + 301000)).toBe(1); expect(store.listFiles(alice, workspace.id)).toEqual([]); await expect(service.upload(alice, workspace.id, 'crash.md', bytes)).resolves.toBeTruthy();
  });
  it('idempotency key pins input and conflicts on changed payload', async () => {
    const f = await fixture(); const first = store.createRun(alice, f.workspace.id, f.version.id, 'request-key-1');
    expect(store.createRun(alice, f.workspace.id, f.version.id, 'request-key-1').id).toBe(first.id);
    const second = await service.upload(alice, f.workspace.id, f.file.name, Buffer.from('second'), f.file.id, f.version.id);
    expect(() => store.createRun(alice, f.workspace.id, second.version.id, 'request-key-1')).toThrow('idempotency_conflict'); expect(store.run(alice, first.id).run.input_version).toBe(f.version.id);
  });
  it('refuses cross-workspace run inputs even for same owner', async () => { const f = await fixture(); const other = store.createWorkspace(alice, '其他'); expect(() => store.createRun(alice, other.id, f.version.id, 'request-key-2')).toThrow('not_found'); });
  it('survives API/store restart and processes pinned input into durable artifact', async () => {
    const f = await fixture(); const run = store.createRun(alice, f.workspace.id, f.version.id, 'request-key-3');
    store.close(); store = new CloudWorkspaceStore(path.join(directory, 'metadata.db')); service = new CloudWorkspaceService(store, service.objects);
    const worker = new CloudWorkspaceWorker(service); workers.push(worker); await worker.tick();
    const detail = store.run(alice, run.id); expect(detail.run.status).toBe('succeeded'); expect(detail.artifacts).toHaveLength(1);
    expect((await service.read(alice, detail.artifacts[0].version_id)).bytes.toString()).toContain('未调用大模型');
    expect(detail.events.map((e: any) => e.kind)).toEqual(['run.queued', 'run.running', 'run.succeeded']); store.publishOutbox(); expect(store.run(alice, run.id).events).toHaveLength(3); expect(await worker.tick()).toBe(false);
  });
  it('expired execution is reclaimed, and stale attempt cannot commit', async () => {
    const f = await fixture(); store.createRun(alice, f.workspace.id, f.version.id, 'request-key-4'); const old = store.claim(10, 1000)!;
    expect(store.claim(10, 1001)).toBeNull(); const replacement = store.claim(10, 1011)!; expect(replacement.attempt).toBe(2);
    expect(() => store.complete(old, { objectKey: 'old', size: 1, sha256: 'x' }, 1012)).toThrow('stale_executor'); expect(() => store.complete(replacement, { objectKey: 'new', size: 1, sha256: 'y' }, 1012)).not.toThrow();
  });
  it('rejects invalid UTF8 without fake success', async () => {
    const workspace = store.createWorkspace(alice, 'Binary'); const upload = await service.upload(alice, workspace.id, 'binary.dat', Buffer.from([0xff,0xfe])); const run = store.createRun(alice, workspace.id, upload.version.id, 'request-key-5');
    const worker = new CloudWorkspaceWorker(service); workers.push(worker); await worker.tick(); expect(store.run(alice, run.id).run.status).toBe('failed'); expect(store.run(alice, run.id).artifacts).toEqual([]);
  });
});

describe('Codia integrated route security and ResourceIO', () => {
  it('initializes persisted identity before constructing the server engine', () => {
    const source = fs.readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    expect(source.indexOf('ensureLocalIdentityRegistries(gsapHome);')).toBeLessThan(source.indexOf('new GsapEngine('));
  });
  it('keeps persisted identity stable across initialization and rejects corrupt registries', () => {
    ensureLocalIdentityRegistries(directory); const before = loadServerIdentity(directory);
    ensureLocalIdentityRegistries(directory); expect(loadServerIdentity(directory)).toEqual(before);
    expect(before.userId).not.toBe('user_local'); expect(before.spaceId).not.toBe('space_local');
    fs.writeFileSync(path.join(directory, 'users.json'), '{corrupt');
    expect(() => ensureLocalIdentityRegistries(directory)).toThrow('invalid users.json');
  });
  it('fails closed without authenticated principal or missing scopes', async () => {
    expect((await api(null).request('/api/cloud/workspaces')).status).toBe(401); expect((await post(api(alice, ['files.read']), '/api/cloud/workspaces', { name: 'bad' })).status).toBe(403); expect(classifyHttpRoute({ method: 'POST', path: '/api/cloud/workspaces/x/runs' }).scope).toBe('files.write');
  });
  it('ignores forged body identity and blocks guessed resource IDs', async () => {
    const f = await fixture(); const app = api(bob);
    expect((await app.request(`/api/cloud/files/${f.file.id}/versions`)).status).toBe(404); expect((await app.request(`/api/cloud/versions/${f.version.id}/content`)).status).toBe(404);
    expect((await post(app, `/api/cloud/workspaces/${f.workspace.id}/runs`, { inputVersion: f.version.id, operation: 'document-summary', requestKey: 'request-key-6', principal: alice, userId: alice.userId })).status).toBe(404);
    expect((await post(app, '/api/resource-io/read', { resource: { kind: 'resource', resourceId: `cloud-file:${f.file.id}` }, principal: alice })).status).toBe(404);
  });
  it('runs authenticated API upload/task/artifact read without body-supplied identity', async () => {
    const app = api(); const workspace = (await (await post(app, '/api/cloud/workspaces', { name: 'API' })).json()).workspace;
    const upload = await (await post(app, `/api/cloud/workspaces/${workspace.id}/files`, { name: 'api.md', contentBase64: bytes.toString('base64') })).json();
    const result = await post(app, `/api/cloud/workspaces/${workspace.id}/runs`, { inputVersion: upload.version.id, operation: 'document-summary', requestKey: 'request-key-7' }); expect(result.status).toBe(202);
    const run = (await result.json()).run; const worker = new CloudWorkspaceWorker(service); workers.push(worker); await worker.tick(); const detail = await (await app.request(`/api/cloud/runs/${run.id}`)).json(); expect(detail.run.status).toBe('succeeded');
    const response = await app.request(`/api/cloud/versions/${detail.artifacts[0].version_id}/content`); expect(response.headers.get('content-type')).toContain('text/plain'); expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(await response.text()).toContain('固定文本处理流程');
  });
  it('enforces mutation origin/header, upload limits, malformed input and filename checks', async () => {
    const app = api(); expect((await post(app, '/api/cloud/workspaces', { name: 'bad' }, { Origin: 'https://evil.invalid' })).status).toBe(403); expect((await post(app, '/api/cloud/workspaces', { name: 'bad' }, { 'X-Requested-With': '' })).status).toBe(403); expect((await post(app, '/api/cloud/workspaces', { name: '../escape' })).status).toBe(400);
    const workspace = store.createWorkspace(alice, 'limits'); expect((await post(app, `/api/cloud/workspaces/${workspace.id}/files`, { name: 'big', contentBase64: Buffer.alloc(2*1024*1024+1).toString('base64') })).status).toBe(413); expect((await post(app, `/api/cloud/workspaces/${workspace.id}/files`, { name: 'bad', contentBase64: '%%%!' })).status).toBe(400);
  });
  it('supports ResourceIO stable refs, alias normalization and etag compare-and-set', async () => {
    const f = await fixture(); const app = api(); const resource = { kind: 'resource', resourceId: `cloud-file:${f.file.id}` };
    for (const ref of [resource, { type: 'resource', id: resource.resourceId }, { ref: resource }]) { const response = await post(app, '/api/resource-io/read', { resource: ref }); expect(response.status).toBe(200); const data = await response.json(); expect(data.version.etag).toBe(f.version.id); expect(data.filePath).toBeUndefined(); }
    expect((await post(api(alice, ['files.read']), '/api/resource-io/write-expected-version', { resource, expectedVersion: { etag: f.version.id }, content: 'nope' })).status).toBe(403);
    expect((await post(app, '/api/resource-io/write-expected-version', { resource, expectedVersion: { etag: f.version.id }, content: 'new' })).status).toBe(200);
    expect((await post(app, '/api/resource-io/write-expected-version', { resource, expectedVersion: { etag: f.version.id }, content: 'stale' })).status).toBe(409);
    expect((await post(app, '/api/resource-io/write', { resource, content: 'unconditional' })).status).toBe(403);
  });
  it('allows only explicitly configured exact proxy origins', async () => {
    const app = new Hono(); app.use('*', async (c, next) => { (c as any).set('authPrincipal', { ...alice, kind: 'account_user', scopes: ['files.read', 'files.write'] }); await next(); }); app.route('/api', createCloudWorkspacesRoute(service, ['http://127.0.0.1:5175']));
    expect((await post(app, '/api/cloud/workspaces', { name: 'proxy' }, { Origin: 'http://127.0.0.1:5175' })).status).toBe(201); expect((await post(app, '/api/cloud/workspaces', { name: 'wrong' }, { Origin: 'http://127.0.0.1:5176' })).status).toBe(403); expect((await post(api(), '/api/cloud/workspaces', { name: 'default' }, { Origin: 'http://127.0.0.1:5175' })).status).toBe(403);
  });
  it('compares artifact bytes against the independently computed original hash', async () => {
    const f = await fixture(); const original = service.objects; const faulty = new CloudWorkspaceService(store, { kind: 'fault-injection', get: key => original.get(key), putImmutable: (key, data) => original.putImmutable(key, key.includes('/runs/') ? Buffer.from('CORRUPTED ARTIFACT') : data) });
    const run = store.createRun(alice, f.workspace.id, f.version.id, 'request-key-fault'); const worker = new CloudWorkspaceWorker(faulty); workers.push(worker); await worker.tick(); const detail = store.run(alice, run.id); expect(detail.run.status).toBe('failed'); expect(detail.run.error).toBe('output_integrity_mismatch'); expect(detail.artifacts).toEqual([]);
  });
  it('event cursor catches up after disconnect without duplicate events', async () => {
    const f = await fixture(); const before = store.events(alice, f.workspace.id); store.createRun(alice, f.workspace.id, f.version.id, 'request-key-8'); const after = store.events(alice, f.workspace.id, before.cursor); expect(after.events.map((e: any) => e.kind)).toEqual(['run.queued']); expect(store.events(alice, f.workspace.id, after.cursor).events).toEqual([]);
  });
});
