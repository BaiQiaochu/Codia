import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolActionMetadata } from '../../shared/task-console/tool-actions.ts';
import { approvalDigest } from '../permission/approval-binding.ts';

export type ActionState = 'planned' | 'running' | 'succeeded' | 'unknown';
export type ActionBinding = {
  actionId: string;
  toolName: string;
  parameterDigest: string;
  scopeDigest: string;
  sessionRef?: string;
  readOnly: boolean;
  traceId?: string;
  toolTraceId?: string;
  approval: { mode: string; decision: string; confirmId?: string; reviewer?: string };
};
export type ActionRecord = ActionBinding & {
  version: 1;
  state: ActionState;
  createdAt: string;
  updatedAt: string;
};

export class ToolActionLedgerError extends Error {
  code: string;
  actionId: string;
  constructor(code: string, message: string, actionId: string) {
    super(message); this.code = code; this.actionId = actionId;
  }
}

/** ID uses call identity, not parameters: changed parameters cannot evade duplicate detection. */
export function toolActionId(sessionPath: string, callId: string): string {
  return `action_${createHash('sha256').update(JSON.stringify([sessionPath, callId])).digest('hex')}`;
}

/**
 * Durable fail-closed journal. A running/unknown write needs external reconciliation;
 * a successful write is not replayed. This is NOT an external exactly-once guarantee.
 * No parameters, outputs, credential-bearing scope paths or error messages are stored.
 */
export class ToolActionLedger {
  private directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private path(actionId: string) {
    if (!/^action_[a-f0-9]{64}$/.test(actionId)) throw new Error('Invalid tool action ID');
    return join(this.directory, `${actionId}.json`);
  }

  private syncDirectory() {
    // Windows does not support opening/fsyncing directory handles via Node.
    if (process.platform === 'win32') return;
    const fd = openSync(this.directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private write(record: ActionRecord, exclusive = false) {
    const destination = this.path(record.actionId);
    const temporary = exclusive ? destination : `${destination}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    if (!exclusive) {
      try { renameSync(temporary, destination); } catch (error) { unlinkSync(temporary); throw error; }
    }
    this.syncDirectory();
  }

  get(actionId: string): ActionRecord | null {
    const path = this.path(actionId);
    if (!existsSync(path)) return null;
    // Corruption is intentionally not treated as an absent entry.
    const record = JSON.parse(readFileSync(path, 'utf8')) as ActionRecord;
    if (record.version !== 1 || record.actionId !== actionId || !['planned', 'running', 'succeeded', 'unknown'].includes(record.state)) {
      throw new Error('Invalid tool action ledger record');
    }
    return record;
  }

  /** Strict allowlist: legacy/extra JSON keys can never leak through the owner API. */
  inspect(actionId: string): ToolActionMetadata | null {
    const record = this.get(actionId);
    if (!record) return null;
    const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : null;
    const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
    const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    return {
      actionId: record.actionId, state: record.state,
      toolName: identifier(record.toolName) || '[unavailable]', readOnly: record.readOnly === true,
      sessionRef: digest(record.sessionRef), scopeRef: digest(record.scopeDigest),
      traceId: identifier(record.traceId), toolTraceId: identifier(record.toolTraceId),
      confirmationId: identifier(record.approval?.confirmId),
      createdAt: date(record.createdAt), updatedAt: date(record.updatedAt),
    };
  }

  list(limit = 100): { actions: ToolActionMetadata[]; unreadableCount: number; total: number } {
    const actions: ToolActionMetadata[] = [];
    let unreadableCount = 0;
    for (const name of readdirSync(this.directory)) {
      if (!/^action_[a-f0-9]{64}\.json$/.test(name)) continue;
      try { const record = this.inspect(name.slice(0, -5)); if (record) actions.push(record); }
      catch { unreadableCount++; }
    }
    actions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.actionId.localeCompare(b.actionId));
    return { actions: actions.slice(0, Math.max(1, Math.min(200, Math.floor(limit) || 100))), unreadableCount, total: actions.length + unreadableCount };
  }

  begin(binding: ActionBinding): ActionRecord {
    const now = new Date().toISOString();
    const record: ActionRecord = { ...binding, version: 1, state: 'planned', createdAt: now, updatedAt: now };
    try { this.write(record, true); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = this.get(binding.actionId);
      if (!existing || existing.toolName !== binding.toolName || existing.parameterDigest !== binding.parameterDigest
        || existing.scopeDigest !== binding.scopeDigest || existing.readOnly !== binding.readOnly) {
        throw new ToolActionLedgerError('ACTION_BINDING_CHANGED', 'Action parameters or scope changed; use a newly authorized action.', binding.actionId);
      }
      if (!binding.readOnly) {
        throw new ToolActionLedgerError(existing.state === 'succeeded' ? 'ACTION_ALREADY_COMPLETED' : 'ACTION_RESULT_UNKNOWN',
          existing.state === 'succeeded' ? 'This action already completed. It will not be executed again.'
            : 'This action may already have changed external state. Check its result before starting a new action.', binding.actionId);
      }
      // Only explicitly recognized reads can safely be retried after an interrupted attempt.
      record.createdAt = existing.createdAt;
    }
    record.state = 'running';
    record.updatedAt = new Date().toISOString();
    this.write(record);
    return record;
  }

  finish(record: ActionRecord, succeeded: boolean): void {
    this.write({ ...record, state: succeeded ? 'succeeded' : 'unknown', updatedAt: new Date().toISOString() });
  }
}

// Permission allow does not imply safe retry. Unknown tools, shell and browser remain writes.
export function isRetrySafeRead(tool: { name?: string; _pluginId?: string; pluginId?: string; _toolSource?: string }): boolean {
  if (tool._pluginId || tool.pluginId || (tool._toolSource && tool._toolSource !== 'builtin')) return false;
  return new Set(['read', 'grep', 'find', 'ls', 'web_search', 'web_fetch', 'search_memory', 'recall_experience', 'current_status']).has(tool.name || '');
}

export function actionScopeDigest(scope: unknown): string { return approvalDigest('tool-action-scope', scope, null); }

export function toolActionSessionRef(sessionPath: string): string { return actionScopeDigest({ sessionPath }); }
