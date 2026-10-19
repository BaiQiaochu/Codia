// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/llm-client.ts', () => ({ callText: vi.fn() }));
vi.mock('../lib/i18n.ts', () => ({ getLocale: () => 'en-US', t: key => key }));

import { callText } from '../core/llm-client.ts';
import { generateDiaryCompactionSummary, resolveDiaryDir, writeDiary } from '../lib/diary/diary-writer.ts';
import { clearCompiledMemoryArtifacts, getCompiledMemoryGeneration, isCompiledMemoryEligible, isCompiledSectionEligible, writeCompiledEligibility, writeCompiledResetMarker } from '../lib/memory/compiled-memory-state.ts';
import { captureMemoryEvidenceEpoch, memoryGenerationMarker } from '../lib/memory/prompt-guard.ts';
import { assemble } from '../lib/memory/compile.ts';
import { openExperienceStore } from '../lib/experience-store.ts';

let root, memoryDir, sessionDir;
const model = { id: 'diary-model', provider: 'test', api: 'openai-completions', baseUrl: 'http://localhost:1234' };
const resolvedModel = { model, api: model.api, base_url: model.baseUrl, api_key: 'fixture' };
const currentMessages = () => [{ role: 'user', content: 'We finished the diary project today.', timestamp: '2026-05-07T12:00:00.000Z' }];
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function forget() {
  writeCompiledResetMarker(memoryDir);
  clearCompiledMemoryArtifacts(memoryDir);
}
function opts(overrides = {}) {
  return {
    agentDir: root, sessionDir, cwd: root, resolvedModel, targetDate: '2026-05-07',
    agentPersonality: 'Write a private diary.', userName: 'Tester', agentName: 'Nova',
    memory: 'frozen old background', todayMdPath: path.join(memoryDir, 'today.md'),
    summaryManager: {
      getSummariesInRange: vi.fn().mockReturnValue([{
        session_id: 'today', summary: 'Today we finished a small project.',
        created_at: '2026-05-07T12:00:00.000Z', updated_at: '2026-05-07T12:00:00.000Z',
      }]),
      getSummary: vi.fn().mockReturnValue(null), rollingSummary: vi.fn(),
    },
    ...overrides,
  };
}
function sessionFile() {
  const file = path.join(sessionDir, 'today.jsonl');
  fs.writeFileSync(file, currentMessages().map(message => JSON.stringify({ type: 'message', timestamp: message.timestamp, message })).join('\n') + '\n');
  return file;
}
function allPromptText(call = callText.mock.calls.at(-1)[0]) { return JSON.stringify({ systemPrompt: call.systemPrompt, messages: call.messages }); }

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-07T15:00:00.000Z'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-diary-evidence-'));
  memoryDir = path.join(root, 'memory'); sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(memoryDir); fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(memoryDir, 'memory.md'), 'live background fixture');
  callText.mockResolvedValue('# 2026-05-07 Test diary\n\nCurrent events.');
});
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

describe('diary memory evidence boundaries', () => {
  it('omits expired compiled background and today fallback, including caller snapshots', async () => {
    fs.writeFileSync(path.join(memoryDir, 'today.md'), 'expired today fixture '.repeat(30));
    writeCompiledEligibility(memoryDir, [{ expiresAt: '2026-05-07T14:59:59.000Z' }]);
    const result = await writeDiary(opts());
    expect(result.error).toBeUndefined();
    expect(allPromptText()).not.toMatch(/live background fixture|frozen old background|expired today fixture/);
    expect(allPromptText()).toContain('finished a small project');
  });

  it('reads live eligible background instead of frozen caller memory', async () => {
    const result = await writeDiary(opts());
    expect(result.error).toBeUndefined();
    expect(allPromptText()).toContain('live background fixture');
    expect(allPromptText()).not.toContain('frozen old background');
  });

  it.each(['expiry', 'withdrawal'])('does not revive stale today fallback after a fresh memory assembly (%s)', async reason => {
    const todayPath = path.join(memoryDir, 'today.md');
    fs.writeFileSync(todayPath, 'stale today evidence '.repeat(20));
    writeCompiledEligibility(memoryDir, [], {
      section: 'today.md', epoch: { ...captureMemoryEvidenceEpoch(root), expiresAt: '2026-05-07T15:01:00.000Z' },
    });
    if (reason === 'expiry') vi.setSystemTime(new Date('2026-05-07T15:01:01.000Z'));
    else {
      const store = openExperienceStore(root);
      try { store.clear(); } finally { store.close(); }
    }
    fs.writeFileSync(path.join(memoryDir, 'facts.md'), 'Fresh canonical background.');
    writeCompiledEligibility(memoryDir, [], { section: 'facts.md', epoch: captureMemoryEvidenceEpoch(root) });
    assemble(...['facts.md', 'today.md', 'week.md', 'longterm.md', 'memory.md'].map(name => path.join(memoryDir, name)));
    expect(isCompiledMemoryEligible(memoryDir)).toBe(true);
    expect(isCompiledSectionEligible(memoryDir, 'today.md')).toBe(false);
    const options = opts();
    options.summaryManager.getSummariesInRange.mockReturnValue([{
      session_id: 'today', summary: 'A short current summary.',
      memoryEvidenceEpoch: captureMemoryEvidenceEpoch(root), created_at: '2026-05-07T12:00:00.000Z',
    }]);
    expect((await writeDiary(options)).error).toBeUndefined();
    expect(allPromptText()).toContain('Fresh canonical background');
    expect(allPromptText()).toContain('A short current summary');
    expect(allPromptText()).not.toContain('stale today evidence');
    expect(fs.readFileSync(todayPath, 'utf8')).toContain('stale today evidence');
  });

  it('carries an adopted today receipt cutoff even when the aggregate cutoff is absent', async () => {
    fs.writeFileSync(path.join(memoryDir, 'today.md'), 'current today evidence '.repeat(20));
    writeCompiledEligibility(memoryDir, [], {
      section: 'today.md', epoch: { ...captureMemoryEvidenceEpoch(root), expiresAt: '2026-05-07T15:01:00.000Z' },
    });
    // The artifact receipt is the source of truth; the aggregate is only a hint.
    const eligibilityPath = path.join(memoryDir, 'compiled-eligibility.json');
    const eligibility = JSON.parse(fs.readFileSync(eligibilityPath, 'utf8'));
    eligibility.expiresAt = null;
    fs.writeFileSync(eligibilityPath, JSON.stringify(eligibility));
    callText.mockImplementationOnce(async () => {
      expect(allPromptText()).toContain('current today evidence');
      vi.setSystemTime(new Date('2026-05-07T15:01:01.000Z'));
      return '# 2026-05-07 Expired today\n\nToo late.';
    });
    expect(await writeDiary(opts())).toMatchObject({ code: 'MEMORY_EVIDENCE_CHANGED', retryable: true });
    expect(fs.existsSync(resolveDiaryDir(root))).toBe(false);
  });

  it('discards an in-flight diary on forget, preserves prior files, and allows a clean retry', async () => {
    const file = sessionFile(); const rawChat = fs.readFileSync(file, 'utf8');
    const diaryDir = resolveDiaryDir(root); fs.mkdirSync(diaryDir, { recursive: true });
    const prior = path.join(diaryDir, '2026-05-07 Test diary.md');
    fs.writeFileSync(prior, 'Existing user diary must survive.');
    const started = deferred(), response = deferred();
    callText.mockImplementationOnce(() => { started.resolve(); return response.promise; });
    const pending = writeDiary(opts());
    await started.promise;
    forget();
    response.resolve('# 2026-05-07 Test diary\n\nOld forgotten memory.');
    const rejected = await pending;
    expect(rejected).toMatchObject({ code: 'MEMORY_EVIDENCE_CHANGED', retryable: true });
    expect(fs.readFileSync(prior, 'utf8')).toBe('Existing user diary must survive.');
    expect(fs.readFileSync(file, 'utf8')).toBe(rawChat);
    expect(fs.readdirSync(diaryDir)).toEqual(['2026-05-07 Test diary.md']);
    fs.writeFileSync(path.join(memoryDir, 'memory.md'), 'fresh background after retry');
    writeCompiledEligibility(memoryDir, [], { section: 'memory.md', epoch: captureMemoryEvidenceEpoch(root) });
    callText.mockResolvedValueOnce('# 2026-05-07 Retry\n\nFresh diary.');
    const retried = await writeDiary(opts());
    expect(retried.error).toBeUndefined();
    expect(allPromptText()).toContain('fresh background after retry');
    expect(allPromptText()).not.toContain('frozen old background');
  });

  it('discards a model response when included compiled evidence expires in flight', async () => {
    writeCompiledEligibility(memoryDir, [{ expiresAt: '2026-05-07T15:01:00.000Z' }]);
    callText.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date('2026-05-07T15:01:01.000Z'));
      return '# 2026-05-07 Expired\n\nToo late.';
    });
    expect(await writeDiary(opts())).toMatchObject({ code: 'MEMORY_EVIDENCE_CHANGED', retryable: true });
    expect(fs.existsSync(resolveDiaryDir(root))).toBe(false);
  });

  it('inherits the expiry of an adopted persisted summary through the final diary request', async () => {
    const epoch = { ...captureMemoryEvidenceEpoch(root), expiresAt: '2026-05-07T15:01:00.000Z' };
    const options = opts();
    options.summaryManager.getSummariesInRange.mockReturnValue([{
      session_id: 'expiring-summary', summary: 'Evidence that is still current when read.',
      memoryEvidenceEpoch: epoch, created_at: '2026-05-07T12:00:00.000Z',
    }]);
    callText.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date('2026-05-07T15:01:01.000Z'));
      return '# 2026-05-07 Expired summary\n\nToo late.';
    });
    expect(await writeDiary(options)).toMatchObject({ code: 'MEMORY_EVIDENCE_CHANGED', retryable: true });
    expect(fs.existsSync(resolveDiaryDir(root))).toBe(false);
  });

  it('binds expiry from a benign background recompile during material preparation', async () => {
    sessionFile();
    const options = opts({
      summaryManager: { getSummariesInRange: () => [], getSummary: () => null },
      isSessionMemoryEnabledForPath: () => false,
      generateTemporarySummary: async () => {
        fs.writeFileSync(path.join(memoryDir, 'memory.md'), 'new short-lived background');
        writeCompiledEligibility(memoryDir, [{ expiresAt: '2026-05-07T15:01:00.000Z' }]);
        return 'Fresh temporary conversation material.';
      },
    });
    callText.mockImplementationOnce(async () => {
      expect(allPromptText()).toContain('new short-lived background');
      vi.setSystemTime(new Date('2026-05-07T15:01:01.000Z'));
      return '# 2026-05-07 Newly expired\n\nToo late.';
    });
    expect(await writeDiary(options)).toMatchObject({ code: 'MEMORY_EVIDENCE_CHANGED', retryable: true });
    expect(fs.existsSync(resolveDiaryDir(root))).toBe(false);
  });

  it('preserves existing same-title diaries and makes identical successful retries idempotent', async () => {
    const diaryDir = resolveDiaryDir(root); fs.mkdirSync(diaryDir, { recursive: true });
    const previous = path.join(diaryDir, '2026-05-07 Test diary.md');
    fs.writeFileSync(previous, 'Prior user-written diary.');
    const first = await writeDiary(opts());
    const second = await writeDiary(opts());
    expect(first.error).toBeUndefined();
    expect(first.filePath).toBe(path.join(diaryDir, '2026-05-07 Test diary (2).md'));
    expect(second.filePath).toBe(first.filePath);
    expect(fs.readFileSync(previous, 'utf8')).toBe('Prior user-written diary.');
    expect(fs.readdirSync(diaryDir)).toHaveLength(2);
  });

  it('cleans old retrieval and compaction material without mutating original messages', async () => {
    const retrieval = { role: 'toolResult', toolName: 'search_memory', content: memoryGenerationMarker(getCompiledMemoryGeneration(memoryDir)) + '\nforgotten retrieval fixture' };
    forget();
    const messages = [...currentMessages(), retrieval, { role: 'compactionSummary', summary: 'forgotten compacted fixture' }];
    const original = JSON.stringify(messages);
    await generateDiaryCompactionSummary({ messages, model, apiKey: 'fixture', sessionPath: path.join(sessionDir, 'today.jsonl'), previousSummary: 'forgotten previous fixture' });
    expect(allPromptText()).not.toMatch(/forgotten retrieval fixture|forgotten compacted fixture|forgotten previous fixture/);
    expect(allPromptText()).toContain('finished the diary project');
    expect(JSON.stringify(messages)).toBe(original);
  });

  it('rejects temporary compaction if forgetting happens during its model call', async () => {
    callText.mockImplementationOnce(async () => { forget(); return 'obsolete temporary summary'; });
    await expect(generateDiaryCompactionSummary({ messages: currentMessages(), model, apiKey: 'fixture', agentDir: root }))
      .rejects.toMatchObject({ code: 'MEMORY_EVIDENCE_CHANGED', retryable: true });
  });

  it('carries session provenance across delayed authentication and stops before the model call', async () => {
    sessionFile();
    const started = deferred(), auth = deferred();
    const options = opts({
      summaryManager: { getSummariesInRange: () => [], getSummary: () => null },
      isSessionMemoryEnabledForPath: () => false,
      getCompactionAuth: () => { started.resolve(); return auth.promise; },
    });
    const pending = writeDiary(options);
    await started.promise;
    forget(); auth.resolve({ apiKey: 'fixture' });
    expect(await pending).toMatchObject({ code: 'MEMORY_EVIDENCE_CHANGED', retryable: true });
    expect(callText).not.toHaveBeenCalled();
    expect(fs.existsSync(resolveDiaryDir(root))).toBe(false);
  });

  it('rejects an engine snapshot captured before memory preparation changed', async () => {
    const epoch = captureMemoryEvidenceEpoch(root);
    forget();
    expect(await writeDiary(opts({ memoryEvidenceEpoch: epoch }))).toMatchObject({ retryable: true });
    expect(callText).not.toHaveBeenCalled();
  });

  it('keeps standalone compatibility when no real memory directory exists', async () => {
    fs.rmSync(memoryDir, { recursive: true });
    const result = await writeDiary(opts());
    expect(result.error).toBeUndefined();
    expect(allPromptText()).toContain('frozen old background');
    expect(fs.existsSync(memoryDir)).toBe(false);
    expect(fs.existsSync(path.join(root, 'experience'))).toBe(false);
  });
});
