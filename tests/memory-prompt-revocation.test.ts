import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardMemoryContext, getCompiledPromptGeneration, memoryGenerationMarker, sanitizeMemoryPrompt, installMemoryContextGuard } from '../lib/memory/prompt-guard.ts';
import { writeCompiledResetMarker, writeCompiledEligibility, getCompiledMemoryGeneration } from '../lib/memory/compiled-memory-state.ts';
import { FactStore } from '../lib/memory/fact-store.ts';
import { createMemorySearchTool } from '../lib/memory/memory-search.ts';
import { openExperienceStore } from '../lib/experience-store.ts';

let dir: string, memoryDir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-prompt-revoke-')); memoryDir = path.join(dir, 'memory'); fs.mkdirSync(memoryDir); fs.writeFileSync(path.join(memoryDir, 'memory.md'), 'old fact'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const prompt = (body = 'old fact') => '# User Profile\nordinary profile\n---\n\n# Memory\n\n' + memoryGenerationMarker(getCompiledPromptGeneration(memoryDir)) + '\n' + body + '\n## Task Management\npolicy retained';

describe('read-time memory revocation', () => {
  it('preserves unchanged valid snapshot', () => { const input = prompt(); expect(sanitizeMemoryPrompt(input, memoryDir)).toBe(input); });
  it('invalidates compiled-only resets including body separators', () => {
    const input = prompt('old fact\n---\nsecond stale fact');
    writeCompiledResetMarker(memoryDir);
    const result = sanitizeMemoryPrompt(input, memoryDir);
    expect(result).not.toContain('old fact'); expect(result).not.toContain('second stale fact'); expect(result).toContain('policy retained'); expect(result).toContain('ordinary profile');
  });
  it('never revives an expired frozen snapshot after recompile changes eligibility', () => {
    const input = prompt();
    writeCompiledEligibility(memoryDir, [{ expiresAt: '2000-01-01T00:00:00Z' }]);
    expect(sanitizeMemoryPrompt(input, memoryDir)).not.toContain('old fact');
    fs.writeFileSync(path.join(memoryDir, 'memory.md'), 'new fact');
    writeCompiledEligibility(memoryDir, []);
    expect(sanitizeMemoryPrompt(input, memoryDir)).not.toContain('old fact');
  });
  it('does not confuse profile headings or spoofed markers with the actual memory section', () => {
    const input = '# User Profile\n# Memory\nprofile subsection\n' + prompt();
    writeCompiledResetMarker(memoryDir);
    const result = sanitizeMemoryPrompt(input, memoryDir);
    expect(result).toContain('profile subsection'); expect(result).not.toContain('old fact');
  });
  it('leaves an ordinary profile Memory heading untouched when no generated memory was injected', () => {
    const input = '# User Profile\n# Memory\nordinary profile subsection\n## Task Management\npolicy retained';
    writeCompiledResetMarker(memoryDir);
    expect(sanitizeMemoryPrompt(input, memoryDir)).toBe(input);
  });
  it('drops unversioned legacy compiled data while preserving later policy', () => {
    const result = sanitizeMemoryPrompt('# Memory\nlegacy\n---\nstill legacy\n## Task Management\npolicy retained', memoryDir);
    expect(result).not.toContain('legacy'); expect(result).toContain('policy retained');
  });
  it('filters stale retrieved evidence, not original user chat', async () => {
    const store = new FactStore(path.join(memoryDir, 'facts.db'));
    const { id } = store.add({ fact: 'tulip secret fixture' });
    const result = await createMemorySearchTool(store).execute('search', { query: 'tulip' });
    store.delete(id);
    const user = { role: 'user', content: 'tulip secret fixture from original chat' };
    const context = { systemPrompt: '', messages: [user, { role: 'toolResult', toolName: 'search_memory', content: result.content }] };
    const guarded = guardMemoryContext(context, dir);
    expect(guarded.messages[0]).toBe(user); expect(JSON.stringify(guarded.messages[1])).not.toContain('tulip');
    expect(JSON.stringify(context.messages[1])).toContain('tulip');
    store.close();
  });
  it('filters naturally expired retrieved facts even without a deletion event', () => {
    const marker = memoryGenerationMarker(getCompiledMemoryGeneration(memoryDir));
    const valid = { systemPrompt: '', messages: [{ role: 'toolResult', toolName: 'search_memory', content: marker + '\n[codia-memory-valid-until:2999-01-01T00:00:00Z]\ncurrent' }] };
    expect(guardMemoryContext(valid, dir)).toBe(valid);
    const context = { systemPrompt: '', messages: [{ role: 'toolResult', toolName: 'search_memory', content: marker + '\n[codia-memory-valid-until:2000-01-01T00:00:00Z]\nstale' }] };
    expect(JSON.stringify(guardMemoryContext(context, dir).messages)).not.toContain('stale');
  });
  it('invalidates derived compaction but keeps persisted context immutable', () => {
    writeCompiledResetMarker(memoryDir);
    const context = { systemPrompt: '', messages: [{ role: 'compactionSummary', summary: 'old fact', timestamp: 1 }] };
    expect(JSON.stringify(guardMemoryContext(context, dir).messages)).not.toContain('old fact');
    expect(context.messages[0].summary).toBe('old fact');
  });
  it('filters experience history when its evidence revision changes', () => {
    const store = openExperienceStore(dir);
    const previous = store.generation;
    store.createCandidate({ category: 'test', content: 'changed evidence' });
    const context = { systemPrompt: '', messages: [{ role: 'toolResult', toolName: 'recall_experience', content: `[codia-experience-generation:${previous}]\nold experience` }] };
    expect(JSON.stringify(guardMemoryContext(context, dir).messages)).not.toContain('old experience');
    store.close();
  });
  it('applies the same guard to non-desktop model stream runtimes', async () => {
    const input = prompt(); writeCompiledResetMarker(memoryDir);
    let received: any;
    const session = { agent: { streamFn: async (_model: any, context: any) => { received = context; return {}; } } };
    installMemoryContextGuard(session, dir);
    await session.agent.streamFn({}, { systemPrompt: input, messages: [] });
    expect(received.systemPrompt).not.toContain('old fact');
  });
});
