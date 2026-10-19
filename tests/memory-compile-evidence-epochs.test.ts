import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../core/llm-client.ts', () => ({ callText: vi.fn() }));
import { callText } from '../core/llm-client.ts';
import { SessionSummaryManager } from '../lib/memory/session-summary.ts';
import { openExperienceStore } from '../lib/experience-store.ts';
import { captureMemoryEvidenceEpoch } from '../lib/memory/prompt-guard.ts';
import { compileToday, compileWeek, compileLongterm, compileFacts, assemble, readCompiledMemorySections } from '../lib/memory/compile.ts';
import { isCompiledMemoryEligible, isCompiledSectionEligible } from '../lib/memory/compiled-memory-state.ts';
let root: string, memory: string, manager: SessionSummaryManager;
const model = { model: 'fixture', api: 'openai-completions', api_key: 'fixture', base_url: 'http://invalid' };
const file = (name: string) => path.join(memory, name);
function withStore(fn: any) { const store = openExperienceStore(root); try { return fn(store); } finally { store.close(); } }
function addExperience() { return withStore((store: any) => store.createCandidate({ category: 'debug', content: 'Evidence lesson', applicability: { scope: 'global' } }).entry); }
function withdraw(entry: any) { withStore((store: any) => store.transition(entry.id, entry.revision, 'withdrawn')); }
function seed(expiresAt: string | null = null) {
  manager.saveSummary('source', { session_id: 'source', summary: '### Key Facts\nSource profile.\n\n### Timeline\nSource theme.', snapshot: '',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), memoryEvidenceEpoch: { ...captureMemoryEvidenceEpoch(root), expiresAt } });
}
function assembleAll() { assemble(file('facts.md'), file('today.md'), file('week.md'), file('longterm.md'), file('memory.md')); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
  vi.mocked(callText).mockReset().mockResolvedValue('Derived profile from old source');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-epoch-')); memory = path.join(root, 'memory'); fs.mkdirSync(memory);
  manager = new SessionSummaryManager(file('summaries'));
});
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

describe('summary to compiler evidence lifecycle', () => {
  for (const [name, compile] of [['today', compileToday], ['week', compileWeek]] as const) {
    it(`${name} discards an in-flight result after source experience withdrawal`, async () => {
      const experience = addExperience(); seed();
      vi.mocked(callText).mockImplementationOnce(async () => { withdraw(experience); return 'Stale output'; });
      await expect(compile(manager, file(`${name}.md`), model)).rejects.toThrow(/Memory evidence changed/);
      expect(fs.existsSync(file(`${name}.md`))).toBe(false);
    });
    it(`${name} carries summary-specific expiry through compile and cache reads`, async () => {
      seed('2026-10-19T12:01:00.000Z'); await compile(manager, file(`${name}.md`), model); assembleAll();
      expect(isCompiledMemoryEligible(memory)).toBe(true);
      vi.setSystemTime(new Date('2026-10-19T12:01:01.000Z'));
      expect(isCompiledMemoryEligible(memory)).toBe(false);
      expect(readCompiledMemorySections(memory)[name]).toBe('');
    });
    it(`${name} discards an in-flight result if its adopted summary expires`, async () => {
      seed('2026-10-19T12:01:00.000Z');
      vi.mocked(callText).mockImplementationOnce(async () => { vi.setSystemTime(new Date('2026-10-19T12:01:01.000Z')); return 'Expired output'; });
      await expect(compile(manager, file(`${name}.md`), model)).rejects.toThrow(/Memory evidence expired/);
      expect(fs.existsSync(file(`${name}.md`))).toBe(false);
    });
  }
  it('longterm does not fold a revoked week, and rejects withdrawal while folding', async () => {
    const experience = addExperience(); seed(); await compileWeek(manager, file('week.md'), model);
    vi.mocked(callText).mockImplementationOnce(async () => { withdraw(experience); return 'Stale longterm'; });
    await expect(compileLongterm(file('week.md'), file('longterm.md'), model)).rejects.toThrow(/Memory evidence changed/);
    expect(fs.existsSync(file('longterm.md'))).toBe(false);
    vi.mocked(callText).mockClear(); expect(await compileLongterm(file('week.md'), file('longterm.md'), model)).toBe('skipped');
    expect(callText).not.toHaveBeenCalled();
  });
  it('longterm inherits week cutoff and rejects expiry while folding', async () => {
    seed('2026-10-19T12:01:00.000Z'); await compileWeek(manager, file('week.md'), model);
    vi.mocked(callText).mockImplementationOnce(async () => { vi.setSystemTime(new Date('2026-10-19T12:01:01.000Z')); return 'Expired longterm'; });
    await expect(compileLongterm(file('week.md'), file('longterm.md'), model)).rejects.toThrow(/Memory evidence expired/);
    expect(fs.existsSync(file('longterm.md'))).toBe(false);
  });
  it('a facts-only recompile cannot bless old memory or summary sections after expiry or withdrawal', async () => {
    const experience = addExperience(); seed('2026-10-19T12:01:00.000Z'); await compileToday(manager, file('today.md'), model); assembleAll();
    vi.setSystemTime(new Date('2026-10-19T12:01:01.000Z')); withdraw(experience);
    await compileFacts(manager, file('facts.md'), model, { factStore: { getActive: () => [{ fact: 'Fresh canonical fact', memoryId: 'fresh', revision: 1 }] } });
    expect(isCompiledMemoryEligible(memory)).toBe(false); expect(isCompiledSectionEligible(memory, 'today.md')).toBe(false);
    assembleAll(); expect(isCompiledMemoryEligible(memory)).toBe(true);
    expect(fs.readFileSync(file('memory.md'), 'utf8')).toContain('Fresh canonical fact');
    expect(fs.readFileSync(file('memory.md'), 'utf8')).not.toContain('Derived profile from old source');
  });
  it('benign additions preserve source summaries, compiled snapshots and fingerprint hits', async () => {
    seed(); await compileWeek(manager, file('week.md'), model); await compileLongterm(file('week.md'), file('longterm.md'), model); assembleAll();
    addExperience(); expect(manager.getSummary('source')).not.toBeNull(); expect(isCompiledMemoryEligible(memory)).toBe(true);
    expect(await compileWeek(manager, file('week.md'), model)).toBe('skipped');
    expect(await compileLongterm(file('week.md'), file('longterm.md'), model)).toBe('skipped');
  });
  it('legacy files without evidence fail closed after experience withdrawal', async () => {
    fs.writeFileSync(file('memory.md'), 'Legacy derived lesson'); fs.writeFileSync(file('week.md'), 'Legacy week');
    expect(isCompiledMemoryEligible(memory)).toBe(true); withdraw(addExperience());
    expect(isCompiledMemoryEligible(memory)).toBe(false); expect(readCompiledMemorySections(memory).week).toBe('');
    expect(await compileLongterm(file('week.md'), file('longterm.md'), model)).toBe('skipped');
  });
  it('compiled receipts reject file tampering and stale sidecars', async () => {
    seed(); await compileToday(manager, file('today.md'), model); assembleAll();
    fs.writeFileSync(file('memory.md'), 'Restored stale backup'); expect(isCompiledMemoryEligible(memory)).toBe(false);
    fs.writeFileSync(file('compiled-eligibility.json'), '{malformed'); expect(isCompiledMemoryEligible(memory)).toBe(false);
  });
});
