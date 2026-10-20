/** Executes synthetic fixtures against production stores; no model or network is used. */
import assert from 'node:assert/strict';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactStore } from '../lib/memory/fact-store.ts';
import { MemoryQueryService, MEMORY_DATA_NOTICE } from '../lib/memory/query-service.ts';
import { ExperienceStore, EXPERIENCE_TRUST_NOTICE } from '../lib/experience-store.ts';

export function loadMemoryCases() {
  return JSON.parse(fs.readFileSync(new URL('./memory-product-cases.json', import.meta.url), 'utf8')).cases;
}

export function validateDataset(cases = loadMemoryCases()) {
  assert.equal(cases.length, 120);
  assert.equal(new Set(cases.map(c => c.id)).size, 120);
  assert.equal(new Set(cases.map(c => c.name)).size, 120);
  const counts = {};
  const projects = { tune: new Set(), holdout: new Set() };
  for (const c of cases) {
    counts[c.category] = (counts[c.category] || 0) + 1;
    assert.equal(c.synthetic, true);
    assert.ok(c.choices[c.correctChoice]);
    assert.ok(c.question.length > 10);
    assert.ok(c.expect && (c.experience || c.expect.included || c.expect.excluded));
    projects[c.split].add(c.projectId);
    for (const f of c.facts) {
      if (f.projectId) projects[c.split].add(f.projectId);
      assert.ok(c.allowsFutureFixture || Date.parse(f.observedAt) <= Date.parse(c.asOf), `${c.id} future evidence`);
    }
  }
  assert.equal(Object.keys(counts).length, 6);
  for (const count of Object.values(counts)) assert.equal(count, 20);
  for (const project of projects.tune) assert.ok(!projects.holdout.has(project));
  assert.ok(Math.max(...cases.filter(c => c.split === 'tune').map(c => Date.parse(c.asOf))) < Math.min(...cases.filter(c => c.split === 'holdout').map(c => Date.parse(c.asOf))));
  return counts;
}

function expectedError(fn, code) {
  assert.throws(fn, error => error?.code === code, `Expected ${code}`);
}

function executeExperience(c, dir) {
  const dbPath = path.join(dir, 'experience.db');
  let store = new ExperienceStore(dbPath);
  try {
    const environment = { projectId: c.projectId, platform: 'linux', appVersion: '0.3.3', dependencyVersions: { node: '24.12.0' } };
    let entry = store.createCandidate({
      category: 'local-build', content: 'Run pnpm install before the local build',
      sourceRefs: [{ type: 'run', id: `${c.id}-source-run` }, { type: 'memory', id: 'source-memory' }],
      applicability: { scope: 'project', ...environment },
      actions: ['Run pnpm install', 'Run pnpm build'], verificationMethod: 'Inspect build exit code and produced bundle',
      preconditions: ['The dependency manifest changed'], risks: ['Network dependency fetch may fail'], rollback: 'Restore the reviewed lockfile',
    }, { eventId: `${c.id}-candidate` }).entry;
    const scenario = c.experience.scenario;
    const feedback = (event, overrides = {}) => store.recordFeedback(entry.id, { runId: `${c.id}-run-one`, eventId: `${c.id}-${event}`, experienceRevision: entry.revision, event, ...overrides });
    const review = (outcome = 'success') => {
      entry = store.recordReview(entry.id, entry.revision, {
        runId: `${c.id}-run-one`, eventId: `${c.id}-review`, reviewerId: 'synthetic-fixture-reviewer', outcome,
        evidenceRef: `fixture://${c.id}/build-log`, summary: outcome === 'failure' ? 'Build exited with status 1; dependency fetch failed.' : outcome === 'unknown' ? 'Request timed out; external delivery state unknown.' : 'Build exit status 0 and bundle verified.', environment,
      });
      return entry.evidence.at(-1);
    };
    const enable = () => {
      review();
      entry = store.transition(entry.id, entry.revision, 'validated');
      entry = store.transition(entry.id, entry.revision, 'enabled');
    };
    let query = { ...environment, tokenBudget: 4000 };
    let shouldRecall = false;
    switch (scenario) {
      case 'candidate_hidden': assert.equal(entry.state, 'candidate'); break;
      case 'retrieval_not_success': feedback('retrieved'); assert.equal(store.get(entry.id).stats.retrieved, 1); break;
      case 'injection_not_success': feedback('injected'); assert.equal(store.get(entry.id).stats.injected, 1); break;
      case 'attempt_not_success': feedback('attempted'); assert.equal(store.get(entry.id).stats.attempted, 1); break;
      case 'unknown_not_success':
        review('unknown'); feedback('unknown');
        expectedError(() => store.transition(entry.id, entry.revision, 'validated'), 'evidence_required');
        assert.equal(store.get(entry.id).stats.unknown, 1); break;
      case 'direct_enable_rejected': expectedError(() => store.transition(entry.id, entry.revision, 'enabled'), 'invalid_transition'); break;
      case 'unreviewed_success_rejected': expectedError(() => feedback('verifiedSuccess'), 'evidence_required'); break;
      case 'review_validate': review(); entry = store.transition(entry.id, entry.revision, 'validated'); assert.equal(entry.state, 'validated'); break;
      case 'enable_reviewed': enable(); shouldRecall = true; break;
      case 'feedback_idempotent': {
        const evidence = review();
        const args = { evidenceId: evidence.id };
        assert.equal(store.get(entry.id).stats.verifiedSuccess, 1);
        assert.equal(feedback('verifiedSuccess', args).added, false);
        assert.equal(feedback('verifiedSuccess', args).added, false);
        assert.equal(feedback('verifiedSuccess', { ...args, eventId: 'different-retry-event' }).added, false);
        assert.equal(store.get(entry.id).stats.verifiedSuccess, 1); break;
      }
      case 'project_mismatch': enable(); query.projectId = `${c.projectId}-other`; break;
      case 'platform_mismatch': enable(); query.platform = 'win32'; break;
      case 'version_mismatch': enable(); query.appVersion = '1.0.0'; break;
      case 'dependency_mismatch': enable(); query.dependencyVersions = { node: '26.0.0' }; break;
      case 'missing_environment': enable(); query = { tokenBudget: 4000 }; break;
      case 'withdrawn_hidden': enable(); entry = store.transition(entry.id, entry.revision, 'withdrawn'); break;
      case 'revision_resets':
        enable(); entry = store.revise(entry.id, entry.revision, { content: 'Run a new untested build command' });
        assert.equal(entry.state, 'candidate');
        expectedError(() => store.transition(entry.id, entry.revision, 'validated'), 'evidence_required'); break;
      case 'reviewed_failure': {
        const evidence = review('failure'); feedback('verifiedFailure', { evidenceId: evidence.id });
        assert.equal(store.get(entry.id).stats.verifiedFailure, 1); break;
      }
      case 'source_invalidated':
        enable(); assert.equal(store.invalidateSources([{ type: 'memory', id: 'source-memory' }]), 1);
        assert.equal(store.get(entry.id).state, 'withdrawn'); break;
      case 'experience_restart':
        enable(); store.close(); store = new ExperienceStore(dbPath); shouldRecall = true; break;
      default: throw new Error(`Unknown experience scenario: ${scenario}`);
    }
    const current = store.get(entry.id);
    const reviewedSuccess = ['review_validate', 'enable_reviewed', 'feedback_idempotent', 'project_mismatch', 'platform_mismatch', 'version_mismatch', 'dependency_mismatch', 'missing_environment', 'withdrawn_hidden', 'revision_resets', 'source_invalidated', 'experience_restart'].includes(scenario);
    assert.equal(current.stats.verifiedSuccess, reviewedSuccess ? 1 : 0, 'Only a real reviewed outcome increments lifetime associated success');
    const result = store.recall(query);
    assert.equal(result.entries.length, shouldRecall ? 1 : 0, `${c.id}: applicability/state recall`);
    assert.ok(result.usedTokens <= query.tokenBudget);
    // Only actual recall content is exposed. Audit metadata is a read-only product outcome;
    // processing timestamps are omitted because this is historical synthetic event replay.
    const audit = { state: current.state, stats: current.stats, evidenceOutcomes: current.evidence.filter(e => e.contentRevision === current.contentRevision).map(e => e.outcome), applicableNow: result.entries.length > 0 };
    const memoryText = `${EXPERIENCE_TRUST_NOTICE}\n${JSON.stringify({ audit })}${result.entries.map(e => '\n' + JSON.stringify({ content: e.content, applicability: e.applicability, verificationMethod: e.verificationMethod, sourceRefs: e.sourceRefs })).join('')}`;
    const recall = shouldRecall ? Number(result.entries.length === 1) : null;
    return { memoryText, retrievedIds: result.entries.map(e => e.id), injectedIds: result.entries.map(e => e.id),
      expectedEvidenceCount: shouldRecall ? 1 : 0, retrievalRecall: recall, injectionRecall: recall,
      precisionAtK: recall, k: 1, estimatedTokens: Buffer.byteLength(memoryText), audit, assertionCount: 4 };
  } finally { if (store.db.open) store.close(); }
}

/** Isolated temporary DB per case, deleted afterward. Never reads app configuration or user data. */
export function executeMemoryCase(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `codia-eval-${c.id}-`));
  let store;
  let measured = null;
  const started = performance.now();
  try {
    if (c.experience) return { ...executeExperience(c, dir), fixtureLatencyMs: performance.now() - started };
    const dbPath = path.join(dir, 'facts.db');
    store = new FactStore(dbPath);
    const ids = new Map();
    const original = new Map();
    const revisions = new Map();
    let assertionCount = 0;
    for (const fixture of c.facts) {
      const { key, ...entry } = fixture;
      original.set(key, JSON.parse(JSON.stringify(entry)));
      const added = store.add(entry);
      assert.ok(added.id, `${c.id}: fixture ${key} was not persisted`);
      ids.set(key, added.id);
    }
    for (const action of c.actions || []) {
      const id = ids.get(action.target);
      switch (action.type) {
        case 'captureRevision': revisions.set(action.as, store.getById(id).revision); break;
        case 'update': {
          const current = store.getById(id);
          const result = store.update(id, action.patch, action.useRevision ? revisions.get(action.useRevision) : current?.revision ?? current?.updated_at);
          if (action.error) assert.equal(result.error, action.error);
          else assert.ok(result.memory, `${c.id}: correction failed: ${JSON.stringify(result)}`);
          assertionCount++; break;
        }
        case 'delete': assert.equal(store.delete(id), action.result ?? true); assertionCount++; break;
        case 'clear': store.clearAll(); break;
        case 'reopen': store.close(); store = new FactStore(dbPath); break;
        case 'replay': {
          const result = store.add(original.get(action.target));
          if (action.skipped) assert.equal(result.skipped, true, `${c.id}: stale evidence resurrected`);
          assertionCount++; break;
        }
        case 'importOriginal': store.importAll([original.get(action.target)]); break;
        case 'add': {
          const { key: _key, ...entry } = action.entry;
          const added = store.add({ ...entry, observedAt: c.asOf, time: c.asOf, sourceRefs: [{ kind: 'message', messageId: `${c.id}-new`, author: 'user' }] });
          assert.ok(added.id); ids.set(action.as, added.id); break;
        }
        default: throw new Error(`Unsupported fixture action ${action.type}`);
      }
    }
    const query = { projectId: c.projectId, now: c.asOf, ...c.query };
    const result = new MemoryQueryService(store).query(query);
    const actualIds = new Set(result.results.map(r => r.id));
    const expected = c.expect;
    const expectedIds = (expected.included || []).map(key => ids.get(key));
    const relevant = new Set(expectedIds);
    const hits = values => values.filter(id => relevant.has(id)).length;
    measured = {
      expectedEvidenceCount: expectedIds.length,
      retrievalRecall: expectedIds.length ? hits(result.retrievedIds) / expectedIds.length : null,
      injectionRecall: expectedIds.length ? hits(result.injectedIds) / expectedIds.length : null,
      precisionAtK: expectedIds.length ? hits(result.injectedIds.slice(0, query.limit ?? 8)) / Math.max(1, query.limit ?? 8) : null,
      k: query.limit ?? 8,
    };
    for (const key of expected.included || []) { assert.ok(actualIds.has(ids.get(key)), `${c.id}: missing ${key}; returned ${[...actualIds]}`); assertionCount++; }
    for (const key of expected.excluded || []) { assert.ok(!actualIds.has(ids.get(key)), `${c.id}: leaked ${key}`); assertionCount++; }
    for (const text of expected.textIncludes || []) { assert.ok(result.text.includes(text), `${c.id}: missing text ${text}`); assertionCount++; }
    for (const text of expected.textExcludes || []) { assert.ok(!result.text.includes(text), `${c.id}: leaked text ${text}`); assertionCount++; }
    for (const text of expected.storageExcludes || []) { assert.ok(!JSON.stringify(store.exportAll()).includes(text), `${c.id}: stored/exported forbidden plaintext ${text}`); assertionCount++; }
    for (const key of expected.sourceRefsFor || []) { assert.deepEqual(store.getById(ids.get(key)).sourceRefs, original.get(key).sourceRefs); assertionCount++; }
    for (const [key, minimum] of Object.entries(expected.revisionAtLeast || {})) { assert.ok(store.getById(ids.get(key)).revision >= minimum); assertionCount++; }
    if (expected.count !== undefined) { assert.equal(result.results.length, expected.count); assertionCount++; }
    assert.ok(result.estimatedTokens <= (query.tokenBudget ?? 2400)); assertionCount++;
    assert.deepEqual(result.injectedIds, result.results.map(r => r.id)); assertionCount++;
    assert.equal(new Set(result.injectedIds).size, result.injectedIds.length); assertionCount++;
    if (expected.maxTokens !== undefined) { assert.ok(result.estimatedTokens <= expected.maxTokens); assertionCount++; }
    if (expected.untrustedBoundary) {
      assert.ok(result.text.startsWith(MEMORY_DATA_NOTICE));
      for (const line of result.text.split('\n').slice(1)) assert.equal(typeof JSON.parse(line).fact, 'string');
      assertionCount += 2;
    }
    // Future rows deliberately exist only for boundary tests and must never enter model context.
    for (const row of result.results) assert.ok(!row.observedAt || Date.parse(row.observedAt) <= Date.parse(c.asOf));
    return {
      memoryText: result.text, retrievedIds: result.retrievedIds, injectedIds: result.injectedIds,
      ...measured,
      estimatedTokens: result.estimatedTokens, assertionCount, fixtureLatencyMs: performance.now() - started,
    };
  } catch (error) {
    const count = c.expect?.included?.length || 0;
    error.retrievalMetrics = measured || (count ? {
      expectedEvidenceCount: count, retrievalRecall: 0, injectionRecall: 0, precisionAtK: 0, k: c.query?.limit ?? 8,
    } : null);
    error.infrastructureFailure = ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'SQLITE_CANTOPEN'].includes(error.code);
    throw error;
  } finally { if (store?.db?.open) store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
