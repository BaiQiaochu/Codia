#!/usr/bin/env node
/** Local CPU/SQLite benchmark only. Synthetic records, no model endpoint or user data. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { FactStore } from '../lib/memory/fact-store.ts';
import { MemoryQueryService } from '../lib/memory/query-service.ts';
import { percentile } from '../evals/memory-evaluation-metrics.mjs';

const get = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
if (process.argv.includes('--help')) {
  console.log('node scripts/eval-memory-benchmark.mjs [--sizes 10000,100000] [--iterations 50] [--output artifacts/memory-benchmark.json]');
  process.exit(0);
}
const sizes = get('sizes', '10000,100000').split(',').map(Number);
const iterations = Number(get('iterations', '50'));
if (sizes.some(n => !Number.isSafeInteger(n) || n < 100 || n > 1000000) || !Number.isSafeInteger(iterations) || iterations < 5 || iterations > 1000) throw new Error('Invalid benchmark size or iteration count');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-memory-benchmark-'));
const cpu = os.cpus();
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), kind: 'local-synthetic-retrieval-benchmark',
  implementationSHA256: Object.fromEntries(['lib/memory/fact-store.ts', 'lib/memory/query-service.ts', 'lib/memory/memory-lifecycle.ts'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(new URL('../' + file, import.meta.url))).digest('hex')])),
  hardware: { platform: os.platform(), release: os.release(), arch: os.arch(), cpuModel: cpu[0]?.model || 'unreported', logicalCPUs: cpu.length, totalMemoryBytes: os.totalmem(), node: process.version, sqlite: null, sharedVirtualizedHost: true },
  methodology: { iterationsPerQuery: iterations, warmupPerQuery: 5, tokenBudget: 1600, resultLimit: 5, scope: 'MemoryQueryService synchronous call only; warmed filesystem/SQLite caches; wall time; single process', insertion: 'FactStore.addBatch through production insertion path; includes provenance and lifecycle changes', limitations: ['Shared cloud VM; not target desktop hardware.', 'Synthetic distribution and warm-cache queries; not production p95 guarantee.', 'UTF-8-byte budget is conservative, not actual model-token billing.'] }, datasets: [],
};
try {
  for (const size of sizes) {
    const dbPath = path.join(root, `facts-${size}.db`);
    const store = new FactStore(dbPath);
    try {
      report.hardware.sqlite = store.db.prepare('select sqlite_version() version').get().version;
      const insertStarted = performance.now();
      for (let offset = 0; offset < size; offset += 1000) {
        const entries = Array.from({ length: Math.min(1000, size - offset) }, (_, local) => {
          const n = offset + local;
          return {
            fact: `Fixture ${n}: project ${n % 100} deployment error EADDRINUSE requires checking port ${4100 + n % 100}. 中文记忆测试记录。 Module server/routes/component-${n % 50}.ts uses Node 24.12.0.`,
            tags: ['deployment', `component-${n % 50}`], projectId: `project-${n % 100}`, scope: 'project',
            observedAt: '2026-01-01T08:00:00.000Z', time: `2026-01-${String(1 + n % 20).padStart(2, '0')}T08:00:00.000Z`,
            sourceRefs: [{ kind: 'message', messageId: `synthetic-benchmark-${n}`, author: 'user' }],
          };
        });
        store.addBatch(entries);
      }
      const insertionMs = performance.now() - insertStarted;
      const service = new MemoryQueryService(store);
      const common = { projectId: 'project-7', now: '2026-02-01T12:00:00.000Z', tokenBudget: 1600, limit: 5 };
      const queries = [
        { name: 'project-tag-prefilter', args: { tags: ['deployment'] } },
        { name: 'error-code-fulltext', args: { query: 'EADDRINUSE' } },
        { name: 'chinese-substring', args: { query: '中文记忆' } },
        { name: 'hybrid-symbol-and-tag', args: { query: 'server/routes/component-7.ts', tags: ['component-7'] } },
        { name: 'date-filtered-tags', args: { tags: ['deployment'], dateRange: { from: '2026-01-05T00:00:00.000Z', to: '2026-01-15T23:59:59.000Z' } } },
      ];
      const results = [];
      for (const item of queries) {
        for (let n = 0; n < 5; n++) service.query({ ...common, ...item.args });
        const timings = []; let last;
        for (let n = 0; n < iterations; n++) {
          const start = performance.now(); last = service.query({ ...common, ...item.args }); timings.push(performance.now() - start);
          if (last.results.some(fact => fact.projectId !== common.projectId)) throw new Error('Scope leak detected in benchmark');
        }
        if (!last.results.length) throw new Error(`Unexpected empty benchmark query ${item.name}`);
        results.push({ query: item.name, p50Ms: percentile(timings, .5), p95Ms: percentile(timings, .95), minMs: Math.min(...timings), maxMs: Math.max(...timings), iterations, resultCount: last.results.length, estimatedInjectionByteBound: last.estimatedTokens });
      }
      const deleteTarget = service.query({ ...common, tags: ['deployment'] }).results[0];
      const deleteStarted = performance.now(); store.delete(deleteTarget.id);
      const afterDelete = service.query({ ...common, query: `Fixture ${deleteTarget.id - 1}:`, tags: ['deployment'] });
      if (afterDelete.retrievedIds.includes(deleteTarget.id)) throw new Error('Deletion recall failure');
      const deleteAndReadMs = performance.now() - deleteStarted;
      store.db.pragma('wal_checkpoint(TRUNCATE)');
      const dbBytes = fs.statSync(dbPath).size;
      const entry = { size, insertionMs, databaseBytes: dbBytes, includesFTSAndLifecycleTables: true, deleteAndNextReadMs: deleteAndReadMs, queries: results, meetsInitialWarmP95Target: results.every(r => r.p95Ms < 300) };
      report.datasets.push(entry);
      console.log(JSON.stringify(entry));
    } finally { store.close(); }
  }
  const output = path.resolve(get('output', 'artifacts/memory-benchmark.json'));
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Saved ${output}`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
