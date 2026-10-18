import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompanyService } from '../lib/company-service';
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-run-')); directories.push(dataDir);
  const posts: any[] = [];
  const request = vi.fn(async (type: string, payload: any) => {
    if (type === 'agent:list') return { agents: [] };
    if (type === 'channel:members') return { members: ['writer'] };
    if (type === 'channel:post-message') { posts.push(payload); return { ok: true }; }
    return null;
  });
  const service = createCompanyService({ dataDir, bus: { request, emit: vi.fn() }, log: { warn: vi.fn() } });
  const workflow = { id: 'flow', nodes: [{ id: 'a', title: 'Research', agentId: 'writer' }, { id: 'b', title: 'Draft', agentId: 'writer' }], edges: [{ from: 'a', to: 'b' }] };
  return { service, posts, request, input: { channelId: 'channel-test', runId: 'run-test', workflow } };
}
describe('canvas run lifecycle', () => {
  it('dispatches only ready steps and requires real completed evidence for successors', async () => {
    const { service, posts, input } = setup();
    const assigned = await service.assignFromCanvas(input);
    expect(assigned.tasks.map((task: any) => task.status)).toEqual(['assigned', 'queued']);
    expect(posts).toHaveLength(1);
    await service.reportTask({ taskId: assigned.tasks[0].id, status: 'reported', report: 'working' });
    expect(posts).toHaveLength(1);
    await service.reportTask({ taskId: assigned.tasks[0].id, status: 'completed', report: 'actual result' });
    expect(posts).toHaveLength(2);
  });
  it('cancellation blocks successors and ignores late completion reports', async () => {
    const { service, posts, input } = setup();
    const assigned = await service.assignFromCanvas(input);
    await service.cancelWorkflowRun({ runId: input.runId });
    const late = await service.reportTask({ taskId: assigned.tasks[0].id, status: 'completed' });
    expect(late.status).toBe('cancelled');
    expect(posts).toHaveLength(1);
    const tasks = (await service.getStatus('company_default')).tasks;
    expect(tasks.every((task: any) => task.status === 'cancelled')).toBe(true);
  });
  it('preserves cancellation across service recreation', async () => {
    const { service, posts, input } = setup();
    const assigned = await service.assignFromCanvas(input);
    await service.cancelWorkflowRun({ runId: input.runId });
    const restored = createCompanyService({ dataDir: service.store.dataDir, bus: { request: vi.fn(), emit: vi.fn() } });
    const late = await restored.reportTask({ taskId: assigned.tasks[0].id, status: 'completed' });
    expect(late.status).toBe('cancelled');
    expect(posts).toHaveLength(1);
  });
  it('propagates failure without dispatching dependents', async () => {
    const { service, posts, input } = setup();
    const assigned = await service.assignFromCanvas(input);
    await service.reportTask({ taskId: assigned.tasks[0].id, status: 'failed', report: 'provider error' });
    expect(posts).toHaveLength(1);
    expect((await service.getStatus('company_default')).tasks.map((task: any) => task.status)).toEqual(['failed', 'failed']);
  });
  it('deduplicates retry of the same run ID and rejects cycles', async () => {
    const { service, posts, input } = setup();
    const first = await service.assignFromCanvas(input);
    const repeated = await service.assignFromCanvas(input);
    expect(repeated.tasks.map((task: any) => task.id)).toEqual(first.tasks.map((task: any) => task.id));
    expect(posts).toHaveLength(1);
    await expect(service.assignFromCanvas({ ...input, runId: 'cyclic', workflow: { ...input.workflow, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] } })).rejects.toThrow('cycle');
  });
  it('honors cancellation arriving before assignment', async () => {
    const { service, posts, input } = setup();
    await service.cancelWorkflowRun({ runId: input.runId });
    const assigned = await service.assignFromCanvas(input);
    expect(assigned.tasks).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
  it('deduplicates concurrent assignments', async () => {
    const { service, posts, input } = setup();
    const [a, b] = await Promise.all([service.assignFromCanvas(input), service.assignFromCanvas(input)]);
    expect(a.tasks.map((task: any) => task.id)).toEqual(b.tasks.map((task: any) => task.id));
    expect(posts).toHaveLength(1);
  });
  it('blocks subsequent dispatch when cancellation races an in-flight post', async () => {
    const { service, request, input } = setup();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const posting = new Promise<void>(resolve => { started = resolve; });
    const original = request.getMockImplementation()!;
    let count = 0;
    request.mockImplementation(async (type: string, payload: any) => {
      if (type === 'channel:post-message') { count++; started(); await pending; return { ok: true }; }
      return original(type, payload);
    });
    const assignment = service.assignFromCanvas({ ...input, workflow: { ...input.workflow, edges: [] } });
    await posting;
    await service.cancelWorkflowRun({ runId: input.runId });
    release();
    await assignment;
    expect(count).toBe(1);
    expect((await service.getStatus('company_default')).tasks.every((task: any) => task.status === 'cancelled')).toBe(true);
  });
  it('rejects premature completion and propagates failure in reverse node order', async () => {
    const { service, posts, input } = setup();
    const result = await service.assignFromCanvas({ ...input, workflow: { ...input.workflow, nodes: [...input.workflow.nodes].reverse() } });
    const a = result.tasks.find((task: any) => task.source.nodeId === 'a');
    const b = result.tasks.find((task: any) => task.source.nodeId === 'b');
    await expect(service.reportTask({ taskId: b.id, status: 'completed' })).rejects.toThrow('dependencies');
    await service.reportTask({ taskId: a.id, status: 'failed' });
    expect(posts).toHaveLength(1);
    expect((await service.getStatus('company_default')).tasks.every((task: any) => task.status === 'failed')).toBe(true);
  });

  it('requires declared acceptance evidence and retains deliverable artifacts', async () => {
    const { service, input, posts } = setup();
    input.workflow.nodes[0] = { ...input.workflow.nodes[0], acceptanceCriteria: ['Has sources'], requireAcceptance: true, outputFormat: 'json' } as any;
    const result = await service.assignFromCanvas(input);
    const id = result.tasks[0].id;
    const blocked = await service.reportTask({ taskId: id, status: 'completed', report: '{"sources":[]}', artifacts: [{ path: 'result.json' }], acceptanceResults: [{ criterion: 'Has sources', passed: false, evidence: 'No citations' }] });
    expect(blocked.status).toBe('blocked');
    expect(posts).toHaveLength(1);
    const missing = await service.reportTask({ taskId: id, status: 'completed' });
    expect(missing.status).toBe('blocked');
    const completed = await service.reportTask({ taskId: id, status: 'completed', report: '{"sources":["https://example.com"]}', acceptanceResults: [{ criterion: 'Has sources', passed: true, evidence: 'Verified citation' }] });
    expect(completed.status).toBe('completed');
    expect(completed.artifacts).toEqual([{ path: 'result.json' }]);
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toContain('https://example.com');
  });
  it('rejects invalid JSON deliverables and explicit failed checks even without strict mode', async () => {
    const { service, input } = setup();
    input.workflow.nodes[0] = { ...input.workflow.nodes[0], acceptanceCriteria: ['Valid'], requireAcceptance: true, outputFormat: 'json' } as any;
    const result = await service.assignFromCanvas(input);
    const task = await service.reportTask({ taskId: result.tasks[0].id, status: 'completed', report: 'not JSON', acceptanceResults: [{ criterion: 'Valid', passed: true, evidence: 'claim' }] });
    expect(task.status).toBe('blocked');
    expect(task.acceptanceFailure).toContain('JSON');
  });
  it('serializes overlapping declared write ownership across concurrent runs', async () => {
    const { service, input } = setup();
    const workflow = { nodes: [{ id: 'write', title: 'Write', writePaths: ['src/../src/report.ts'] }], edges: [] };
    const outcomes = await Promise.allSettled([
      service.assignFromCanvas({ ...input, workflow }),
      service.assignFromCanvas({ ...input, runId: 'other', workflow: { nodes: [{ id: 'write', title: 'Write', writePaths: ['src'] }], edges: [] } }),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    await service.cancelWorkflowRun({ runId: input.runId });
    await service.cancelWorkflowRun({ runId: 'other' });
    await expect(service.assignFromCanvas({ ...input, runId: 'after-cancel', workflow })).resolves.toBeTruthy();
  });

  it('blocks ambiguous dispatch errors without retrying possible side effects', async () => {
    const { service, request, input } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (type: string, payload: any) => {
      if (type === 'channel:post-message') throw new Error('response lost after delivery');
      return original(type, payload);
    });
    const result = await service.assignFromCanvas(input);
    expect(result.tasks[0].status).toBe('blocked');
    expect(result.tasks[0].dispatchOutcome).toBe('unknown');
    expect(result.tasks[1].status).toBe('queued');
    await service.assignFromCanvas(input);
    expect(request.mock.calls.filter(([type]) => type === 'channel:post-message')).toHaveLength(1);
  });

  it('resolves the default status alias to the same assigned company', async () => {
    const { service, input } = setup();
    await service.assignFromCanvas(input);
    expect((await service.getStatus('default')).tasks).toHaveLength(2);
  });

});
