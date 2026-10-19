// @ts-nocheck
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scrubPII } from '../pii-guard.ts';
import { appendMemoryRevocation, memoryContentHash, readMemoryLifecycle, scrubMemorySecrets } from './memory-lifecycle.ts';
import { readCompiledGeneration } from './compiled-memory-state.ts';
import { normalizeGovernanceQuery, literalLike, projectOption } from './governance-query.ts';
import { openExperienceStore } from '../experience-store.ts';

const require = createRequire(import.meta.url);
let BetterSqliteDatabase = null;
export function loadBetterSqliteDatabase() {
  if (!BetterSqliteDatabase) BetterSqliteDatabase = require('better-sqlite3');
  return BetterSqliteDatabase;
}
const SCHEMA_VERSION = 5;
const STATES = ['active', 'candidate', 'expired', 'conflict', 'superseded', 'deleted'];
const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const safe = (value) => scrubPII(scrubMemorySecrets(String(value || ''))).cleaned;
const iso = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** The SQLite records and extraction ledger are authoritative. JSON snapshots are repairable caches. */
export class FactStore {
  constructor(dbPath) {
    this.memoryDir = dbPath === ':memory:' ? null : path.dirname(path.resolve(dbPath));
    this._lifecycle = readMemoryLifecycle(this.memoryDir);
    const Database = loadBetterSqliteDatabase();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('cache_size = -16000');
    this.db.pragma('temp_store = MEMORY');
    this._migrate();
    this._replayRevocations();
  }

  _migrate() {
    this.db.transaction(() => {
      const needsUpgrade = this.db.pragma('user_version', { simple: true }) < SCHEMA_VERSION;
      this.db.exec(`CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, fact TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
        time TEXT, session_id TEXT, created_at TEXT NOT NULL)`);
      const columns = new Set(this.db.prepare('PRAGMA table_info(facts)').all().map(c => c.name));
      const additions = {
        source: 'TEXT', updated_at: 'TEXT', status: "TEXT NOT NULL DEFAULT 'active'",
        memory_id: 'TEXT', source_refs: "TEXT NOT NULL DEFAULT '[]'", source_revision: 'TEXT', extractor_version: 'TEXT',
        project_id: 'TEXT', channel_id: 'TEXT', scope: "TEXT NOT NULL DEFAULT 'global'", kind: "TEXT NOT NULL DEFAULT 'fact'",
        observed_at: 'TEXT', valid_from: 'TEXT', valid_to: 'TEXT', expires_at: 'TEXT', last_verified_at: 'TEXT',
        revision: 'INTEGER NOT NULL DEFAULT 1', schema_version: 'INTEGER NOT NULL DEFAULT 1',
        review_status: "TEXT NOT NULL DEFAULT 'unverified'", content_hash: 'TEXT', extraction_key: 'TEXT',
      };
      for (const [name, type] of Object.entries(additions)) if (!columns.has(name)) this.db.exec(`ALTER TABLE facts ADD COLUMN ${name} ${type}`);
      this.db.exec(`UPDATE facts SET updated_at=created_at WHERE updated_at IS NULL;
        UPDATE facts SET source='session:'||session_id WHERE source IS NULL AND session_id IS NOT NULL;
        UPDATE facts SET observed_at=created_at WHERE observed_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_facts_time ON facts(time);
        CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);
        CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(status, project_id, channel_id);
        CREATE INDEX IF NOT EXISTS idx_facts_hash ON facts(content_hash);
        CREATE TABLE IF NOT EXISTS memory_extractions (
          key TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_revision TEXT NOT NULL, extractor_version TEXT NOT NULL,
          status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, facts_added INTEGER NOT NULL DEFAULT 0,
          error TEXT, next_retry_at TEXT, updated_at TEXT NOT NULL, lease_token TEXT, lease_until TEXT,
          generation TEXT NOT NULL, source_refs TEXT NOT NULL DEFAULT '[]');
        CREATE TABLE IF NOT EXISTS memory_revocations (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      `);
      const extractionColumns = new Set(this.db.prepare('PRAGMA table_info(memory_extractions)').all().map(c=>c.name));
      if (!extractionColumns.has('project_id')) this.db.exec('ALTER TABLE memory_extractions ADD COLUMN project_id TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_extraction_review ON memory_extractions(status,project_id,updated_at)');
      for (const row of (needsUpgrade ? this.db.prepare('SELECT id,fact,tags,session_id,source,content_hash,memory_id,source_refs FROM facts').all() : [])) {
        const safeFact = safe(row.fact);
        const refs = row.source_refs !== '[]' ? row.source_refs : JSON.stringify(row.session_id ? [{ kind: 'session', sessionId: row.session_id }] : row.source ? [{ kind: 'legacy', id: row.source }] : []);
        this.db.prepare('UPDATE facts SET memory_id=?,content_hash=?,source_refs=?,fact=?,tags=?,source=? WHERE id=?')
          .run(row.memory_id || randomUUID(), memoryContentHash(safeFact), JSON.stringify(JSON.parse(refs, (_key,value) => typeof value === 'string' ? safe(value) : value)), safeFact, JSON.stringify(json(row.tags,[]).map(safe)), row.source ? safe(row.source) : null, row.id);
        if (inferChannel(row.session_id)) this.db.prepare('UPDATE facts SET channel_id=COALESCE(channel_id,?) WHERE id=?').run(inferChannel(row.session_id),row.id);
      }
      // Upgrade legacy tokenizers once. All statuses remain indexed, eligibility is enforced at query time.
      if (this.db.pragma('user_version', { simple: true }) < SCHEMA_VERSION) {
        this.db.exec(`DROP TRIGGER IF EXISTS facts_ai; DROP TRIGGER IF EXISTS facts_ad; DROP TRIGGER IF EXISTS facts_au;
          DROP TABLE IF EXISTS facts_fts;
          CREATE VIRTUAL TABLE facts_fts USING fts5(fact,content=facts,content_rowid=id,tokenize='trigram');
          INSERT INTO facts_fts(facts_fts) VALUES ('rebuild');`);
      }
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(fact,content=facts,content_rowid=id,tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts(rowid,fact) VALUES(new.id,new.fact); END;
        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN INSERT INTO facts_fts(facts_fts,rowid,fact) VALUES('delete',old.id,old.fact); END;
        CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts,rowid,fact) VALUES('delete',old.id,old.fact); INSERT INTO facts_fts(rowid,fact) VALUES(new.id,new.fact); END;`);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  get generation() { return this.memoryDir ? readCompiledGeneration(this.memoryDir) : this._lifecycle.generation; }
  _replayRevocations() {
    this._lifecycle = this.memoryDir ? readMemoryLifecycle(this.memoryDir) : this._lifecycle;
    this.db.transaction(() => {
      for (const event of this._lifecycle.tombstones) {
        if (this.db.prepare('SELECT 1 FROM memory_revocations WHERE event_id=?').get(event.eventId)) continue;
        if (event.all) this.db.prepare('DELETE FROM facts WHERE created_at<=?').run(event.at);
        for (const record of event.records || []) this.db.prepare(`DELETE FROM facts WHERE
          (memory_id=? AND revision<=?) OR (content_hash=? AND COALESCE(project_id,'')=? AND COALESCE(session_id,'')=? AND updated_at<=?)`)
          .run(record.memoryId,record.revision,record.hash,record.projectId || '',record.sessionId || '',event.at);
        this.db.prepare('INSERT INTO memory_revocations VALUES (?,?)').run(event.eventId, JSON.stringify(event));
      }
    })();
  }

  _isRevoked(entry, hash) {
    const state = this.memoryDir ? readMemoryLifecycle(this.memoryDir) : this._lifecycle;
    return state.tombstones.some(event => {
      if (entry.reviewStatus === 'user_confirmed' && entry.observedAt > event.at) return false;
      if ((event.records || []).some(record => entry.memoryId === record.memoryId && entry.revision > record.revision && entry.updated_at > event.at)) return false;
      return (event.records || []).some(record => (entry.memoryId && entry.memoryId === record.memoryId && (entry.revision || 1) <= record.revision)
        || (record.hash === hash && (record.projectId || null) === (entry.projectId || entry.project_id || null) && (record.sessionId || null) === (entry.session_id || null)))
        || (event.all && entry.created_at && entry.created_at <= event.at)
        || ((event.sessions || []).includes(entry.session_id) && (!entry.observedAt || entry.observedAt <= event.at));
    });
  }

  _revoke(records, reason, all = false) {
    this._lifecycle = appendMemoryRevocation(this.memoryDir, {
      reason, all,
      records: records.map(r => ({ memoryId:r.memoryId,revision:r.revision,hash:memoryContentHash(r.fact),projectId:r.projectId,sessionId:r.session_id })),
      sessions: [...new Set(records.map(r => r.session_id).filter(Boolean))],
      memoryIds: records.map(r => r.memoryId),
      factIds: records.map(r => String(r.id)),
      sourceRefs: records.flatMap(r => (r.sourceRefs || []).flatMap(ref => [
        ...(ref.messageId ? [{ type: 'message', id: ref.messageId }] : []),
        ...(ref.runId ? [{ type: 'run', id: ref.runId }] : []),
      ])),
    }, this._lifecycle);
    this.onInvalidated?.();
    // Downstream experiences are data, not an independent route around forgetting.
    if (this.memoryDir && path.basename(this.memoryDir) === 'memory') {
      const experience = openExperienceStore(path.dirname(this.memoryDir));
      try {
        if (all) experience.clear();
        else experience.invalidateSources(records.flatMap(r => [
          { type: 'fact', id: String(r.id) }, { type: 'memory', id: r.memoryId },
          ...(r.session_id ? [{ type: 'session', id: r.session_id }] : []),
          ...(r.sourceRefs || []).flatMap(ref => [
            ...(ref.messageId ? [{ type: 'message', id: ref.messageId }] : []),
            ...(ref.runId ? [{ type: 'run', id: ref.runId }] : []),
          ]),
        ]), reason);
      } finally { experience.close(); }
    }
    return this._lifecycle.tombstones.at(-1);
  }

  add(entry) {
    if (typeof entry?.fact !== 'string' || !entry.fact.trim()) throw new Error('Fact must be a nonempty string');
    for (const key of ['observedAt','validFrom','validTo','expiresAt','lastVerifiedAt']) {
      if (entry[key] !== undefined && entry[key] !== null && !iso(entry[key])) throw new Error(`Invalid memory ${key}`);
    }
    const suppliedRefs = entry.sourceRefs || entry.source_refs;
    if (suppliedRefs !== undefined && (!Array.isArray(suppliedRefs) || suppliedRefs.some(ref => !ref || typeof ref !== 'object' || Array.isArray(ref)))) throw new Error('Invalid sourceRefs');
    const fact = safe(entry.fact.trim());
    const hash = memoryContentHash(fact);
    if (this._isRevoked(entry, hash)) return { id: null, skipped: true, reason: 'revoked' };
    const projectId = entry.projectId || entry.project_id || null;
    const existing = this.db.prepare("SELECT id FROM facts WHERE content_hash=? AND COALESCE(project_id,'')=? AND COALESCE(session_id,'')=? AND status!='deleted'")
      .get(hash, projectId || '', entry.session_id || '');
    if (existing) return { id: existing.id, skipped: true, reason: 'duplicate' };
    const now = new Date().toISOString();
    const source = entry.source || (entry.session_id ? `session:${entry.session_id}` : null);
    const refs = entry.sourceRefs || entry.source_refs || (entry.session_id ? [{ kind: 'session', sessionId: entry.session_id, revision: entry.sourceRevision || null }] : source ? [{ kind: 'legacy', id: source }] : []);
    const data = {
      fact, tags: JSON.stringify((entry.tags || []).filter(t => typeof t === 'string').map(safe)), time: entry.time || null,
      session_id: entry.session_id || null, created_at: iso(entry.created_at) || now, updated_at: now,
      source: source ? safe(source) : null, status: STATES.includes(entry.status) ? entry.status : 'active',
      memory_id: entry.memoryId || randomUUID(), source_refs: safe(JSON.stringify(refs)),
      source_revision: entry.sourceRevision || entry.source_revision || null, extractor_version: entry.extractorVersion || null,
      project_id: projectId, channel_id: entry.channelId || entry.channel_id || inferChannel(entry.session_id),
      scope: projectId ? 'project' : 'global', kind: entry.kind || 'fact', observed_at: iso(entry.observedAt) || now,
      valid_from: iso(entry.validFrom), valid_to: iso(entry.validTo), expires_at: iso(entry.expiresAt), last_verified_at: iso(entry.lastVerifiedAt),
      revision: Number.isInteger(entry.revision) && entry.revision > 0 ? entry.revision : 1, schema_version: 1,
      review_status: entry.reviewStatus || 'unverified', content_hash: hash, extraction_key: entry.extractionKey || null,
    };
    // Scrubbing stringified JSON can damage quoted values; serialize scrubbed leaves instead.
    data.source_refs = JSON.stringify(JSON.parse(JSON.stringify(refs), (_key, value) => typeof value === 'string' ? safe(value) : value));
    const names = Object.keys(data);
    const result = this.db.prepare(`INSERT INTO facts(${names.join(',')}) VALUES(${names.map(k => `@${k}`).join(',')})`).run(data);
    return { id: Number(result.lastInsertRowid) };
  }
  addBatch(entries) {
    return this.db.transaction(() => entries.reduce((count, entry) => count + (this.add(entry).skipped ? 0 : 1), 0))();
  }

  _where(filters = {}, dateRange = null) {
    const where = ["f.status='active'", '(f.expires_at IS NULL OR f.expires_at>@now)', '(f.valid_to IS NULL OR f.valid_to>@now)', '(f.valid_from IS NULL OR f.valid_from<=@now)', '(f.observed_at IS NULL OR f.observed_at<=@now)'];
    const params = { now: iso(filters.now) || new Date().toISOString() };
    if (filters.projectId) {
      where.push(filters.includeGlobal === false ? 'f.project_id=@projectId' : '(f.project_id=@projectId OR f.project_id IS NULL)');
      params.projectId = filters.projectId;
    } else where.push('f.project_id IS NULL');
    if (filters.excludeChannels === true) where.push('f.channel_id IS NULL');
    if (filters.channelId && filters.crossChannel !== true) {
      where.push('(f.channel_id IS NULL OR f.channel_id=@channelId)'); params.channelId = filters.channelId;
    }
    const dates = dateRange || filters.dateRange;
    if (dates?.from) { where.push('f.time>=@dateFrom'); params.dateFrom = dates.from; }
    if (dates?.to) { where.push('f.time<=@dateTo'); params.dateTo = dates.to; }
    return { sql: where.join(' AND '), params };
  }
  searchByTags(queryTags, dateRange, limit = 20, filters = {}) {
    if (!queryTags?.length) return [];
    this._replayRevocations();
    const { sql, params } = this._where(filters, dateRange);
    params.limit = Math.max(0, Math.floor(limit));
    queryTags.forEach((tag, i) => { params[`tag${i}`] = tag; });
    return this.db.prepare(`SELECT f.*,COUNT(DISTINCT je.value) AS matchCount FROM facts f,json_each(f.tags) je
      WHERE ${sql} AND je.value IN (${queryTags.map((_,i) => `@tag${i}`).join(',')})
      GROUP BY f.id ORDER BY matchCount DESC,f.time DESC LIMIT @limit`).all(params).map(r => this._rowToFact(r));
  }
  searchFullText(query, limit = 20, filters = {}) {
    if (!query?.trim()) return [];
    this._replayRevocations();
    const { sql, params } = this._where(filters);
    params.limit = Math.max(0, Math.floor(limit));
    // Short terms are not indexed by trigram. Literal LIKE supports Chinese and code symbols.
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(query) || query.trim().length < 3) return this._likeFallback(query, limit, filters);
    try {
      params.query = query.trim().split(/\s+/).map(w => `"${w.replace(/"/g,'""')}"`).join(' OR ');
      return this.db.prepare(`SELECT f.*,rank FROM facts_fts JOIN facts f ON f.id=facts_fts.rowid
        WHERE facts_fts MATCH @query AND ${sql} ORDER BY rank LIMIT @limit`).all(params).map(r => this._rowToFact(r));
    } catch { return this._likeFallback(query, limit, filters); }
  }
  _likeFallback(query, limit, filters = {}) {
    const { sql, params } = this._where(filters);
    params.limit = Math.max(0, Math.floor(limit));
    params.query = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
    return this.db.prepare(`SELECT f.* FROM facts f WHERE ${sql} AND f.fact LIKE @query ESCAPE '\\' ORDER BY f.time DESC LIMIT @limit`)
      .all(params).map(r => this._rowToFact(r));
  }
  getActive(filters = {}, limit = 1000) {
    this._replayRevocations();
    const { sql, params } = this._where(filters);
    return this.db.prepare(`SELECT f.* FROM facts f WHERE ${sql} ORDER BY f.updated_at DESC LIMIT @limit`)
      .all({ ...params, limit }).map(row => this._rowToFact(row));
  }
  getAll() { this._replayRevocations(); return this.db.prepare("SELECT * FROM facts WHERE status!='deleted' ORDER BY time DESC").all().map(r => this._rowToFact(r)); }
  reviewSelected(items,operation) {
    return items.map(item=>{
      try{return this.db.transaction(()=>{
        const current=this.getById(item.id),expected=item.expectedRevision??item.expectedUpdatedAt;
        if(!current)return {id:item.id,ok:false,code:'not_found',error:'Memory not found'};
        if((typeof expected==='number'?current.revision:current.updated_at)!==expected)return {id:item.id,ok:false,code:'revision_conflict',error:'Record changed since preview',current};
        if(operation==='forget'){this.delete(item.id);return {id:item.id,ok:true};}
        const result=this.update(item.id,{status:'active',reviewStatus:'user_confirmed'},expected);
        return result.error?{id:item.id,ok:false,code:result.error==='conflict'?'revision_conflict':result.error,...result}:{id:item.id,ok:true,...result};
      }).immediate();}catch(error){return {id:item.id,ok:false,code:'internal_error',error:error.message};}
    });
  }
  projectIds(query = '') {
    return this.db.prepare("SELECT DISTINCT id FROM (SELECT project_id id FROM facts WHERE project_id IS NOT NULL UNION SELECT project_id id FROM memory_extractions WHERE project_id IS NOT NULL) WHERE id LIKE ? ESCAPE '\\' ORDER BY id").all(literalLike(query)).map(row=>row.id);
  }
  queryPage(input = {}) {
    this._replayRevocations();
    const query = normalizeGovernanceQuery(input);
    const clauses = ["f.status!='deleted'"];
    const params = {now:new Date().toISOString()};
    if (query.q) {clauses.push("f.fact LIKE @q ESCAPE '\\'"); params.q=literalLike(query.q);}
    if (query.projectId) {clauses.push(query.projectId === '__global__' ? 'f.project_id IS NULL' : 'f.project_id=@projectId');if(query.projectId!=='__global__')params.projectId=query.projectId;}
    if (query.source) {clauses.push("(f.session_id=@source OR f.source=@source OR EXISTS(SELECT 1 FROM json_each(f.source_refs) r WHERE json_extract(r.value,'$.sessionId')=@source))");params.source=query.source;}
    if (query.status) {clauses.push('f.status=@status');params.status=query.status;}
    if (query.from) {clauses.push('f.updated_at>=@from');params.from=query.from;}
    if (query.to) {clauses.push('f.updated_at<=@to');params.to=query.to;}
    const pending="(f.status IN ('candidate','conflict','expired') OR f.review_status='unverified' OR f.expires_at<=@now OR f.valid_to<=@now)";
    const base=clauses.join(' AND ');
    const pendingTotal=this.db.prepare(`SELECT COUNT(*) total FROM facts f WHERE ${base} AND ${pending}`).get(params).total;
    if(query.reviewOnly)clauses.push(pending);
    const where=clauses.join(' AND ');
    const total=this.db.prepare(`SELECT COUNT(*) total FROM facts f WHERE ${where} AND @now IS NOT NULL`).get(params).total;
    const memories=this.db.prepare(`SELECT f.* FROM facts f WHERE ${where} AND @now IS NOT NULL ORDER BY CASE WHEN status='conflict' THEN 0 WHEN status='expired' OR expires_at<=@now THEN 1 ELSE 2 END,updated_at DESC,id DESC LIMIT @limit OFFSET @offset`).all({...params,limit:query.limit,offset:query.offset}).map(row=>this._rowToFact(row));
    const projects=this.db.prepare("SELECT DISTINCT project_id id FROM facts WHERE project_id IS NOT NULL ORDER BY project_id LIMIT 200").all().map(row=>projectOption(row.id));
    const sources=this.db.prepare("SELECT DISTINCT session_id id FROM facts WHERE session_id IS NOT NULL ORDER BY session_id LIMIT 200").all().map(row=>row.id);
    return {memories,total,pendingTotal,limit:query.limit,offset:query.offset,projects,sources};
  }
  queryExtractionPage(input = {}) {
    const query=normalizeGovernanceQuery(input),clauses=['1=1'],params={};
    if(query.q){clauses.push("(j.session_id LIKE @q ESCAPE '\\' OR j.key LIKE @q ESCAPE '\\' OR j.error LIKE @q ESCAPE '\\')");params.q=literalLike(query.q);}
    if(query.projectId){clauses.push(query.projectId==='__global__'?'j.project_id IS NULL':'j.project_id=@projectId');if(query.projectId!=='__global__')params.projectId=query.projectId;}
    if(query.source){clauses.push('j.session_id=@source');params.source=query.source;}
    if(query.status){clauses.push('j.status=@status');params.status=query.status;}
    if(query.from){clauses.push('j.updated_at>=@from');params.from=query.from;}
    if(query.to){clauses.push('j.updated_at<=@to');params.to=query.to;}
    const pending="j.status IN ('failed','retryable','quarantined','retryable_failure')",base=clauses.join(' AND ');
    const pendingTotal=this.db.prepare(`SELECT COUNT(*) total FROM memory_extractions j WHERE ${base} AND ${pending}`).get(params).total;
    if(query.reviewOnly)clauses.push(pending);
    const where=clauses.join(' AND '),total=this.db.prepare(`SELECT COUNT(*) total FROM memory_extractions j WHERE ${where}`).get(params).total;
    const jobs=this.db.prepare(`SELECT j.* FROM memory_extractions j WHERE ${where} ORDER BY updated_at DESC,key LIMIT @limit OFFSET @offset`).all({...params,limit:query.limit,offset:query.offset}).map(row=>this._extractionRow(row));
    const projects=this.db.prepare('SELECT DISTINCT project_id id FROM memory_extractions WHERE project_id IS NOT NULL ORDER BY project_id LIMIT 200').all().map(row=>projectOption(row.id));
    const sources=this.db.prepare('SELECT DISTINCT session_id id FROM memory_extractions ORDER BY session_id LIMIT 200').all().map(row=>row.id);
    const statusTotals=Object.fromEntries(this.db.prepare(`SELECT status,COUNT(*) total FROM memory_extractions j WHERE ${base} GROUP BY status`).all(params).map(row=>[row.status,row.total]));
    return {jobs,total,pendingTotal,limit:query.limit,offset:query.offset,projects,sources,statusTotals};
  }
  _extractionRow(row) {return {key:row.key,sessionId:row.session_id,projectId:row.project_id,sourceRevision:row.source_revision,extractorVersion:row.extractor_version,status:row.status,attempts:row.attempts,factsAdded:row.facts_added,error:row.error,nextRetryAt:row.next_retry_at,updatedAt:row.updated_at,leaseUntil:row.lease_until};}
  getBySession(id) { return this.getAll().filter(r => r.session_id === id); }
  getById(id) { this._replayRevocations(); const row = this.db.prepare("SELECT * FROM facts WHERE id=? AND status!='deleted'").get(id); return row ? this._rowToFact(row) : null; }
  get size() { return this.getAll().length; }
  update(id, patch, expected) {
    return this.db.transaction(() => {
    const current = this.getById(id);
    if (!current) return { error: 'not_found' };
    if (typeof expected === 'number' ? expected !== current.revision : expected !== current.updated_at) return { error: 'conflict', current };
    if (patch.fact !== undefined && (typeof patch.fact !== 'string' || !patch.fact.trim())) return { error: 'invalid_fact' };
    if (patch.status !== undefined && !STATES.includes(patch.status)) return { error: 'invalid_status' };
    if (patch.sourceRefs !== undefined && (!Array.isArray(patch.sourceRefs) || patch.sourceRefs.some(ref => !ref || typeof ref !== 'object' || Array.isArray(ref)))) return { error: 'invalid_source_refs' };
    for (const key of ['expiresAt','validFrom','validTo']) {
      if (patch[key] !== undefined && patch[key] !== null && !iso(patch[key])) return { error: 'invalid_date' };
    }
    if (patch.projectId !== undefined && patch.projectId !== null && (typeof patch.projectId !== 'string' || !patch.projectId.trim())) return { error: 'invalid_scope' };
    const fact = patch.fact === undefined ? current.fact : safe(patch.fact.trim());
    const event = this._revoke([current], 'correction');
    return this.db.transaction(() => {
      const updated = new Date(Math.max(Date.now(), Date.parse(event.at)+1, Date.parse(current.updated_at)+1)).toISOString();
      this.db.prepare(`UPDATE facts SET fact=?,content_hash=?,status=?,updated_at=?,revision=revision+1,
        project_id=?,scope=?,expires_at=?,valid_from=?,valid_to=?,review_status=?,last_verified_at=?,source_refs=?,source_revision=?,extractor_version=?,observed_at=?,tags=?,time=? WHERE id=?`)
        .run(fact,memoryContentHash(fact),patch.status ?? current.status,updated,
          patch.projectId === undefined ? current.projectId : patch.projectId,
          (patch.projectId === undefined ? current.projectId : patch.projectId) ? 'project' : 'global',
          patch.expiresAt === undefined ? current.expiresAt : iso(patch.expiresAt),
          patch.validFrom === undefined ? current.validFrom : iso(patch.validFrom),
          patch.validTo === undefined ? current.validTo : iso(patch.validTo),
          patch.status === 'active' ? 'user_confirmed' : patch.reviewStatus || current.reviewStatus,
          patch.status === 'active' ? updated : current.lastVerifiedAt,
          JSON.stringify(JSON.parse(JSON.stringify(patch.sourceRefs || current.sourceRefs), (_key,value) => typeof value === 'string' ? safe(value) : value)),
          patch.sourceRevision || current.sourceRevision,patch.extractorVersion || current.extractorVersion,
          iso(patch.observedAt) || current.observedAt,JSON.stringify((patch.tags || current.tags).map(safe)),patch.time || current.time,id);
      this.db.prepare('INSERT OR IGNORE INTO memory_revocations VALUES (?,?)').run(event.eventId,JSON.stringify(event));
      return { memory: this.getById(id) };
    })();
    }).immediate();
  }
  delete(id) {
    return this.db.transaction(() => {
    const current = this.getById(id);
    if (!current) return false;
    const event = this._revoke([current], 'deleted');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM facts WHERE id=?').run(id);
      this.db.prepare('INSERT OR IGNORE INTO memory_revocations VALUES (?,?)').run(event.eventId,JSON.stringify(event));
    })();
    return true;
    }).immediate();
  }
  clearAll() {
    return this.db.transaction(() => {
    const event = this._revoke(this.getAll(), 'clear_all', true);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM facts').run();
      this.db.prepare("UPDATE memory_extractions SET status='cancelled',error='memory cleared',lease_token=NULL,lease_until=NULL").run();
      this.db.prepare('INSERT OR IGNORE INTO memory_revocations VALUES (?,?)').run(event.eventId,JSON.stringify(event));
    })();
    }).immediate();
  }
  exportAll() { return this.getAll(); }
  importAll(entries) { return this.addBatch(entries); }

  beginExtraction(key, meta, opts = {}) {
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM memory_extractions WHERE key=?').get(key);
      const now = opts.now || new Date().toISOString();
      if (previous?.status === 'succeeded') return { status: 'succeeded', factsAdded: previous.facts_added };
      if (previous?.status === 'quarantined') return { status: 'quarantined' };
      if (previous?.status === 'running' && previous.lease_until > now) return { status: 'busy' };
      if (previous?.next_retry_at > now) return { status: 'deferred' };
      const token = randomUUID();
      const generation = this.generation;
      this.db.prepare(`INSERT INTO memory_extractions(key,session_id,source_revision,extractor_version,status,attempts,updated_at,lease_token,lease_until,generation,source_refs)
        VALUES(@key,@sessionId,@revision,@version,'running',1,@now,@token,@until,@generation,@refs)
        ON CONFLICT(key) DO UPDATE SET status='running',attempts=attempts+1,updated_at=@now,lease_token=@token,lease_until=@until,generation=@generation`)
        .run({ key,sessionId:meta.sessionId,revision:meta.sourceRevision,version:meta.extractorVersion,now,token,until:new Date(Date.parse(now)+300000).toISOString(),generation,refs:JSON.stringify(JSON.parse(JSON.stringify(meta.sourceRefs || []), (_key,value) => typeof value === 'string' ? safe(value) : value)) });
      this.db.prepare('UPDATE memory_extractions SET project_id=? WHERE key=?').run(meta.projectId || null,key);
      return { status: 'running', token, generation };
    })();
  }
  commitExtraction(key, entries, claim) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM memory_extractions WHERE key=?').get(key);
      if (row?.status === 'succeeded') return { factsAdded: 0, duplicate: true };
      if (!row || row.lease_token !== claim.token || this.generation !== claim.generation) throw Object.assign(new Error('Stale extraction generation or lease'), { code: 'MEMORY_GENERATION_CHANGED' });
      const factsAdded = this.addBatch(entries.map(e => ({ ...e, extractionKey: key })));
      this.db.prepare("UPDATE memory_extractions SET status='succeeded',facts_added=?,error=NULL,next_retry_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE key=?")
        .run(factsAdded,new Date().toISOString(),key);
      return { factsAdded };
    })();
  }
  failExtraction(key, error, claim, opts = {}) {
    const row = this.db.prepare('SELECT * FROM memory_extractions WHERE key=?').get(key);
    if (!row || row.lease_token !== claim.token || row.status !== 'running') return;
    const status = row.attempts >= (opts.maxAttempts || 3) ? 'quarantined' : 'failed';
    const now = opts.now || new Date().toISOString();
    const next = new Date(Date.parse(now)+Math.min(3600000,60000*2**(row.attempts-1))).toISOString();
    this.db.prepare('UPDATE memory_extractions SET status=?,error=?,next_retry_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE key=?')
      .run(status,safe(error?.message || String(error)).slice(0,500),status === 'failed' ? next : null,now,key);
    return status;
  }
  getExtractionJobs(opts = {}) {
    const rows = opts.status ? this.db.prepare('SELECT * FROM memory_extractions WHERE status=? ORDER BY updated_at DESC').all(opts.status) : this.db.prepare('SELECT * FROM memory_extractions ORDER BY updated_at DESC').all();
    return rows.map(row => ({ key:row.key,sessionId:row.session_id,sourceRevision:row.source_revision,extractorVersion:row.extractor_version,status:row.status,attempts:row.attempts,factsAdded:row.facts_added,error:row.error,nextRetryAt:row.next_retry_at,updatedAt:row.updated_at,leaseUntil:row.lease_until }));
  }
  cancelExtraction(key, reason = 'cancelled') {
    return this.db.prepare("UPDATE memory_extractions SET status='cancelled',error=?,next_retry_at=NULL,lease_token=NULL,lease_until=NULL WHERE key=? AND status!='succeeded'").run(safe(reason),key).changes > 0;
  }
  retryExtraction(key) {
    const row = this.db.prepare('SELECT status FROM memory_extractions WHERE key=?').get(key);
    if (!row) return { error: 'not_found' };
    if (['running','succeeded','cancelled'].includes(row.status)) return { error: 'invalid_state' };
    this.db.prepare("UPDATE memory_extractions SET status='failed',attempts=0,next_retry_at=NULL,error=NULL WHERE key=?").run(key);
    return { ok: true };
  }
  close() { if (this.db?.open) this.db.close(); }
  _rowToFact(row) {
    return { id:row.id,memoryId:row.memory_id,fact:row.fact,tags:json(row.tags,[]),time:row.time,session_id:row.session_id,created_at:row.created_at,source:row.source || null,
      updated_at:row.updated_at || row.created_at,status:row.status || 'active',matchCount:row.matchCount,rank:row.rank,
      sourceRefs:Array.isArray(json(row.source_refs,[])) ? json(row.source_refs,[]).filter(ref => ref && typeof ref === "object") : [],sourceRevision:row.source_revision,extractorVersion:row.extractor_version,
      projectId:row.project_id,channelId:row.channel_id,scope:row.scope,kind:row.kind,observedAt:row.observed_at,
      validFrom:row.valid_from,validTo:row.valid_to,expiresAt:row.expires_at,lastVerifiedAt:row.last_verified_at,
      revision:row.revision,schemaVersion:row.schema_version,reviewStatus:row.review_status };
  }
}
function inferChannel(sessionId) {
  if (sessionId?.startsWith('channel-')) return sessionId.slice('channel-'.length);
  if (!sessionId?.startsWith('channel:')) return null;
  return sessionId.slice('channel:'.length).split(':')[0];
}
