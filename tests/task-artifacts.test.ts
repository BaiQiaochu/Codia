import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createTaskArtifactsRoute } from '../server/routes/task-artifacts.ts';
import { createResourcesRoute } from '../server/routes/resources.ts';
import { SessionFileRegistry } from '../lib/session-files/session-file-registry.ts';
import { ResourceService } from '../core/resource-service.ts';
import { ResourceAccessService } from '../core/resource-access-service.ts';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup({ denyResource = false, denySession = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifacts-')); dirs.push(home);
  const agentsDir = path.join(home, 'agents');
  const sessionPath = path.join(agentsDir, 'a', 'sessions', 'a.jsonl');
  const otherSessionPath = path.join(agentsDir, 'a', 'sessions', 'b.jsonl');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, '{}\n'); fs.writeFileSync(otherSessionPath, '{}\n');
  const filePath = path.join(home, 'report.md'); fs.writeFileSync(filePath, 'Intro\nold result\n');
  const registry = new SessionFileRegistry();
  const source = registry.registerFile({ sessionPath, filePath, origin: 'agent_write', label: 'Report' });
  const runtime = { studioId: 'studio_test', userId: 'u', connectionKind: 'local', credentialKind: 'loopback_token' };
  const resourceService = new ResourceService({ agentsDir, sessionFiles: registry, runtimeContext: runtime });
  const resourceAccess = new ResourceAccessService({ resourceService, ...(denyResource ? { authorizeCapability: () => ({ allowed: false }) } : {}) });
  const engine = {
    agentsDir, codiaHome: home,
    getRuntimeContext: () => denySession ? { ...runtime, connectionKind: 'lan', credentialKind: 'device_credential' } : runtime,
    listSessionFiles: vi.fn((session: string) => registry.list(session)),
    getSessionFile: (id: string, options: { sessionPath: string }) => registry.get(id, options),
    registerSessionFile: vi.fn((entry: any) => registry.registerFile(entry)),
    getResourceAccessService: () => resourceAccess,
  };
  const app = new Hono(); app.route('/api', createTaskArtifactsRoute(engine)); app.route('/api', createResourcesRoute(engine));
  const request = (suffix = '', { session = sessionPath, method = 'GET', query = '' } = {}) => app.request(`/api/task-artifacts${suffix}?sessionPath=${encodeURIComponent(session)}${query}`, { method });
  const capture = () => request(`/${source.id}/snapshots`, { method: 'POST' });
  return { home, app, registry, sessionPath, otherSessionPath, source, filePath, engine, request, capture };
}
describe('registered task artifacts and actual snapshot history', () => {
  it('lists only registered visible files without capturing on read', async () => {
    const x = setup();
    x.registry.registerFile({ sessionPath: x.sessionPath, filePath: x.sessionPath, listed: false });
    const response = await x.request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0].snapshots).toEqual([]);
    expect(x.engine.registerSessionFile).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(x.home, 'artifact-snapshots'))).toBe(false);
  });
  it('reports unavailable snapshot capability while retaining registered files and historical metadata', async () => {
    const x = setup(); const snapshot = (await (await x.capture()).json()).snapshot;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const response = await x.request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.capabilities).toEqual({ platform: 'win32', snapshotAvailable: false, reason: 'snapshot_platform_unsupported' });
    expect(body.files).toHaveLength(1);
    expect(body.files[0].snapshots[0].id).toBe(snapshot.id);
    expect((await x.capture()).status).toBe(503);
    expect((await x.app.request(snapshot.file.resource.links.content)).status).toBe(503);
    expect((await x.app.request(body.files[0].resource.links.content)).status).toBe(200);
    const compared = await x.request(`/${x.source.id}/compare`, { query: `&before=${snapshot.id}&after=${snapshot.id}` });
    expect(compared.status).toBe(503);
  });
  it('captures stable bytes, compares content and exports via existing authorized resource route after source deletion', async () => {
    const x = setup();
    const one = await x.capture(); expect(one.status).toBe(201);
    const first = (await one.json()).snapshot;
    fs.writeFileSync(x.filePath, 'Intro\nnew result\n');
    const two = await x.capture(); expect(two.status).toBe(201);
    const second = (await two.json()).snapshot;
    expect(second.parentId).toBe(first.id);
    const repeat = await x.capture(); expect(repeat.status).toBe(200); expect((await repeat.json()).created).toBe(false);
    const listed = await (await x.request()).json();
    expect(listed.files).toHaveLength(1); expect(listed.files[0].snapshots).toHaveLength(2);
    expect(x.engine.registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({ listed: false, origin: 'artifact_snapshot', storageKind: 'artifact_snapshot' }));
    fs.unlinkSync(x.filePath);
    const comparison = await x.request(`/${x.source.id}/compare`, { query: `&before=${first.id}&after=${second.id}` });
    expect(comparison.status).toBe(200);
    expect(await comparison.json()).toMatchObject({ kind: 'text', identical: false, lines: expect.arrayContaining([{ kind: 'removed', text: 'old result' }, { kind: 'added', text: 'new result' }]) });
    const exported = await x.app.request(first.file.resource.links.content);
    expect(exported.status).toBe(200); expect(await exported.text()).toBe('Intro\nold result\n');
  });
  it('exports only verified bytes, including range/HEAD, and rejects tampered or symlinked payloads', async () => {
    const x = setup(); const snapshot = (await (await x.capture()).json()).snapshot;
    const contentUrl = snapshot.file.resource.links.content;
    const range = await x.app.request(contentUrl, { headers: { Range: 'bytes=0-4' } });
    expect(range.status).toBe(206); expect(await range.text()).toBe('Intro');
    expect(range.headers.get('etag')).toBe(`"sha256-${snapshot.sha256}"`);
    const head = await x.app.request(contentUrl, { method: 'HEAD' });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(snapshot.size));
    const unchanged = await x.app.request(contentUrl, { headers: { 'If-None-Match': `"sha256-${snapshot.sha256}"` } });
    expect(unchanged.status).toBe(304);
    const payload = x.registry.get(snapshot.snapshotFileId, { sessionPath: x.sessionPath }).realPath;
    fs.chmodSync(payload, 0o600); fs.writeFileSync(payload, 'tampered');
    const corrupted = await x.app.request(contentUrl);
    expect(corrupted.status).toBe(409); expect((await corrupted.json()).error).toBe('snapshot_integrity_failed');
    fs.unlinkSync(payload); fs.symlinkSync(x.otherSessionPath, payload);
    const escaped = await x.app.request(contentUrl);
    expect(escaped.status).toBe(403); expect((await escaped.json()).error).toBe('snapshot_path_changed');
  });
  it('does not reopen snapshot paths after verification when returning content', async () => {
    const x = setup(); const snapshot = (await (await x.capture()).json()).snapshot;
    const stream = vi.spyOn(fs, 'createReadStream');
    try {
      const response = await x.app.request(snapshot.file.resource.links.content);
      expect(response.status).toBe(200); expect(await response.text()).toBe('Intro\nold result\n');
      expect(stream).not.toHaveBeenCalled();
    } finally { stream.mockRestore(); }
  });
  it('requires snapshot session access even when existing resource permission allows reading', async () => {
    const x = setup(); const snapshot = (await (await x.capture()).json()).snapshot;
    const oldAccess = x.engine.getResourceAccessService();
    const originalContext = x.engine.getRuntimeContext;
    const local = originalContext();
    x.engine.getRuntimeContext = () => ({ ...local, connectionKind: 'lan', credentialKind: 'device_credential' });
    // This client is allowed resource reads, but has no sessions.read grant.
    x.engine.getResourceAccessService = () => ({
      getMetadata: (id: string) => oldAccess.getMetadata(id, { authPrincipal: { kind: 'local_user', connectionKind: 'local', credentialKind: 'loopback_token' } }),
      resolveContent: (id: string) => oldAccess.resolveContent(id, { authPrincipal: { kind: 'local_user', connectionKind: 'local', credentialKind: 'loopback_token' } }),
    }) as unknown as ResourceAccessService;
    expect((await x.app.request(snapshot.file.resource.links.self)).status).toBe(403);
    expect((await x.app.request(snapshot.file.resource.links.content)).status).toBe(403);
    expect((await x.app.request(`${snapshot.file.resource.links.self}/ticket`, { method: 'POST' })).status).toBe(403);
  });
  it('rejects invalid session paths before probing the registry', async () => {
    const x = setup();
    expect((await x.request('', { session: '/etc/passwd' })).status).toBe(403);
    expect(x.engine.listSessionFiles).not.toHaveBeenCalled();
    expect((await x.request('', { session: path.join(x.home, 'agents', '..', 'report.md') })).status).toBe(403);
  });
  it('rejects session symlinks, including links to another allowed session', async () => {
    const x = setup();
    const alias = path.join(path.dirname(x.sessionPath), 'alias.jsonl');
    fs.symlinkSync(x.otherSessionPath, alias);
    expect((await x.request('', { session: alias })).status).toBe(403);
    expect(x.engine.listSessionFiles).not.toHaveBeenCalled();
  });
  it('requires existing session permission and resource authorization', async () => {
    const sessionDenied = setup({ denySession: true });
    expect((await sessionDenied.request()).status).toBe(403);
    expect((await sessionDenied.capture()).status).toBe(403);
    expect(sessionDenied.engine.listSessionFiles).not.toHaveBeenCalled();
    const resourceDenied = setup({ denyResource: true });
    expect((await resourceDenied.request()).status).toBe(403);
    expect((await resourceDenied.capture()).status).toBe(403);
    expect(resourceDenied.engine.registerSessionFile).not.toHaveBeenCalled();
  });
  it('rejects foreign file IDs and foreign snapshot IDs even within the same owner studio', async () => {
    const x = setup(); const first = (await (await x.capture()).json()).snapshot;
    expect((await x.request(`/${x.source.id}/snapshots`, { method: 'POST', session: x.otherSessionPath })).status).toBe(404);
    const secondSource = x.registry.registerFile({ sessionPath: x.otherSessionPath, filePath: x.filePath });
    expect((await x.request(`/${secondSource.id}/compare`, { session: x.otherSessionPath, query: `&before=${first.id}&after=${first.id}` })).status).toBe(404);
    expect((await x.request(`/${x.source.id}/compare`, { query: '&before=../../private&after=unknown' })).status).toBe(404);
  });
  it('never accepts arbitrary filesystem paths or hidden snapshot IDs as sources', async () => {
    const x = setup(); const first = (await (await x.capture()).json()).snapshot;
    expect((await x.request('/sf_unregistered/snapshots', { method: 'POST', query: `&filePath=${encodeURIComponent(x.filePath)}` })).status).toBe(404);
    expect((await x.request(`/${first.snapshotFileId}/snapshots`, { method: 'POST' })).status).toBe(404);
  });
  it('rejects registered source paths that were replaced by symlinks', async () => {
    const x = setup(); fs.unlinkSync(x.filePath); fs.symlinkSync(x.otherSessionPath, x.filePath);
    expect((await x.capture()).status).toBe(403);
    expect(x.engine.registerSessionFile).not.toHaveBeenCalled();
  });
  it('rejects expired sources and directories', async () => {
    const x = setup();
    const directory = x.registry.registerFile({ sessionPath: x.sessionPath, filePath: x.home });
    expect((await x.request(`/${directory.id}/snapshots`, { method: 'POST' })).status).toBe(409);
    x.engine.listSessionFiles.mockReturnValue([{ ...x.source, status: 'expired' }]);
    expect((await x.capture()).status).toBe(409);
  });
});
