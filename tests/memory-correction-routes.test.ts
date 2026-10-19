import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { FactStore } from '../lib/memory/fact-store.ts';
import { classifyHttpRoute } from '../server/http/route-security.ts';
import { createConfigRoute } from '../server/routes/config.ts';

describe('agent-local memory correction API', () => {
  it('isolates equal fact IDs in different agents and explicitly rejects retired import', async () => {
    const a = new FactStore(':memory:');
    const b = new FactStore(':memory:');
    try {
      a.add({ fact: 'Alpha private evidence', source: 'document:alpha' });
      b.add({ fact: 'Beta private evidence', source: 'document:beta' });
      const agents = { alpha: { id: 'alpha', factStore: a }, beta: { id: 'beta', factStore: b } };
      const app = new Hono<{ Variables: { authPrincipal: { scopes: string[] } } }>();
      app.route('/api', createConfigRoute({ config: {}, getAgent: id => agents[id] }));
      const write = (agentId, body) => app.request(`/api/memories/1?agentId=${agentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const original = a.getById(1);
      expect((await write('alpha', { fact: 'Corrected alpha', expectedUpdatedAt: original.updated_at })).status).toBe(200);
      expect(b.getById(1).fact).toBe('Beta private evidence');
      expect((await write('alpha', { fact: 'Stale', expectedUpdatedAt: original.updated_at })).status).toBe(409);
      expect((await write('missing', { fact: 'Other', expectedUpdatedAt: original.updated_at })).status).toBe(404);
      expect((await app.request('/api/memories/1?agentId=alpha', { method: 'DELETE' })).status).toBe(200);
      expect(a.searchFullText('alpha')).toEqual([]);
      expect(b.searchFullText('Beta')).toHaveLength(1);
      const imported = await app.request('/api/memories/import?agentId=alpha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ facts: [{ fact: 'Imported archive', source: 'document:v2', status: 'expired' }] }) });
      expect(imported.status).toBe(410);
      expect((await imported.json()).code).toBe('unsafe_memory_format_retired');
      expect(a.getAll()).toEqual([]);
    } finally { a.close(); b.close(); }
  });
  it('classifies correction routes as settings writes', () => {
    for (const method of ['PATCH', 'DELETE']) expect(classifyHttpRoute({ method, path: '/api/memories/1' })).toEqual({ kind: 'scope', scope: 'settings.write' });
  });
  it('requires settings.write before corrections or deletion', async () => {
    const app = new Hono<{ Variables: { authPrincipal: { scopes: string[] } } }>();
    app.use('*', async (c, next) => { c.set('authPrincipal', { scopes: ['settings.read'] }); await next(); });
    app.route('/api', createConfigRoute({ config: {}, getAgent: () => { throw new Error('must not access store'); } }));
    for (const method of ['PATCH', 'DELETE']) {
      expect((await app.request('/api/memories/1?agentId=alpha', { method })).status).toBe(403);
    }
  });
});
