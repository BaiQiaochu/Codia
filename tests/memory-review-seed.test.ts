import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactStore } from '../lib/memory/fact-store.ts';
import { openExperienceStore } from '../lib/experience-store.ts';

const script = path.resolve('scripts/seed-memory-review.mjs');
const confirmation = '--confirm-test-home-and-stopped';
const markerName = '.codia-memory-review-test.json';
let home: string;
let agentDir: string;
let factsPath: string;

function run(args = ['--home', home, confirmation]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 15_000 });
}
function inspect() {
  const facts = new FactStore(factsPath);
  const experience = openExperienceStore(agentDir);
  try { return { facts: facts.getAll(), entries: experience.list() }; }
  finally { experience.close(); facts.close(); }
}
function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => { const file = path.join(entry.parentPath, entry.name); return [path.relative(directory, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]; }));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-memory-test-'));
  agentDir = path.join(home, 'agents', 'codia');
  fs.mkdirSync(path.join(agentDir, 'memory'), { recursive: true });
  // Initialization stand-in only. The seed must never read or modify agent config.
  fs.writeFileSync(path.join(agentDir, 'config.yaml'), '# synthetic initialized agent; no credentials\n');
  factsPath = path.join(agentDir, 'memory', 'facts.db');
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('offline disposable memory-review fixtures', () => {
  it('runs the real CLI and creates three labeled facts plus two unverified candidates', () => {
    const config = fs.readFileSync(path.join(agentDir, 'config.yaml'));
    const result = run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"verifiedEvidenceCreated": 0');
    const { facts, entries } = inspect();
    expect(facts).toHaveLength(3);
    expect(new Set(facts.map(fact => fact.status))).toEqual(new Set(['active', 'conflict', 'candidate']));
    expect(entries).toHaveLength(2);
    facts.forEach(fact => {
      expect(fact.fact).toContain('[合成测试数据]');
      expect(fact.reviewStatus).toBe('unverified');
      expect(fact.lastVerifiedAt).toBeNull();
      expect(fact.sourceRefs[0].kind).toBe('synthetic-test');
    });
    entries.forEach(entry => {
      expect(entry.content).toContain('[合成测试数据]');
      expect(entry.state).toBe('candidate');
      expect(entry.evidence).toEqual([]);
      expect(entry.lastVerifiedAt).toBeNull();
      expect(Object.values(entry.stats).every(value => value === 0)).toBe(true);
    });
    const experience = openExperienceStore(agentDir);
    try {
      expect(() => experience.transition(entries[0].id, entries[0].revision, 'validated')).toThrow('real run outcome');
      expect(experience.recall({ projectId: 'synthetic-memory-review', platform: process.platform }).entries).toEqual([]);
    } finally { experience.close(); }
    expect(fs.readFileSync(path.join(agentDir, 'config.yaml'))).toEqual(config);
  });

  it('accepts empty databases created during a first application startup', () => {
    new FactStore(factsPath).close();
    openExperienceStore(agentDir).close();
    expect(run().status).toBe(0);
    expect(inspect().facts).toHaveLength(3);
  });

  it('requires explicit home, explicit stopped-app confirmation and initialized agent', () => {
    expect(run([confirmation]).status).toBe(1);
    expect(run(['--home', home]).status).toBe(1);
    expect(run(['--home', '.', confirmation]).status).toBe(1);
    fs.unlinkSync(path.join(agentDir, 'config.yaml'));
    expect(run().stderr).toContain('尚未初始化');
    expect(fs.existsSync(path.join(home, markerName))).toBe(false);
    expect(fs.existsSync(factsPath)).toBe(false);
  });

  it.each(['.codia', '.codia-dev', '.codia/codia-memory-test-child', '.codia-dev/codia-memory-test-child'])('refuses real/default home %s without opening it', suffix => {
    const result = run(['--home', path.join(os.homedir(), suffix), confirmation]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('拒绝真实默认目录');
  });

  it('is a byte-for-byte no-op on the second invocation', () => {
    expect(run().status).toBe(0);
    const before = snapshot(home);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"status": "already_seeded"');
    expect(snapshot(home)).toEqual(before);
    expect(inspect().facts).toHaveLength(3);
    expect(inspect().entries).toHaveLength(2);
  });

  it('does not resurrect forgotten fixtures or reset their derived withdrawal on rerun', () => {
    expect(run().status).toBe(0);
    const facts = new FactStore(factsPath);
    try { facts.delete(facts.getAll().find(item => item.memoryId === 'synthetic-memory-review-fact-3')!.id); }
    finally { facts.close(); }
    const before = snapshot(home);
    expect(run().status).toBe(0);
    expect(snapshot(home)).toEqual(before);
    const result = inspect();
    expect(result.facts).toHaveLength(2);
    expect(result.entries.filter(entry => entry.state === 'withdrawn')).toHaveLength(1);
  });

  it('refuses existing fact data before writing a marker or any experience files', () => {
    const facts = new FactStore(factsPath);
    try { facts.add({ fact: 'Existing data must remain intact', tags: ['existing'] }); }
    finally { facts.close(); }
    const before = snapshot(home);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('已有记忆');
    expect(snapshot(home)).toEqual(before);
    expect(fs.existsSync(path.join(home, markerName))).toBe(false);
  });

  it('refuses existing candidate experience without creating facts or changing existing bytes', () => {
    const experience = openExperienceStore(agentDir);
    try { experience.createCandidate({ category: 'Existing', content: 'Existing experience must remain intact' }); }
    finally { experience.close(); }
    const before = snapshot(home);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('已有记忆');
    expect(snapshot(home)).toEqual(before);
    expect(fs.existsSync(factsPath)).toBe(false);
  });

  it('refuses legacy text and revocation history rather than migrating or replacing them', () => {
    fs.mkdirSync(path.join(agentDir, 'experience'));
    fs.writeFileSync(path.join(agentDir, 'experience', 'legacy.md'), '1. Existing legacy data\n');
    fs.writeFileSync(path.join(agentDir, 'memory', 'lifecycle.json'), '{"synthetic":"existing history"}\n');
    const before = snapshot(home);
    expect(run().status).toBe(1);
    expect(snapshot(home)).toEqual(before);
  });

  it('rejects a linked memory directory instead of following it', () => {
    const linked = path.join(home, 'unrelated');
    fs.mkdirSync(linked);
    fs.rmdirSync(path.join(agentDir, 'memory'));
    fs.symlinkSync(linked, path.join(agentDir, 'memory'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(run().stderr).toContain('拒绝链接');
    expect(fs.readdirSync(linked)).toEqual([]);
  });

  it('fails closed on incomplete marker and never automatically repairs by deleting data', () => {
    fs.writeFileSync(path.join(home, markerName), JSON.stringify({ purpose: 'codia-memory-review-synthetic-fixtures-v1', home, status: 'in_progress' }));
    const before = snapshot(home);
    expect(run().stderr).toContain('上次写入未完成');
    expect(snapshot(home)).toEqual(before);
  });
});
