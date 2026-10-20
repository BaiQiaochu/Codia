import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunController, bindExecutionRun, moveSessionWithExecutionRunSync, loadExecutionRun } from '../lib/execution/run-controller.ts';
import { createSubmissionGate, cancelSessionSubmissions, SUBMISSION_WAIT_MS } from '../lib/execution/submission-gate.ts';

const roots: string[] = [];
const runs: RunController[] = [];
function controller(options = {}) {
  const run = new RunController({ limits: { modelCalls: 2, toolCalls: 3, activeMs: 1000 }, ...options });
  runs.push(run);
  return run;
}
afterEach(() => {
  runs.splice(0).forEach(run => run.cancel());
  vi.useRealTimers();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
describe('task admission and recovery', () => {
  it('moves accounting with an archived/restored transcript without minting allowance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-run-')); roots.push(root);
    const from = path.join(root, 'old.jsonl'); const to = path.join(root, 'archive', 'old.jsonl');
    fs.writeFileSync(from, '{}');
    const run = controller({ file: `${from}.run.json` }); bindExecutionRun(from, run);
    run.begin(); run.admitModel(); run.pause('model_limit');
    const before = run.snapshot()!;
    moveSessionWithExecutionRunSync(from, to);
    const restored = loadExecutionRun(to); runs.push(restored);
    expect(restored.snapshot()).toMatchObject({ runId: before.runId, used: { modelCalls: 1 }, status: 'paused' });
    expect(fs.existsSync(`${from}.run.json`)).toBe(false);
  });
  it('keeps a failed pre-provider operation distinct from completion', () => {
    const run = controller(); run.begin(); const release = run.enter();
    release(true); release();
    expect(run.snapshot()?.status).toBe('failed');
  });
  it('counts shared parallel calls and resumes exactly once without resetting usage', () => {
    const run = controller(); run.begin(); const release = run.enter();
    run.admitModel(); run.admitModel();
    expect(() => run.admitModel()).toThrow('run_paused');
    expect(run.snapshot()?.status).toBe('pausing');
    expect(() => run.resume(run.snapshot()!.runId, run.snapshot()!.revision)).toThrow('run_not_resumable');
    release();
    const paused = run.snapshot()!;
    expect(paused.status).toBe('paused');
    run.resume(paused.runId, paused.revision);
    expect(() => run.resume(paused.runId, paused.revision)).toThrow('run_revision_conflict');
    expect(run.snapshot()).toMatchObject({ runId: paused.runId, used: { modelCalls: 2 }, limits: { modelCalls: 4 }, grants: 2 });
  });
  it('pairs admitted tools and never admits a side effect past the limit', () => {
    const run = controller(); run.begin(); const release = run.enter();
    for (let i = 0; i < 3; i++) run.admitTool(`t${i}`, 'write', true);
    expect(() => run.admitTool('t4', 'write', true)).toThrow('run_paused');
    for (let i = 0; i < 3; i++) run.finishTool(`t${i}`);
    release();
    expect(run.snapshot()).toMatchObject({ status: 'paused', used: { toolCalls: 3 }, pendingTools: [] });
  });
  it('counts overlapping work once and excludes approval and paused time', () => {
    vi.useFakeTimers();
    const run = controller(); run.begin(); const first = run.enter(); const second = run.enter();
    vi.advanceTimersByTime(100);
    const stopWaiting = run.waitForApproval('approval');
    vi.advanceTimersByTime(2000);
    expect(run.snapshot()?.used.activeMs).toBe(100);
    stopWaiting(); vi.advanceTimersByTime(900);
    expect(run.snapshot()?.reason).toBe('duration_limit');
    first(); second(); vi.advanceTimersByTime(1000);
    expect(run.snapshot()?.used.activeMs).toBe(1000);
  });
  it('blocks a new workspace run while a cancelled old write has not exited', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-run-')); roots.push(root);
    const old = controller(); old.attachWorkspace(root); old.begin();
    const release = old.enter(); old.admitTool('write', 'write', true); old.cancel();
    const next = controller(); next.attachWorkspace(root);
    expect(() => next.begin()).toThrow('workspace_requires_inspection');
    old.finishTool('write'); release(); next.begin();
  });
  it('requires inspection for interrupted writes and does not auto resume after restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-run-')); roots.push(root);
    const file = path.join(root, 'run.json');
    const old = controller({ file }); old.begin(); old.admitTool('write', 'write', true);
    const restored = controller({ file });
    expect(restored.snapshot()).toMatchObject({ status: 'needs_attention', reason: 'interrupted_write', used: { toolCalls: 1 } });
    expect(restored.canContinueAutomatically()).toBe(false);
    expect(() => restored.begin()).toThrow('run_paused');
  });
  it('registers late background results without waking a paused task', () => {
    const run = controller(); run.begin(); run.retainTask('image'); run.pause('model_limit');
    run.finishTask('image');
    expect(run.snapshot()).toMatchObject({ status: 'paused', pendingTasks: [] });
    expect(run.canContinueAutomatically()).toBe(false);
  });
  it('rejects a damaged record instead of resetting allowance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-run-')); roots.push(root);
    const file = path.join(root, 'run.json'); fs.writeFileSync(file, '{"schemaVersion":1}');
    expect(() => controller({ file })).toThrow('record is invalid');
  });
  it('keeps isolation until a model request actually unwinds', () => {
    const run = controller(); run.begin();
    const release = run.enter(); const finishModel = run.modelWork();
    run.pause('duration_limit'); release();
    const snapshot = run.snapshot()!;
    expect(snapshot.status).toBe('pausing');
    expect(() => run.resume(snapshot.runId, snapshot.revision)).toThrow('run_not_resumable');
    finishModel();
    expect(run.snapshot()?.status).toBe('paused');
  });
  it('preserves measured time after interruption and discards the uncertain remainder on continuation', () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-run-')); roots.push(root);
    const file = path.join(root, 'run.json');
    const old = controller({ file }); old.begin(); old.enter();
    vi.advanceTimersByTime(100); old.admitModel();
    const restored = controller({ file });
    const snapshot = restored.snapshot()!;
    expect(snapshot).toMatchObject({ status: 'paused', activeTimeUncertain: true, used: { activeMs: 100 } });
    restored.resume(snapshot.runId, snapshot.revision);
    expect(restored.snapshot()).toMatchObject({ activeTimeUncertain: false, limits: { activeMs: 1100 }, used: { activeMs: 100 } });
  });
});
describe('absolute queue deadline', () => {
  it('expires before dispatch and supports cancellation', async () => {
    vi.useFakeTimers();
    const gate = createSubmissionGate('queue');
    const pending = gate.wait(new Promise(() => {}));
    const assertion = expect(pending).rejects.toThrow('submission_expired');
    await vi.advanceTimersByTimeAsync(SUBMISSION_WAIT_MS);
    await assertion;
    const cancelled = createSubmissionGate('cancelled');
    const result = cancelled.wait(new Promise(() => {}));
    cancelSessionSubmissions('cancelled');
    await expect(result).rejects.toThrow('submission_cancelled');
  });
});
