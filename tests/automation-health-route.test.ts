// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioCronService } from '../core/studio-cron-service.ts';
import { classifyHttpRoute, authorizeHttpRoute } from '../server/http/route-security.ts';
import { createDeskRoute } from '../server/routes/desk.ts';
const dirs: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-api-'));
  dirs.push(root);
  const store = new StudioCronService({ codiaHome: root, agentsDir: path.join(root, 'agents'), getStudioId: () => 'studio-test' });
  const job = store.addJob({ type: 'every', schedule: 60_000, prompt: 'synthetic', actorAgentId: 'owner', executionContext: { kind: 'ui_manual', cwd: null }, timezone: 'Asia/Shanghai' });
  const runAgentCronNow = vi.fn(async () => ({ status: 'success', activityId: 'synthetic', sessionPath: '/synthetic/result.jsonl' }));
  const engine = { currentAgentId: 'different-focus', getStudioCronStore: () => store, listAgents: () => [] };
  const app = new Hono().route('/api', createDeskRoute(engine, { scheduler: { runAgentCronNow } }));
  const post = (body, query = '') => app.request(`/api/desk/cron${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { app, store, job, post, runAgentCronNow };
}
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
describe('automation health API', () => {
  it('dispatches only saved owner context, returns durable receipt, deduplicates and exposes original result', async () => {
    const { app, job, post, runAgentCronNow } = fixture();
    const payload = { action: 'run-now', id: job.id, requestId: 'same-user-click' };
    expect((await post(payload)).status).toBe(202);
    expect((await post(payload)).status).toBe(200);
    expect(runAgentCronNow).toHaveBeenCalledTimes(1);
    expect(runAgentCronNow).toHaveBeenCalledWith('owner', job.id, { requestId: 'same-user-click' });
    const result = await (await app.request(`/api/desk/cron/${job.id}/health`)).json();
    expect(result).toMatchObject({ status: 'success', latest: { activityId: 'synthetic', sessionPath: '/synthetic/result.jsonl' }, job: { timezone: 'Asia/Shanghai' } });
  });
  it('rejects missing idempotency token and wrong owner without dispatch', async () => {
    const { job, post, runAgentCronNow } = fixture();
    expect((await post({ action: 'run-now', id: job.id })).status).toBe(400);
    expect((await post({ action: 'run-now', id: job.id, requestId: 'valid-request' }, '?agentId=foreign')).status).toBe(403);
    expect(runAgentCronNow).not.toHaveBeenCalled();
  });
  it('reports unavailable store as an error rather than empty jobs', async () => {
    const app = new Hono().route('/api', createDeskRoute({ getAgent: () => null }, null));
    expect((await app.request('/api/desk/cron')).status).toBe(503);
  });
  it('keeps existing local-owner permission boundaries for history and execution', () => {
    expect(classifyHttpRoute({ path: '/api/desk/cron/job_1/health' })).toEqual(classifyHttpRoute({ path: '/api/desk/cron' }));
    expect(authorizeHttpRoute({ path: '/api/desk/cron/job_1/health', principal: { kind: 'remote', scopes: ['chat'] } }).allowed).toBe(false);
    expect(authorizeHttpRoute({ method: 'POST', path: '/api/desk/cron', principal: { kind: 'remote', scopes: ['chat'] } }).allowed).toBe(false);
  });

});
