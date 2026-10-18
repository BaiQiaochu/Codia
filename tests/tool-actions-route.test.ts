import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolActionLedger, toolActionId, toolActionSessionRef } from '../lib/tools/tool-action-ledger.ts';
import { createToolActionsRoute } from '../server/routes/tool-actions.ts';
import { authorizeHttpRoute, classifyHttpRoute } from '../server/http/route-security.ts';

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-inspection-')); dirs.push(dir);
  const ledger = new ToolActionLedger(dir);
  const id = toolActionId('/original-session', 'call-1');
  ledger.begin({ actionId: id, toolName: 'write', parameterDigest: 'hidden-parameter-digest', scopeDigest: 'a'.repeat(64), sessionRef: toolActionSessionRef('/original-session'), readOnly: false,
    traceId: 'trace_1', toolTraceId: 'tooltrace_1', approval: { mode: 'ask', decision: 'confirmed', confirmId: 'confirm_1' } });
  const engine = { toolActionLedger: ledger, listSessions: vi.fn(async () => [{ path: '/original-session' }]) };
  return { id, ledger, dir, engine, app: new Hono().route('/api', createToolActionsRoute(engine)) };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('tool action owner inspection', () => {
  it('exposes only allowlisted metadata and resolves verified original session', async () => {
    const { id, dir, app } = setup();
    const path = join(dir, `${id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...record, params: { token: 'secret-token' }, output: 'private-result', sessionPath: '/injected-session', approval: { ...record.approval, password: 'secret-password' } }));
    const response = await app.request('/api/tool-actions');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.actions[0]).toMatchObject({ actionId: id, state: 'running', confirmationId: 'confirm_1', traceId: 'trace_1', sessionPath: '/original-session' });
    expect(Object.keys(data.actions[0]).sort()).toEqual(['actionId', 'state', 'toolName', 'readOnly', 'sessionRef', 'scopeRef', 'traceId', 'toolTraceId', 'confirmationId', 'createdAt', 'updatedAt', 'sessionPath'].sort());
    for (const secret of ['secret-token', 'private-result', 'secret-password', 'hidden-parameter-digest', '/injected-session']) expect(JSON.stringify(data)).not.toContain(secret);
    expect((await (await app.request(`/api/tool-actions/${id}`)).json()).action.actionId).toBe(id);
  });
  it('does not fabricate a navigation target for absent/legacy sessions', async () => {
    const { app, engine } = setup(); engine.listSessions.mockResolvedValue([]);
    expect((await (await app.request('/api/tool-actions')).json()).actions[0].sessionPath).toBeNull();
  });
  it('reports unreadable records and inspection failure instead of silently claiming an empty successful ledger', async () => {
    const { id, dir, app } = setup(); writeFileSync(join(dir, `${id}.json`), '{bad json');
    expect(await (await app.request('/api/tool-actions')).json()).toMatchObject({ unreadableCount: 1, total: 1, actions: [] });
    expect((await app.request(`/api/tool-actions/${id}`)).status).toBe(503);
    expect((await app.request('/api/tool-actions/not-an-action')).status).toBe(400);
  });
  it('keeps inspection read-only and owner-only without broadening existing chat scopes', async () => {
    const { app, id, ledger } = setup();
    expect((await app.request(`/api/tool-actions/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app.request(`/api/tool-actions/${id}/retry`, { method: 'POST' })).status).toBe(404);
    expect(ledger.get(id)?.state).toBe('running');
    for (const path of ['/api/tool-actions', `/api/tool-actions/${id}`]) {
      expect(classifyHttpRoute({ method: 'GET', path }).kind).toBe('studio_owner');
      expect(authorizeHttpRoute({ method: 'GET', path, principal: { kind: 'remote', scopes: ['chat'] } }).allowed).toBe(false);
    }
  });
});
