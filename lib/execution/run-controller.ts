import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_EXECUTION_RUN_LIMITS, isExecutionPaused } from '../../shared/execution-run.ts';
import type { ExecutionRunLimits, ExecutionRunSnapshot } from '../../shared/execution-run.ts';

export class ExecutionRunError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

type Options = {
  file?: string | null;
  limits?: ExecutionRunLimits;
  now?: () => number;
  onChange?: (run: ExecutionRunSnapshot) => void;
};
const owners = new Map<string, RunController>();
const workspaces = new Map<string, Set<RunController>>();
export const executionContext = new AsyncLocalStorage<RunController>();
const canonical = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

export function bindExecutionRun(sessionPath: string | null, run: RunController) {
  if (sessionPath) owners.set(canonical(sessionPath), run);
}
export function findExecutionRun(sessionPath: string | null | undefined) {
  return sessionPath ? owners.get(canonical(sessionPath)) : undefined;
}
export function loadExecutionRun(sessionPath: string, onChange?: Options['onChange']) {
  const existing = findExecutionRun(sessionPath);
  if (existing) return existing;
  const run = new RunController({ file: `${sessionPath}.run.json`, onChange });
  bindExecutionRun(sessionPath, run);
  return run;
}
export function executionRunForSession(sessionPath: string | null | undefined, onChange?: Options['onChange']) {
  return executionContext.getStore() || (sessionPath ? loadExecutionRun(sessionPath, onChange) : new RunController({ onChange }));
}

/** Move the transcript and its accounting together; never relocate live operations. */
export function moveSessionWithExecutionRunSync(from: string, to: string) {
  const run = findExecutionRun(from);
  run?.assertRelocatable();
  const pairs = ['', '.run.json', '.run.json.history']
    .map(suffix => [from + suffix, to + suffix] as const)
    .filter(([source]) => fs.existsSync(source));
  if (pairs.some(([, target]) => fs.existsSync(target))) throw new Error('Session or execution record destination already exists');
  const moved: Array<readonly [string, string]> = [];
  try {
    for (const pair of pairs) { fs.mkdirSync(path.dirname(pair[1]), { recursive: true }); fs.renameSync(...pair); moved.push(pair); }
  } catch (error) {
    for (const [source, target] of moved.reverse()) fs.renameSync(target, source);
    throw error;
  }
  if (run) {
    // Reload with the destination event binding when the session is next opened.
    owners.delete(canonical(from));
    run.relocated(to);
  }
}

/** A run owns admission, not provider pricing. Unknown prices/media remain usable. */
export class RunController {
  private state: ExecutionRunSnapshot | null = null;
  private readonly options: Options;
  private readonly now: () => number;
  private readonly limits: ExecutionRunLimits;
  private activeSince: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private abortController = new AbortController();
  private workers = 0;
  private modelRequests = 0;
  private waiting = new Set<string>();
  private failed = false;
  private readonly stopHandlers = new Set<() => void>();
  onStop(handler: () => void) {
    this.stopHandlers.add(handler);
    return () => { this.stopHandlers.delete(handler); };
  }
  private stop(reason: string) {
    this.abortController.abort(reason);
    for (const handler of this.stopHandlers) { try { handler(); } catch { /* Ownership stays locked until settlement. */ } }
  }
  markFailed(value = true) { this.failed = value; }

  constructor(options: Options = {}) {
    this.options = options;
    this.now = options.now || Date.now;
    this.limits = { ...DEFAULT_EXECUTION_RUN_LIMITS, ...options.limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid execution limits');
    }
    this.restore();
  }

  get signal() { return this.abortController.signal; }
  assertRelocatable() {
    if (this.workers || this.modelRequests || this.state?.pendingTools.length || this.state?.pendingTasks.length) {
      throw new ExecutionRunError('previous_run_still_active');
    }
  }
  relocated(sessionPath: string) {
    this.options.file = `${sessionPath}.run.json`;
    for (const [key, runs] of workspaces) {
      runs.delete(this);
      if (!runs.size) workspaces.delete(key);
    }
  }
  attachWorkspace(directory: string) {
    const key = canonical(fs.existsSync(directory) ? fs.realpathSync(directory) : directory);
    const runs = workspaces.get(key) || new Set<RunController>();
    runs.add(this); workspaces.set(key, runs);
  }
  private assertWorkspaceAvailable() {
    for (const runs of workspaces.values()) {
      if (!runs.has(this)) continue;
      for (const other of runs) {
        if (other === this) continue;
        const status = other.state?.status;
        if (status && !['running', 'waiting', 'completed', 'failed'].includes(status)
          && (other.workers > 0 || other.modelRequests > 0 || other.state!.pendingTools.some(tool => tool.write))) {
          throw new ExecutionRunError('workspace_requires_inspection');
        }
      }
    }
  }
  snapshot(): ExecutionRunSnapshot | null {
    if (!this.state) return null;
    if (this.state.reason === 'previous_owner_active' && this.state.ownerPid) {
      try { process.kill(this.state.ownerPid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          this.state.pendingTools = this.state.pendingTools.filter(tool => tool.write);
          this.state.status = this.state.pendingTools.length ? 'needs_attention' : 'paused';
          this.state.reason = this.state.pendingTools.length ? 'interrupted_write' : 'interrupted';
          this.state.activeTimeUncertain = true;
          this.persist();
        }
      }
    }
    const snapshot = structuredClone(this.state);
    if (this.activeSince !== null) snapshot.used.activeMs += Math.max(0, this.now() - this.activeSince);
    return snapshot;
  }
  canContinueAutomatically() {
    return !this.state || ['running', 'waiting', 'completed'].includes(this.state.status);
  }
  private restore() {
    if (!this.options.file || !fs.existsSync(this.options.file)) return;
    const saved = JSON.parse(fs.readFileSync(this.options.file, 'utf8')) as ExecutionRunSnapshot;
    if (saved.schemaVersion !== 1 || typeof saved.runId !== 'string' || !saved.runId
      || !Number.isSafeInteger(saved.revision) || saved.revision < 0
      || (saved.ownerPid !== undefined && (!Number.isSafeInteger(saved.ownerPid) || saved.ownerPid < 1))
      || (saved.activeTimeUncertain !== undefined && typeof saved.activeTimeUncertain !== 'boolean')
      || !Number.isSafeInteger(saved.startedAt) || !Number.isSafeInteger(saved.updatedAt)
      || !Number.isSafeInteger(saved.grants) || saved.grants < 1
      || !['running', 'waiting', 'pausing', 'paused', 'needs_attention', 'completed', 'failed', 'cancelled'].includes(saved.status)
      || !Array.isArray(saved.pendingTools) || !Array.isArray(saved.pendingTasks)
      || !saved.limits || !saved.used
      || ['modelCalls', 'toolCalls', 'activeMs'].some(key =>
        !Number.isSafeInteger(saved.limits[key]) || saved.limits[key] <= 0
        || !Number.isSafeInteger(saved.used[key]) || saved.used[key] < 0)
      || saved.pendingTools.some(tool => typeof tool.id !== 'string' || typeof tool.name !== 'string' || typeof tool.write !== 'boolean')
      || saved.pendingTasks.some(id => typeof id !== 'string')
      || [...Object.values(saved.limits), ...Object.values(saved.used)].some(n => !Number.isSafeInteger(n) || n < 0)) {
      throw new Error('Execution run record is invalid; recovery requires inspection.');
    }
    this.state = saved;
    if (saved.ownerPid && saved.ownerPid !== process.pid
      && (['running', 'waiting', 'pausing'].includes(saved.status) || saved.pendingTools.length > 0)) {
      try {
        process.kill(saved.ownerPid, 0);
        saved.status = 'needs_attention'; saved.reason = 'previous_owner_active';
        this.persist();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (['running', 'waiting', 'pausing'].includes(saved.status)
      || (saved.status === 'cancelled' && saved.pendingTools.length > 0)) {
      saved.status = saved.pendingTools.some(tool => tool.write) ? 'needs_attention' : 'paused';
      saved.reason = saved.status === 'needs_attention' ? 'interrupted_write' : 'interrupted';
      // Keep measured usage truthful. The remainder of this time grant is
      // discarded on explicit continuation, rather than reporting invented usage.
      saved.activeTimeUncertain = true;
      saved.pendingTools = saved.pendingTools.filter(tool => tool.write);
      this.persist();
    }
  }
  begin() {
    this.assertWorkspaceAvailable();
    if (isExecutionPaused(this.state)) throw new ExecutionRunError('run_paused');
    if (this.state?.status === 'waiting' && !this.workers && this.state.pendingTasks.length) throw new Error('session_busy');
    if (this.state && ['running', 'waiting'].includes(this.state.status)) return;
    if (this.workers || this.modelRequests || this.state?.pendingTools.length) throw new ExecutionRunError('previous_run_still_active');
    if (this.state && this.options.file) {
      const fd = fs.openSync(`${this.options.file}.history`, 'a', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(this.snapshot()) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    this.failed = false;
    this.abortController = new AbortController();
    this.state = {
      schemaVersion: 1, ownerPid: process.pid, runId: randomUUID(), revision: 0, status: 'running', reason: null,
      limits: { ...this.limits }, used: { modelCalls: 0, toolCalls: 0, activeMs: 0 },
      grants: 1, startedAt: this.now(), updatedAt: this.now(), pendingTools: [], pendingTasks: [],
    };
    this.persist();
  }
  activateContinuation() {
    if (this.state?.status === 'completed') {
      this.state.status = 'running';
      this.persist();
    }
    this.assertActive();
  }
  enter() {
    this.assertWorkspaceAvailable();
    this.assertActive();
    this.workers++;
    this.updateClock();
    let released = false;
    return (failed = false) => {
      if (released) return;
      released = true;
      this.failed ||= failed;
      this.workers--;
      this.settle();
    };
  }
  run<T>(operation: () => T): T { return executionContext.run(this, operation); }
  modelWork() {
    this.modelRequests++;
    this.updateClock();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true; this.modelRequests--; this.settle();
    };
  }
  assertActive() {
    if (!this.state) this.begin();
    if (!['running', 'waiting'].includes(this.state!.status)) throw new ExecutionRunError('run_paused');
    if (this.snapshot()!.used.activeMs >= this.state!.limits.activeMs) this.pause('duration_limit');
    if (isExecutionPaused(this.state)) throw new ExecutionRunError('run_paused');
  }
  admitModel() { this.admit('modelCalls'); }
  admitTool(id: string, name: string, write: boolean) {
    this.assertActive();
    if (this.state!.pendingTools.some(tool => tool.id === id)) throw new ExecutionRunError('duplicate_tool_call');
    this.admit('toolCalls');
    this.state!.pendingTools.push({ id, name, write });
    this.persist();
  }
  private admit(kind: 'modelCalls' | 'toolCalls') {
    this.assertActive();
    if (this.state!.used[kind] >= this.state!.limits[kind]) {
      this.pause(kind === 'modelCalls' ? 'model_limit' : 'tool_limit');
      throw new ExecutionRunError('run_paused');
    }
    this.state!.used[kind]++;
    this.persist(); // Synchronous durable admission before the side effect.
  }
  finishTool(id: string, uncertain = false) {
    if (!this.state) return;
    const tool = this.state.pendingTools.find(item => item.id === id);
    if (uncertain && tool?.write) {
      this.state.status = 'needs_attention';
      this.state.reason = 'unknown_write';
      this.stop('unknown_write');
    } else {
      this.state.pendingTools = this.state.pendingTools.filter(item => item.id !== id);
    }
    this.settle();
  }
  retainTask(id: string) {
    if (!this.state || this.state.pendingTasks.includes(id)) return;
    this.state.pendingTasks.push(id);
    this.updateClock();
    this.persist();
  }
  finishTask(id: string) {
    if (!this.state) return;
    this.state.pendingTasks = this.state.pendingTasks.filter(task => task !== id);
    this.settle();
  }
  waitForApproval(id: string) {
    this.waiting.add(id);
    this.updateClock();
    return () => { this.waiting.delete(id); this.updateClock(); };
  }
  pause(reason: string) {
    if (!this.state || isExecutionPaused(this.state)) return;
    this.state.status = this.workers || this.modelRequests || this.state.pendingTools.length ? 'pausing' : 'paused';
    this.state.reason = reason;
    this.updateClock();
    this.persist();
    this.stop(reason);
  }
  cancel() {
    if (!this.state) return;
    if (this.state.status !== 'needs_attention') {
      this.state.status = this.workers || this.modelRequests || this.state.pendingTools.length ? 'pausing' : 'cancelled';
      this.state.reason = 'cancelled';
    }
    this.updateClock();
    this.persist();
    this.stop('cancelled');
  }
  resume(runId: string, revision: number) {
    if (!this.state || this.state.runId !== runId || this.state.revision !== revision) throw new ExecutionRunError('run_revision_conflict');
    if (this.state.status !== 'paused' || this.workers || this.modelRequests || this.state.pendingTools.length) throw new ExecutionRunError('run_not_resumable');
    for (const key of ['modelCalls', 'toolCalls', 'activeMs'] as const) {
      this.state.limits[key] = (key === 'activeMs' && this.state.activeTimeUncertain
        ? this.state.used.activeMs : Math.max(this.state.limits[key], this.snapshot()!.used[key])) + this.limits[key];
    }
    this.state.activeTimeUncertain = false;
    this.state.grants++;
    this.state.status = 'running';
    this.state.ownerPid = process.pid;
    this.state.reason = null;
    this.abortController = new AbortController();
    this.persist();
    return this.snapshot()!;
  }
  acknowledgeResults(runId: string, revision: number, toolIds: string[]) {
    if (!this.state || this.state.runId !== runId || this.state.revision !== revision) throw new ExecutionRunError('run_revision_conflict');
    if (this.workers || this.modelRequests || this.state.status !== 'needs_attention'
      || !['unknown_write', 'interrupted_write'].includes(this.state.reason || '')
      || this.state.pendingTools.some(tool => !toolIds.includes(tool.id))) throw new ExecutionRunError('run_not_resumable');
    this.state.pendingTools = [];
    this.state.status = 'paused';
    this.state.reason = 'results_reviewed';
    this.persist();
    return this.snapshot();
  }
  private settle() {
    if (!this.state) return;
    if (this.workers === 0 && this.modelRequests === 0 && this.state.pendingTools.length === 0) {
      if (this.state.status === 'pausing') this.state.status = this.state.reason === 'cancelled' ? 'cancelled' : 'paused';
      else if (['running', 'waiting'].includes(this.state.status)) {
        this.state.status = this.state.pendingTasks.length ? 'waiting' : this.failed ? 'failed' : 'completed';
      }
    }
    this.updateClock();
    this.persist();
  }
  private updateClock() {
    const active = this.state && ['running', 'waiting'].includes(this.state.status)
      && (this.workers > 0 || this.modelRequests > 0 || this.state.pendingTasks.length > 0)
      && !(this.waiting.size > 0 && this.modelRequests === 0 && this.state.pendingTools.length <= this.waiting.size && this.state.pendingTasks.length === 0);
    if (this.activeSince !== null) {
      this.state!.used.activeMs += Math.max(0, this.now() - this.activeSince);
      this.activeSince = null;
    }
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null; this.heartbeat = null;
    if (!active) return;
    this.activeSince = this.now();
    this.timer = setTimeout(() => this.pause('duration_limit'), Math.max(1, this.state!.limits.activeMs - this.state!.used.activeMs));
    this.timer.unref?.();
    this.heartbeat = setInterval(() => { try { this.persist(); } catch { this.pause('persistence_failed'); } }, 5000);
    this.heartbeat.unref?.();
  }
  private persist() {
    if (!this.state) return;
    this.state.revision++;
    this.state.updatedAt = this.now();
    const snapshot = this.snapshot()!;
    if (this.options.file) {
      const temporary = `${this.options.file}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(snapshot)); fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, this.options.file);
      } catch (error) {
        this.state.status = 'needs_attention'; this.state.reason = 'persistence_failed';
        this.updateClock();
        this.stop('persistence_failed');
        throw error;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    this.options.onChange?.(snapshot);
  }
}
