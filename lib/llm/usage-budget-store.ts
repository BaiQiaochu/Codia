/** Durable local admission accounting. This is not a provider invoice or billing cap. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { usageCostRates } from './usage-pricing.ts';
const require = createRequire(import.meta.url);
export type Limit = { maxCalls?: number; maxTokens?: number; maxUsd?: number };
export type UsageBudgetConfig = { daily?: Limit; monthly?: Limit; memoryDaily?: Limit };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export class UsageBudgetError extends Error {
  code = 'USAGE_BUDGET_PAUSED';
  reason: string; resumeAt: string | null; scope: string;
  constructor(reason: string, resumeAt: string | null, scope: string) { super(`Usage budget paused: ${reason}`); this.reason = reason; this.resumeAt = resumeAt; this.scope = scope; }
}
export function normalizeBudgetConfig(value: unknown): UsageBudgetConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid usage budget configuration');
  const output: UsageBudgetConfig = {};
  for (const [scope, limits] of Object.entries(value)) {
    if (!['daily', 'monthly', 'memoryDaily'].includes(scope) || !limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('Invalid budget scope');
    const normalized: Limit = {};
    for (const [key, limit] of Object.entries(limits)) {
      if (!['maxCalls', 'maxTokens', 'maxUsd'].includes(key) || !finite(limit) || (key !== 'maxUsd' && !Number.isSafeInteger(limit))) throw new Error(`Invalid ${scope}.${key}`);
      normalized[key] = limit;
    }
    output[scope] = normalized;
  }
  return output;
}
export function estimateAdmission(model: any, maxOutputTokens?: number) {
  const input = Number.isSafeInteger(model?.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null;
  const output = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens! > 0 ? maxOutputTokens! : Number.isSafeInteger(model?.maxTokens) && model.maxTokens > 0 ? model.maxTokens : null;
  const rates = model?.cost?.zeroCostConfirmed !== undefined ? model.cost : usageCostRates(model);
  const known = rates && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => finite(rates[key]))
    && (!rates.currency || rates.currency === 'USD') && !rates.needsReview
    && (Math.max(rates.input, rates.output, rates.cacheRead, rates.cacheWrite) > 0 || rates.zeroCostConfirmed === true);
  const tokens = input !== null && output !== null ? input + output : null;
  const usd = known && input !== null && output !== null ? (input * Math.max(rates.input, rates.cacheRead, rates.cacheWrite) + output * rates.output) / 1_000_000 : null;
  return { reservedTokens: Number.isSafeInteger(tokens) ? tokens : null, reservedUsd: finite(usd) ? usd : null };
}
function period(scope: string, now: number) {
  const date = new Date(now);
  const monthly = scope === 'monthly';
  const since = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), monthly ? 1 : date.getUTCDate())).toISOString();
  const until = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + (monthly ? 1 : 0), monthly ? 1 : date.getUTCDate() + 1)).toISOString();
  return { since, until };
}
export class UsageBudgetStore {
  db: any;
  dbPath: string; now: () => number;
  constructor(dbPath: string, now = Date.now) {
    this.dbPath = dbPath; this.now = now;
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new (require('better-sqlite3'))(dbPath);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_entries (request_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_entries_time ON usage_entries(started_at);
      CREATE TABLE IF NOT EXISTS usage_reservations (request_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, subsystem TEXT NOT NULL, agent_id TEXT, run_id TEXT, job_id TEXT,
        state TEXT NOT NULL, reserved_tokens REAL, reserved_usd REAL, actual_tokens REAL, actual_usd REAL, cost_basis TEXT NOT NULL DEFAULT 'unknown', document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_reservations_time ON usage_reservations(started_at,subsystem,agent_id);
      CREATE TABLE IF NOT EXISTS usage_budget_pauses (scope TEXT NOT NULL, agent_id TEXT NOT NULL, reason TEXT NOT NULL, resume_at TEXT, observed_at TEXT NOT NULL, PRIMARY KEY(scope,agent_id));
    `);
    this.db.prepare("INSERT OR IGNORE INTO usage_metadata VALUES ('statisticsStartedAt',?)").run(new Date(now()).toISOString());
  }
  close() { if (this.db.open) this.db.close(); }
  getConfig(): UsageBudgetConfig { return JSON.parse(this.db.prepare("SELECT value FROM usage_metadata WHERE key='budgetConfig'").get()?.value || '{}'); }
  setConfig(value: unknown, expectedRevision?: number) {
    const config = normalizeBudgetConfig(value);
    this.db.transaction(() => {
      const revision = Number(this.db.prepare("SELECT value FROM usage_metadata WHERE key='budgetRevision'").get()?.value || 0);
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('Budget configuration changed; refresh before saving');
      this.db.prepare("INSERT INTO usage_metadata VALUES('budgetRevision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(revision + 1));
      this.db.prepare("INSERT INTO usage_metadata VALUES('budgetConfig',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
      this.db.prepare('DELETE FROM usage_budget_pauses').run();
    }).immediate();
    return config;
  }
  totals({ since = '', until = '9999', subsystem = null, agentId = null }: any = {}) {
    const rows = this.db.prepare(`SELECT * FROM usage_reservations WHERE started_at>=? AND started_at<? AND (? IS NULL OR subsystem=?) AND (? IS NULL OR agent_id=?)`).all(since, until, subsystem, subsystem, agentId, agentId);
    const sum = (key: string) => rows.reduce((value: number, row: any) => value + (finite(row[key]) ? row[key] : 0), 0);
    return { calls: rows.length, pendingCalls: rows.filter(row => row.state === 'pending').length,
      knownCostCalls: rows.filter(row => row.actual_usd !== null).length,
      unknownCostCalls: rows.filter(row => row.state !== 'pending' && row.actual_usd === null).length,
      unknownTokenCalls: rows.filter(row => row.state !== 'pending' && row.actual_tokens === null).length,
      knownUsd: sum('actual_usd'), knownTokens: sum('actual_tokens'),
      configuredEstimateUsd: rows.filter(row => row.cost_basis === 'configured_estimate').reduce((n,row) => n + (row.actual_usd || 0), 0),
      providerReportedUsd: rows.filter(row => row.cost_basis === 'provider_reported').reduce((n,row) => n + (row.actual_usd || 0), 0),
      reservedUsd: rows.filter(row => row.state === 'pending' || row.actual_usd === null).reduce((n,row) => n + (row.reserved_usd || 0), 0),
      reservedTokens: rows.filter(row => row.state === 'pending' || row.actual_tokens === null).reduce((n,row) => n + (row.reserved_tokens || 0), 0),
      unboundedCostCalls: rows.filter(row => row.actual_usd === null && row.reserved_usd === null).length,
      unboundedTokenCalls: rows.filter(row => row.actual_tokens === null && row.reserved_tokens === null).length };
  }
  reserve(meta: any, { observationOnly = false } = {}) {
    try {
      return this.db.transaction(() => {
        const config = this.getConfig();
        const estimate = estimateAdmission({ ...meta.model, cost: meta.costRates ?? meta.model?.cost }, meta.maxOutputTokens);
        const agentId = meta.attribution?.agentId || meta.source?.actor?.agentId || null;
        if (!observationOnly) for (const scope of ['daily', 'monthly', 'memoryDaily']) {
          const limits = config[scope];
          if (!limits || (scope === 'memoryDaily' && meta.source?.subsystem !== 'memory')) continue;
          const window = period(scope, this.now());
          const totals = this.totals({ ...window, ...(scope === 'memoryDaily' ? { subsystem: 'memory', agentId } : {}) });
          let reason = '';
          if (limits.maxCalls != null && totals.calls + 1 > limits.maxCalls) reason = 'call allowance exhausted';
          if (limits.maxTokens != null && (estimate.reservedTokens === null || totals.unboundedTokenCalls > 0)) reason = 'token reservation or prior usage unknown';
          else if (limits.maxTokens != null && totals.knownTokens + totals.reservedTokens + estimate.reservedTokens! > limits.maxTokens) reason = 'token allowance exhausted';
          if (limits.maxUsd != null && (estimate.reservedUsd === null || totals.unknownCostCalls > 0 || totals.unboundedCostCalls > 0)) reason = 'price or prior provider usage unknown; review configuration or wait for the next UTC period';
          else if (limits.maxUsd != null && totals.knownUsd + totals.reservedUsd + estimate.reservedUsd! > limits.maxUsd) reason = 'USD reservation allowance exhausted';
          if (reason) throw new UsageBudgetError(reason, window.until, scope);
        }
        this.db.prepare(`INSERT INTO usage_reservations(request_id,started_at,subsystem,agent_id,run_id,job_id,state,reserved_tokens,reserved_usd,document) VALUES(?,?,?,?,?,?,'pending',?,?,?)`)
          .run(meta.requestId, meta.startedAt, meta.source?.subsystem || 'unknown', agentId, meta.attribution?.runId || null, meta.attribution?.jobId || meta.attribution?.taskId || null, estimate.reservedTokens, estimate.reservedUsd, JSON.stringify({
            requestId: meta.requestId, startedMs: meta.startedMs, startedAt: meta.startedAt,
            source: meta.source, attribution: meta.attribution, costRates: meta.costRates, pricing: meta.pricing, reservationBinding: meta.reservationBinding,
            model: { provider: meta.model?.provider ?? null, modelId: meta.model?.modelId || meta.model?.id || null, api: meta.model?.api || null,
              contextWindow: meta.model?.contextWindow ?? null, maxTokens: meta.model?.maxTokens ?? null },
          }));
        return estimate;
      }).immediate();
    } catch (error) {
      if (error instanceof UsageBudgetError) this.db.prepare('INSERT INTO usage_budget_pauses VALUES(?,?,?,?,?) ON CONFLICT(scope,agent_id) DO UPDATE SET reason=excluded.reason,resume_at=excluded.resume_at,observed_at=excluded.observed_at')
        .run(error.scope, meta.attribution?.agentId || '', error.reason, error.resumeAt, new Date(this.now()).toISOString());
      throw error;
    }
  }
  pending(requestId: string) { const row = this.db.prepare("SELECT document FROM usage_reservations WHERE request_id=? AND state='pending'").get(requestId); return row ? JSON.parse(row.document) : null; }
  settle(entry: any) {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO usage_entries VALUES(?,?,?,?)').run(entry.requestId, entry.startedAt, entry.endedAt, JSON.stringify(entry));
      const cost = finite(entry.usage?.costTotal) ? entry.usage.costTotal : null;
      const tokens = finite(entry.usage?.totalTokens) ? entry.usage.totalTokens : null;
      this.db.prepare("UPDATE usage_reservations SET state=?,actual_tokens=?,actual_usd=?,cost_basis=? WHERE request_id=? AND state='pending'")
        .run(cost === null || tokens === null ? 'unknown' : 'settled', tokens, cost, entry.costBasis || 'unknown', entry.requestId);
    }).immediate();
  }
  entries() { return this.db.prepare('SELECT document FROM usage_entries ORDER BY started_at,rowid').all().map(row => JSON.parse(row.document)); }
  report(agentId?: string) {
    const now = this.now();
    return { config: this.getConfig(), revision: Number(this.db.prepare("SELECT value FROM usage_metadata WHERE key='budgetRevision'").get()?.value || 0), currency: 'USD', timezone: 'UTC', recoveryPolicy: 'Pending means unsettled: the request may still be active or may have been interrupted. Full reservations survive restart; no owner-liveness detection or automatic release is performed.', note: '本地模型准入预留，非供应商账单硬上限。供应商报告金额也不等同于已核对账单。未知用量保留预留；日/月额度按 UTC 重置。',
      totals: this.totals(), daily: { ...period('daily', now), ...this.totals(period('daily', now)) }, monthly: { ...period('monthly', now), ...this.totals(period('monthly', now)) },
      memoryDaily: { ...period('daily', now), ...this.totals({ ...period('daily', now), subsystem: 'memory', agentId: agentId || null }) },
      pauses: this.db.prepare('SELECT scope,agent_id AS agentId,reason,resume_at AS resumeAt,observed_at AS observedAt FROM usage_budget_pauses WHERE resume_at>? AND (? IS NULL OR agent_id=?)').all(new Date(now).toISOString(), agentId || null, agentId || null),
      statisticsStartedAt: this.db.prepare("SELECT value FROM usage_metadata WHERE key='statisticsStartedAt'").get().value };
  }
}
