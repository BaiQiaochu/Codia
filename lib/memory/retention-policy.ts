/** Conservative retention: compact successes only; retain revocations and idempotency receipts forever. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export type MemoryRetentionPolicy = { completedExtractionDays: number | null; ordinaryEventDays: number | null };
export const DEFAULT_MEMORY_RETENTION: MemoryRetentionPolicy = { completedExtractionDays: null, ordinaryEventDays: null };
export function normalizeRetentionPolicy(value: unknown): MemoryRetentionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['completedExtractionDays', 'ordinaryEventDays'].includes(key))) throw new Error('Invalid retention policy');
  const result = { ...DEFAULT_MEMORY_RETENTION };
  for (const key of Object.keys(result)) {
    const days = (value as any)[key];
    if (days !== null && days !== undefined && (!Number.isSafeInteger(days) || days < 1 || days > 36500)) throw new Error('Retention must be 1–36500 days or disabled');
    result[key] = days ?? null;
  }
  return result;
}
export function readRetentionPolicy(memoryDir: string): MemoryRetentionPolicy {
  try { return normalizeRetentionPolicy(JSON.parse(fs.readFileSync(path.join(memoryDir, 'retention-policy.json'), 'utf8'))); }
  catch (error: any) { if (error.code === 'ENOENT') return { ...DEFAULT_MEMORY_RETENTION }; throw error; }
}
export function retentionPolicyRevision(policy: MemoryRetentionPolicy) { return createHash('sha256').update(JSON.stringify(policy)).digest('hex'); }
/** SQLite serializes file-policy CAS and explicit cleanup across processes; a crash releases the lock. */
export function withCurrentRetentionPolicy<T>(memoryDir: string, expectedRevision: string | undefined, operation: (policy: MemoryRetentionPolicy) => T): T {
  fs.mkdirSync(memoryDir, { recursive: true });
  const db = new (require('better-sqlite3'))(path.join(memoryDir, 'retention-policy-lock.sqlite'));
  db.pragma('busy_timeout = 5000');
  try { return db.transaction(() => {
    const policy = readRetentionPolicy(memoryDir);
    if (expectedRevision !== undefined && expectedRevision !== retentionPolicyRevision(policy)) throw Object.assign(new Error('Retention policy changed; refresh before applying'), { status: 409 });
    return operation(policy);
  }).immediate(); } finally { db.close(); }
}
export function writeRetentionPolicy(memoryDir: string, value: unknown, expectedRevision?: string) {
  return withCurrentRetentionPolicy(memoryDir, expectedRevision, () => writePolicyFile(memoryDir, value));
}
function writePolicyFile(memoryDir: string, value: unknown) {
  const policy = normalizeRetentionPolicy(value); fs.mkdirSync(memoryDir, { recursive: true });
  const file = path.join(memoryDir, 'retention-policy.json'), tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(policy, null, 2)); fs.renameSync(tmp, file); return policy;
}
function tables(db: any) { return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)); }
export function retentionReport(factStore: any, experienceStore?: any) {
  const db = factStore?.db, ex = experienceStore?.db;
  const extractions = db ? db.prepare('SELECT status,COUNT(*) AS count FROM memory_extractions GROUP BY status').all() : [];
  const ordinaryEvents = ex ? ex.prepare("SELECT COUNT(*) AS count FROM experience_events WHERE event IN ('retrieved','injected')").get().count : 0;
  const receipts = ex && tables(ex).has('experience_event_receipts') ? ex.prepare('SELECT COUNT(*) AS count FROM experience_event_receipts').get().count : 0;
  return { extractions, ordinaryEvents, archivedEventReceipts: receipts,
    protected: ['failed / quarantined / running / unknown records', 'extraction idempotency keys', 'experience outcomes and adoption evidence', 'tombstones, revocations, reset markers and lifecycle journals'],
    note: '已完成提取仅压缩来源明细并保留成功收据；普通检索/注入事件归档成幂等收据。无日期旧事件保留，未知与失败不清理。收据会继续占用少量空间。' };
}
export function applyMemoryRetention(factStore: any, experienceStore: any, policy: MemoryRetentionPolicy, now = Date.now()) {
  const checked = normalizeRetentionPolicy(policy);
  let compactedExtractions = 0, archivedEvents = 0;
  if (checked.completedExtractionDays !== null && factStore?.db) {
    const cutoff = new Date(now - checked.completedExtractionDays * 86400000).toISOString();
    compactedExtractions = factStore.db.transaction(() => factStore.db.prepare("UPDATE memory_extractions SET source_refs='[]',error=NULL,next_retry_at=NULL,lease_token=NULL,lease_until=NULL WHERE status='succeeded' AND updated_at<? AND (source_refs!='[]' OR error IS NOT NULL OR lease_token IS NOT NULL)").run(cutoff).changes).immediate();
  }
  const db = experienceStore?.db;
  if (checked.ordinaryEventDays !== null && db && tables(db).has('experience_event_receipts')) {
    const cutoff = new Date(now - checked.ordinaryEventDays * 86400000).toISOString();
    archivedEvents = db.transaction(() => {
      // Only known dated ordinary reads are eligible; successful outcomes and unknown outcomes never expire here.
      const rows = db.prepare("SELECT * FROM experience_events WHERE event IN ('retrieved','injected') AND created_at IS NOT NULL AND created_at<?").all(cutoff);
      const insert = db.prepare('INSERT OR IGNORE INTO experience_event_receipts(event_key,experience_id,run_id,event,experience_revision,payload,created_at) VALUES(@event_key,@experience_id,@run_id,@event,@experience_revision,@payload,@created_at)');
      for (const row of rows) {
        insert.run(row);
        const receipt = db.prepare('SELECT payload FROM experience_event_receipts WHERE event_key=?').get(row.event_key);
        if (receipt?.payload !== row.payload) throw new Error('Conflicting idempotency receipt; retention stopped');
        db.prepare('DELETE FROM experience_events WHERE event_key=?').run(row.event_key);
      }
      return rows.length;
    }).immediate();
  }
  return { compactedExtractions, archivedEvents, ...retentionReport(factStore, experienceStore) };
}
/** Budget rejection is not a failed extraction attempt and cannot cause quarantine. */
export function deferExtractionForBudget(store: any, key: string, claim: any, error: any) {
  if (error?.code !== 'USAGE_BUDGET_PAUSED' || !store?.db || !claim?.token) return false;
  const resumeAt = error.resumeAt || new Date(Date.now() + 3600000).toISOString();
  return store.db.prepare("UPDATE memory_extractions SET status='failed',attempts=MAX(0,attempts-1),error=?,next_retry_at=?,lease_token=NULL,lease_until=NULL WHERE key=? AND lease_token=? AND status='running'")
    .run(`Budget paused: ${error.reason || 'allowance unavailable'}`, resumeAt, key, claim.token).changes > 0;
}
