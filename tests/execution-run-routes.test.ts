import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunController } from '../lib/execution/run-controller.ts';
import { createSessionsRoute } from '../server/routes/sessions.ts';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('uses the session path boundary and consumes resume revisions once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-run-api-')); roots.push(root);
  const agentsDir = path.join(root, 'agents');
  const sessionPath = path.join(agentsDir, 'codia', 'sessions', 'fixture.jsonl');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true }); fs.writeFileSync(sessionPath, '{}\n');
  const run = new RunController(); run.begin(); run.pause('model_limit');
  const resume = vi.fn((_path, id, revision) => run.resume(id, revision));
  const engine = { agentsDir, getExecutionRun: () => run.snapshot(), resumeExecutionRun: resume,
    abortSession: () => run.cancel(), getSessionIdForPath: () => null };
  const app = new Hono().route('/api', createSessionsRoute(engine));
  const state = await app.request(`/api/sessions/execution-run?path=${encodeURIComponent(sessionPath)}`);
  expect(state.status).toBe(200);
  const snapshot = (await state.json()).run;
  const body = JSON.stringify({ path: sessionPath, runId: snapshot.runId, revision: snapshot.revision });
  const post = () => app.request('/api/sessions/execution-run/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  expect((await post()).status).toBe(200);
  expect((await post()).status).toBe(409);
  expect((await app.request(`/api/sessions/execution-run?path=${encodeURIComponent(path.join(root, 'outside.jsonl'))}`)).status).toBe(403);
  run.cancel();
});
