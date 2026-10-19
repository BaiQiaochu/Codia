// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prepareCompactionMock, findCutPointMock } = vi.hoisted(() => ({
  prepareCompactionMock: vi.fn(),
  findCutPointMock: vi.fn(() => ({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false })),
}));
vi.mock('../lib/pi-sdk/index.ts', async (importOriginal) => ({
  ...await importOriginal(),
  prepareCompaction: prepareCompactionMock,
  findCutPoint: findCutPointMock,
}));

import {
  appendCompactionResultToSession,
  createCachePreservingCompactionResult,
  runCachePreservingCompactionForSession,
} from '../core/session-compactor.ts';
import { createCompactionGuardExtension } from '../lib/extensions/compaction-guard-ext.ts';
import { convertAgentMessagesToLlm } from '../lib/pi-sdk/index.ts';
import { openExperienceStore } from '../lib/experience-store.ts';
import { guardMemoryContext, captureMemoryEvidenceEpoch, installMemoryAppendGuard } from '../lib/memory/prompt-guard.ts';
import { appendMemoryRevocation } from '../lib/memory/memory-lifecycle.ts';
import { writeCompiledResetMarker, getCompiledMemoryGeneration } from '../lib/memory/compiled-memory-state.ts';

let agentDir, memoryDir, sessionPath, experienceId;
const privateLesson = 'use the retired amber workaround';
const model = { id: 'model', provider: 'test', reasoning: false, contextWindow: 128000 };
const response = () => ({ stopReason: 'stop', content: [{ type: 'text', text: privateLesson }] });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function withExperience(fn) {
  const store = openExperienceStore(agentDir);
  try { return fn(store); } finally { store.close(); }
}
function preparation(overrides = {}) {
  return {
    messagesToSummarize: [{ role: 'user', content: 'summarize the investigation', timestamp: 1 }],
    turnPrefixMessages: [], previousSummary: null, isSplitTurn: false,
    firstKeptEntryId: 'keep', tokensBefore: 4000,
    settings: { reserveTokens: 2000, keepRecentTokens: 100 },
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    ...overrides,
  };
}
function options(extra = {}) {
  return { preparation: preparation(), model, systemPrompt: '', sessionPath,
    streamFn: vi.fn(async () => ({ result: async () => response() })), ...extra };
}
function session(extra = {}) {
  const prepared = preparation();
  prepareCompactionMock.mockReturnValue(prepared);
  return {
    model, refreshContext: vi.fn(), settingsManager: { getCompactionSettings: () => prepared.settings },
    sessionManager: {
      getSessionFile: () => sessionPath,
      getBranch: () => [
        { type: 'message', id: 'old', message: { role: 'user', content: 'old question', timestamp: 1 } },
        { type: 'message', id: 'keep', message: { role: 'user', content: 'recent question', timestamp: 2 } },
      ],
      appendCompaction: vi.fn(),
    },
    agent: { state: { systemPrompt: '', messages: prepared.messagesToSummarize, tools: [] },
      streamFn: vi.fn(async () => ({ result: async () => response() })), convertToLlm: convertAgentMessagesToLlm },
    ...extra,
  };
}
function revoke(kind) {
  if (kind === 'memory forgetting') appendMemoryRevocation(memoryDir, { all: true, reason: 'test forget' }, null);
  if (kind === 'compiled reset') writeCompiledResetMarker(memoryDir);
  if (kind === 'experience withdrawal') withExperience(store => {
    const entry = store.get(experienceId);
    store.transition(entry.id, entry.revision, 'withdrawn');
  });
}
function extension(extra = {}) {
  let handler;
  const pi = { on: (event, callback) => { if (event === 'session_before_compact') handler = callback; } };
  createCompactionGuardExtension(extra)(pi);
  const ctx = {
    model, getSystemPrompt: () => '',
    modelRegistry: { streamSimple: vi.fn(async () => ({ result: async () => response() })) },
    sessionManager: { getSessionFile: () => sessionPath, getBranch: () => session().sessionManager.getBranch(), buildSessionContext: () => ({}) },
  };
  return { handler, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-compaction-epoch-'));
  memoryDir = path.join(agentDir, 'memory');
  fs.mkdirSync(memoryDir); fs.mkdirSync(path.join(agentDir, 'sessions'));
  fs.writeFileSync(path.join(memoryDir, 'memory.md'), 'current compiled fact');
  sessionPath = path.join(agentDir, 'sessions', 'test.jsonl');
  fs.writeFileSync(sessionPath, JSON.stringify({ role: 'user', content: 'original chat must remain' }) + '\n');
  withExperience(store => {
    let entry = store.createCandidate({ category: 'debugging', content: privateLesson, applicability: { scope: 'global' } }).entry;
    entry = store.recordReview(entry.id, entry.revision, { eventId: 'review-1', runId: 'run-1', reviewerId: 'tester', evidenceRef: 'test://run-1', summary: 'verified fixture', environment: {}, outcome: 'success' });
    entry = store.transition(entry.id, entry.revision, 'validated');
    entry = store.transition(entry.id, entry.revision, 'enabled');
    experienceId = entry.id;
  });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(agentDir, { recursive: true, force: true }); });

describe('compaction source epochs', () => {
  it.each(['memory forgetting', 'compiled reset', 'experience withdrawal'])('discards a deferred model result after %s', async kind => {
    const started = deferred(), pendingResponse = deferred();
    const input = options({ streamFn: vi.fn(async () => { started.resolve(); return { result: () => pendingResponse.promise }; }) });
    const original = fs.readFileSync(sessionPath, 'utf8');
    const pending = createCachePreservingCompactionResult(input);
    const check = expect(pending).rejects.toThrow(/Memory evidence changed/);
    await started.promise;
    revoke(kind); pendingResponse.resolve(response());
    await check;
    expect(fs.readFileSync(sessionPath, 'utf8')).toBe(original);
  });

  it('also rejects in-flight results in cache recovery mode', async () => {
    const started = deferred(), pendingResponse = deferred();
    const pending = createCachePreservingCompactionResult(options({
      cacheMetadataOverride: { cacheStrategy: 'cache_recovery', strict: false, cacheGroup: 'compaction.history' },
      streamFn: vi.fn(async () => { started.resolve(); return { result: () => pendingResponse.promise }; }),
    }));
    const check = expect(pending).rejects.toThrow(/Memory evidence changed/);
    await started.promise; revoke('experience withdrawal'); pendingResponse.resolve(response()); await check;
  });

  it('rejects split-turn compaction if either response crosses a withdrawal', async () => {
    const bothStarted = deferred(), pendingResponse = deferred();
    let calls = 0;
    const pending = createCachePreservingCompactionResult(options({
      preparation: preparation({ isSplitTurn: true, turnPrefixMessages: [{ role: 'user', content: 'turn prefix' }] }),
      streamFn: vi.fn(async () => { if (++calls === 2) bothStarted.resolve(); return { result: () => pendingResponse.promise }; }),
    }));
    const check = expect(pending).rejects.toThrow(/Memory evidence changed/);
    await bothStarted.promise; revoke('experience withdrawal'); pendingResponse.resolve(response()); await check;
    expect(calls).toBe(2);
  });

  it('rejects before append when revocation follows the returned model result', async () => {
    const result = await createCachePreservingCompactionResult(options());
    revoke('compiled reset');
    const target = session();
    await expect(appendCompactionResultToSession(target, result)).rejects.toThrow(/Memory evidence changed/);
    expect(target.sessionManager.appendCompaction).not.toHaveBeenCalled();
    expect(target.refreshContext).not.toHaveBeenCalled();
  });

  it('never grants an unversioned model summary a fresh epoch at append time', async () => {
    const target = session();
    await expect(appendCompactionResultToSession(target, { summary: privateLesson, firstKeptEntryId: 'keep', tokensBefore: 10, details: {} }))
      .rejects.toThrow(/Memory evidence changed/);
    expect(target.sessionManager.appendCompaction).not.toHaveBeenCalled();
  });

  it('compacts a custom persist path using the installed manager scope', async () => {
    const target = session();
    const append = target.sessionManager.appendCompaction;
    target.sessionManager.getSessionFile = () => path.join(agentDir, 'custom-persist', 'outside-sessions.jsonl');
    installMemoryAppendGuard(target, agentDir);
    const result = await runCachePreservingCompactionForSession(target);
    expect(result.details.memoryEvidenceEpoch).toBeDefined();
    expect(append).toHaveBeenCalledOnce();
    expect(target.refreshContext).toHaveBeenCalledOnce();
  });

  it('stamps a custom-path coordinator hard-truncate placeholder before the installed append guard', async () => {
    const target = session();
    const append = target.sessionManager.appendCompaction;
    target.sessionManager.getSessionFile = () => path.join(agentDir, 'custom-persist', 'outside-sessions.jsonl');
    installMemoryAppendGuard(target, agentDir);
    const result = await appendCompactionResultToSession(target, {
      summary: '[Earlier conversation history was truncated]', firstKeptEntryId: 'keep', tokensBefore: 100,
      details: { reason: 'model-switch-truncation' },
    });
    expect(result.details.memoryEvidenceEpoch).toBeDefined();
    expect(append).toHaveBeenCalledOnce();
  });

  it('captures the source before an asynchronous context transformation', async () => {
    const started = deferred(), transformed = deferred();
    const target = session();
    target.agent.transformContext = vi.fn(() => { started.resolve(); return transformed.promise; });
    const pending = runCachePreservingCompactionForSession(target);
    const check = expect(pending).rejects.toThrow(/Memory evidence changed/);
    await started.promise; revoke('experience withdrawal'); transformed.resolve(target.agent.state.messages); await check;
    expect(target.sessionManager.appendCompaction).not.toHaveBeenCalled();
    expect(target.agent.streamFn).not.toHaveBeenCalled();
  });

  it('rejects a deferred direct-session summary without appending it', async () => {
    const started = deferred(), pendingResponse = deferred(), target = session();
    target.agent.streamFn = vi.fn(async () => { started.resolve(); return { result: () => pendingResponse.promise }; });
    const pending = runCachePreservingCompactionForSession(target);
    const check = expect(pending).rejects.toThrow(/Memory evidence changed/);
    await started.promise; revoke('memory forgetting'); pendingResponse.resolve(response()); await check;
    expect(target.sessionManager.appendCompaction).not.toHaveBeenCalled();
  });

  it('keeps source metadata through real SDK conversion and filters a later withdrawal', async () => {
    const result = await createCachePreservingCompactionResult(options());
    expect(result.details.memoryEvidenceEpoch).toMatchObject({ lifecycleGeneration: '0' });
    expect(result.summary).toMatch(/^\[codia-memory-evidence-epoch:/);
    const nativeSummary = { role: 'compactionSummary', summary: result.summary, tokensBefore: 10, timestamp: Date.now() + 60_000 };
    const user = { role: 'user', content: 'original chat must remain', timestamp: 1 };
    const context = { systemPrompt: '', messages: convertAgentMessagesToLlm([nativeSummary, user]) };
    expect(JSON.stringify(guardMemoryContext(context, agentDir))).toContain(privateLesson);
    const original = JSON.stringify(context);
    revoke('experience withdrawal');
    const guarded = guardMemoryContext(context, agentDir);
    expect(JSON.stringify(guarded)).not.toContain(privateLesson);
    expect(guarded.messages[1]).toBe(user);
    expect(JSON.stringify(context)).toBe(original);
    expect(fs.readFileSync(sessionPath, 'utf8')).toContain('original chat must remain');
  });

  it('sanitizes a previous summary before embedding it in a user instruction', async () => {
    const first = await createCachePreservingCompactionResult(options());
    revoke('experience withdrawal');
    const input = options({ preparation: preparation({ previousSummary: first.summary }) });
    await createCachePreservingCompactionResult(input);
    expect(JSON.stringify(input.streamFn.mock.calls[0][1])).not.toContain(privateLesson);
    expect(JSON.stringify(input.streamFn.mock.calls[0][1])).toContain('invalidated');
  });

  it('does not invalidate a summary for benign new memory or candidate additions', async () => {
    const result = await createCachePreservingCompactionResult(options());
    fs.writeFileSync(path.join(memoryDir, 'memory.md'), 'current compiled fact\nnew unrelated fact');
    withExperience(store => store.createCandidate({ category: 'new', content: 'unrelated unverified candidate' }));
    const context = { systemPrompt: '', messages: [{ role: 'compactionSummary', summary: result.summary, details: result.details }] };
    expect(guardMemoryContext(context, agentDir)).toBe(context);
  });

  it('stamps the hard-truncate placeholder without invoking a model', async () => {
    const target = session({ model: { ...model, contextWindow: 100 } });
    const result = await runCachePreservingCompactionForSession(target);
    expect(result.details.memoryEvidenceEpoch).toBeDefined();
    expect(result.summary).toMatch(/^\[codia-memory-evidence-epoch:/);
    expect(target.agent.streamFn).not.toHaveBeenCalled();
    expect(target.sessionManager.appendCompaction).toHaveBeenCalledOnce();
  });

  it('can compact again after removing an already expired retrieved result', async () => {
    const input = options({ preparation: preparation({ messagesToSummarize: [
      { role: 'toolResult', toolCallId: 'expired', toolName: 'search_memory', timestamp: 1, content: [
        { type: 'text', text: `[codia-memory-generation:${getCompiledMemoryGeneration(memoryDir)}]\n[codia-memory-valid-until:2000-01-01T00:00:00Z]\nexpired crimson fact` },
      ] },
    ] }) });
    const result = await createCachePreservingCompactionResult(input);
    expect(result.summary).toContain(privateLesson);
    expect(JSON.stringify(input.streamFn.mock.calls[0][1])).not.toContain('expired crimson fact');
  });

  it('can compact sanitized withdrawn retrieval without a repeated snapshot failure', async () => {
    const oldGeneration = withExperience(store => store.generation);
    revoke('experience withdrawal');
    const input = options({ preparation: preparation({ messagesToSummarize: [
      { role: 'toolResult', toolCallId: 'old', toolName: 'recall_experience', timestamp: 1, content: [
        { type: 'text', text: `[codia-experience-generation:${oldGeneration}]\nwithdrawn crimson lesson` },
      ] },
    ] }) });
    await createCachePreservingCompactionResult(input);
    expect(JSON.stringify(input.streamFn.mock.calls[0][1])).not.toContain('withdrawn crimson lesson');
  });

  it('discards a result when its retrieved source expires during generation', async () => {
    const started = deferred(), pendingResponse = deferred();
    const expires = Date.now() + 60_000;
    const validUntil = new Date(expires).toISOString();
    const pending = createCachePreservingCompactionResult(options({ preparation: preparation({ messagesToSummarize: [
      { role: 'toolResult', toolCallId: 'expiring', toolName: 'search_memory', timestamp: 1, content: [
        { type: 'text', text: `[codia-memory-generation:${getCompiledMemoryGeneration(memoryDir)}]\n[codia-memory-valid-until:${validUntil}]\nexpiring fact` },
      ] },
    ] }), streamFn: vi.fn(async () => { started.resolve(); return { result: () => pendingResponse.promise }; }) }));
    const check = expect(pending).rejects.toThrow(/Memory evidence expired/);
    await started.promise;
    vi.spyOn(Date, 'now').mockReturnValue(expires + 1);
    pendingResponse.resolve(response()); await check;
  });

  it('inherits the cutoff through a chain of summaries instead of refreshing its validity', async () => {
    const validUntil = new Date(Date.now() + 60_000).toISOString();
    const first = await createCachePreservingCompactionResult(options({ preparation: preparation({ messagesToSummarize: [
      { role: 'toolResult', toolCallId: 'first', toolName: 'search_memory', timestamp: 1, content: [
        { type: 'text', text: `[codia-memory-generation:${getCompiledMemoryGeneration(memoryDir)}]\n[codia-memory-valid-until:${validUntil}]\nshort-lived fact` },
      ] },
    ] }) }));
    const second = await createCachePreservingCompactionResult(options({ preparation: preparation({ previousSummary: first.summary }) }));
    expect(second.details.memoryEvidenceEpoch.expiresAt).toBe(validUntil);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(validUntil) + 1);
    const context = { systemPrompt: '', messages: [{ role: 'compactionSummary', summary: second.summary }] };
    expect(JSON.stringify(guardMemoryContext(context, agentDir))).not.toContain(privateLesson);
  });

  it('includes expiry introduced by context transformation without refreshing the original epoch', async () => {
    const target = session();
    const validUntil = new Date(Date.now() + 60_000).toISOString();
    target.agent.transformContext = async () => [{ role: 'toolResult', toolCallId: 'transformed', toolName: 'search_memory', timestamp: 1, content: [
      { type: 'text', text: `[codia-memory-generation:${getCompiledMemoryGeneration(memoryDir)}]\n[codia-memory-valid-until:${validUntil}]\nnew transformed fact` },
    ] }];
    const result = await runCachePreservingCompactionForSession(target);
    expect(result.details.memoryEvidenceEpoch.expiresAt).toBe(validUntil);
  });

  it('binds the earliest retrieved expiry to the summary source', async () => {
    const validUntil = new Date(Date.now() + 3_600_000).toISOString();
    const result = await createCachePreservingCompactionResult(options({ preparation: preparation({
      messagesToSummarize: [{ role: 'toolResult', toolCallId: 'recall', toolName: 'search_memory', content: [
        { type: 'text', text: `[codia-memory-generation:${getCompiledMemoryGeneration(memoryDir)}]\n[codia-memory-valid-until:${validUntil}]\nscoped fact` },
      ], timestamp: Date.now() }],
    }) }));
    expect(result.details.memoryEvidenceEpoch.expiresAt).toBe(validUntil);
  });
});

describe('memory-scoped compaction extension', () => {
  it('routes pi-compatible mode through epoch-aware compaction', async () => {
    const { handler, ctx } = extension({ getCompactionMode: () => 'pi_compatible' });
    const result = await handler({ preparation: preparation() }, ctx);
    expect(result.compaction.details.memoryEvidenceEpoch).toBeDefined();
    expect(ctx.modelRegistry.streamSimple).toHaveBeenCalledOnce();
  });

  it('keeps custom-path pi-compatible compaction inside the installed memory scope', async () => {
    const { handler, ctx } = extension({ getCompactionMode: () => 'pi_compatible' });
    ctx.sessionManager.getSessionFile = () => path.join(agentDir, 'custom-persist', 'outside-sessions.jsonl');
    ctx.sessionManager.appendCompaction = vi.fn();
    installMemoryAppendGuard(ctx, agentDir);
    const result = await handler({ preparation: preparation() }, ctx);
    expect(result.compaction.details.memoryEvidenceEpoch).toBeDefined();
    expect(ctx.modelRegistry.streamSimple).toHaveBeenCalledOnce();
    expect(() => ctx.sessionManager.appendCompaction(result.compaction.summary, 'keep', 10, result.compaction.details)).not.toThrow();
  });

  it('preserves native pi-compatible behavior outside a memory-scoped session', async () => {
    const { handler, ctx } = extension({ getCompactionMode: () => 'pi_compatible' });
    ctx.sessionManager.getSessionFile = () => '/not-memory-scoped/current.jsonl';
    expect(await handler({ preparation: preparation() }, ctx)).toBeUndefined();
    expect(ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });

  it('captures the epoch before authentication yields', async () => {
    const authStarted = deferred(), auth = deferred();
    const cacheCompactor = vi.fn(async () => ({ summary: privateLesson, details: {} }));
    const { handler, ctx } = extension({ cacheCompactor });
    ctx.modelRegistry = { getApiKeyAndHeaders: () => { authStarted.resolve(); return auth.promise; } };
    const pending = handler({ preparation: preparation() }, ctx);
    await authStarted.promise; revoke('experience withdrawal'); auth.resolve({ ok: true, apiKey: 'test-key' });
    expect(await pending).toEqual({ cancel: true });
    expect(cacheCompactor.mock.calls[0][0].memoryEvidenceEpoch).not.toEqual(captureMemoryEvidenceEpoch(agentDir));
  });

  it.each(['preemptive', 'request budget'])('stamps the %s hard-truncate branch', async mode => {
    const { handler, ctx } = extension();
    ctx.model = { ...model, contextWindow: 3000 };
    const input = preparation({ messagesToSummarize: [{ role: 'user', content: mode === 'preemptive' ? 'x'.repeat(14000) : 'short' }] });
    const result = await handler({ preparation: input }, ctx);
    expect(result.compaction.details.memoryEvidenceEpoch).toBeDefined();
    expect(result.compaction.summary).toMatch(/^\[codia-memory-evidence-epoch:/);
    expect(ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });
});
