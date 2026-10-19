/** Revocation is a read-time rule, including frozen/restored model contexts. Raw chat is untouched. */
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { readMemoryLifecycle } from './memory-lifecycle.ts';
import { openExperienceStore } from '../experience-store.ts';
import { isCompiledMemoryEligible, getCompiledMemoryGeneration, readCompiledResetAt } from './compiled-memory-state.ts';

const MEMORY_MARKER = /\[codia-memory-generation:([^\]]+)\]/;
const EXPERIENCE_MARKER = /\[codia-experience-generation:([^\]]+)\]/;
const REVOKED_TOOL_NOTICE = 'Previously retrieved evidence has changed or been withdrawn. Recall again for current evidence.';
const REVOKED_SUMMARY_NOTICE = 'Earlier derived context was invalidated after memory correction or forgetting. Original chat remains saved separately.';
export function memoryGenerationMarker(generation: string) { return `[codia-memory-generation:${generation}]`; }

export function getCompiledPromptGeneration(memoryDir: string): string {
  let content = '';
  try { content = fs.readFileSync(path.join(memoryDir, 'memory.md'), 'utf8'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return `${getCompiledMemoryGeneration(memoryDir)}:${createHash('sha256').update(content).digest('hex')}`;
}

export type MemoryEvidenceEpoch = { lifecycleGeneration: string; compiledGeneration: string; experienceGeneration: string; capturedAt: string; expiresAt?: string | null };
export function captureMemoryEvidenceEpoch(agentDir: string, context?: any): MemoryEvidenceEpoch {
  const store = openExperienceStore(agentDir);
  try {
    const memoryDir = path.join(agentDir, 'memory');
    const expirations: string[] = [];
    try {
      const eligibility = JSON.parse(fs.readFileSync(path.join(memoryDir, 'compiled-eligibility.json'), 'utf8'));
      if (eligibility.expiresAt) expirations.push(eligibility.expiresAt);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    for (const message of context?.messages || []) {
      const text = messageText(message) || message.summary || '';
      const expiry = text.match(/\[codia-memory-valid-until:([^\]]+)\]/)?.[1];
      if (expiry && expiry !== 'none') expirations.push(expiry);
      const prior = summaryEvidenceEpoch(message, text);
      if (prior?.expiresAt) expirations.push(prior.expiresAt);
    }
    return { lifecycleGeneration: readMemoryLifecycle(memoryDir).generation,
      compiledGeneration: getCompiledMemoryGeneration(memoryDir), experienceGeneration: String(store.revocationGeneration),
      capturedAt: new Date().toISOString(), expiresAt: expirations.filter(value => Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()).sort()[0] || null };
  } finally { store.close(); }
}
export function assertMemoryEvidenceEpoch(agentDir: string, expected: MemoryEvidenceEpoch) {
  const actual = captureMemoryEvidenceEpoch(agentDir);
  if (!expected || ['lifecycleGeneration', 'compiledGeneration', 'experienceGeneration'].some(key => actual[key] !== expected[key])) {
    throw new Error('Memory evidence changed while compaction was in flight; discard and retry from current evidence');
  }
  if (expected.expiresAt && (!Number.isFinite(Date.parse(expected.expiresAt)) || Date.parse(expected.expiresAt) <= Date.now())) throw new Error('Memory evidence expired while compaction was in flight');
}
export function memoryEvidenceEpochMarker(epoch: MemoryEvidenceEpoch): string {
  return `[codia-memory-evidence-epoch:${Buffer.from(JSON.stringify(epoch)).toString('base64url')}]`;
}
function summaryEvidenceEpoch(message: any, text: string): MemoryEvidenceEpoch | null {
  if (message.details?.memoryEvidenceEpoch) return message.details.memoryEvidenceEpoch;
  const encoded = text.match(/\[codia-memory-evidence-epoch:([A-Za-z0-9_-]+)\]/)?.[1];
  if (!encoded) return null;
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { return null; }
}

export function memoryAgentDirFromSessionPath(sessionPath?: string): string | null {
  if (!sessionPath || !path.isAbsolute(sessionPath)) return null;
  let directory = path.dirname(sessionPath);
  while (true) {
    if (['sessions', '.ephemeral', 'activity'].includes(path.basename(directory))) {
      const candidate = path.dirname(directory);
      return fs.existsSync(path.join(candidate, 'memory')) ? candidate : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function sanitizeMemoryPrompt(prompt: string, memoryDir: string): string {
  const generation = getCompiledPromptGeneration(memoryDir);
  const taskBoundary = prompt.lastIndexOf('\n## Task Management');
  const prefix = taskBoundary >= 0 ? prompt.slice(0, taskBoundary) : prompt;
  const markedSections = [...prefix.matchAll(/(^|\n)# Memory[ \t]*\n[\s]*\[codia-memory-generation:[^\]]+\]/g)];
  // Recognize the old generated introduction rather than arbitrary profile headings.
  // A standalone legacy Memory prompt is also accepted for imported snapshots.
  const legacySections = [...prefix.matchAll(/(^|\n)# Memory[ \t]*\n\s*The following are memories accumulated from past conversations\./g)];
  const standaloneLegacy = /^# Memory[ \t]*\n/.test(prefix) ? { index: 0 } : null;
  const start = (markedSections.at(-1) || legacySections.at(-1) || standaloneLegacy)?.index ?? -1;
  if (start < 0) return prompt;
  const end = taskBoundary > start ? taskBoundary : prompt.length;
  const section = prompt.slice(start, end);
  const previous = section.match(/^\n?# Memory\s*\n\s*\[codia-memory-generation:([^\]]+)\]/)?.[1] || 'legacy';
  if (previous === generation && isCompiledMemoryEligible(memoryDir)) return prompt;
  // Legacy content may itself contain separators. End at the fixed section
  // following Memory, not the first attacker-controlled markdown separator.
  return prompt.slice(0, start) + `\n# Memory\n\n${memoryGenerationMarker(generation)}\nEarlier memory was corrected or forgotten. Use search_memory for current evidence.\n` + prompt.slice(end);
}

function messageText(message: any): string {
  return typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.map((part: any) => part.text || '').join('\n') : '';
}

/** Return a copy only when needed; never rewrite the user's persisted messages. */
export function guardMemoryContext(context: any, agentDir: string) {
  if (!context || !agentDir) return context;
  const memoryDir = path.join(agentDir, 'memory');
  const lifecycle = readMemoryLifecycle(memoryDir);
  const generation = getCompiledMemoryGeneration(memoryDir);
  const resetAt = [lifecycle.resetAt, readCompiledResetAt(memoryDir)].filter(Boolean).sort().at(-1);
  let changed = false;
  const systemPrompt = sanitizeMemoryPrompt(String(context.systemPrompt || ''), memoryDir);
  if (systemPrompt !== context.systemPrompt) changed = true;
  let experienceGeneration: string | null = null;
  const messages = (context.messages || []).map((message: any) => {
    const rawText = messageText(message);
    const isSummary = ['compactionSummary', 'branchSummary'].includes(message.role)
      || (message.role === 'user' && /^(The conversation history before this point was compacted into the following summary:|The following is a summary of a branch that this conversation came back from:)\s/.test(rawText));
    if (message.role === 'toolResult' && message.details?.revoked === true && rawText === REVOKED_TOOL_NOTICE) return message;
    const summaryBody = message.summary || rawText.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/)?.[1] || rawText;
    if (isSummary && summaryBody.trim() === REVOKED_SUMMARY_NOTICE) return message;
    let staleSummary = false;
    if (isSummary) {
      const epoch = summaryEvidenceEpoch(message, rawText || message.summary || '');
      if (epoch) {
        try { assertMemoryEvidenceEpoch(agentDir, epoch); } catch { staleSummary = true; }
      } else {
        const current = captureMemoryEvidenceEpoch(agentDir);
        staleSummary = !!resetAt || current.experienceGeneration !== '0';
      }
    }
    if (staleSummary) {
      changed = true;
      return { ...message, summary: REVOKED_SUMMARY_NOTICE,
        content: [{ type: 'text', text: REVOKED_SUMMARY_NOTICE }], details: { revoked: true } };
    }
    if (message.role !== 'toolResult') return message;
    let stale = false;
    if (message.toolName === 'search_memory') {
      const previous = messageText(message).match(MEMORY_MARKER)?.[1] || '0';
      stale = previous !== generation;
      const validUntil = rawText.match(/\[codia-memory-valid-until:([^\]]+)\]/)?.[1];
      if (validUntil && validUntil !== 'none' && (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= Date.now())) stale = true;
    }
    if (message.toolName === 'recall_experience') {
      if (experienceGeneration === null) {
        const store = openExperienceStore(agentDir);
        try { experienceGeneration = String(store.generation); } finally { store.close(); }
      }
      const previous = messageText(message).match(EXPERIENCE_MARKER)?.[1];
      stale = !previous || previous !== experienceGeneration;
    }
    if (!stale) return message;
    changed = true;
    return { ...message, content: [{ type: 'text', text: REVOKED_TOOL_NOTICE }], details: { revoked: true } };
  });
  return changed ? { ...context, systemPrompt, messages } : context;
}

/** For model runtimes that do not have a cache-prefix contract (bridge/isolated sessions). */
export function installMemoryContextGuard(session: any, agentDir: string) {
  installMemoryAppendGuard(session, agentDir);
  const agent = session?.agent;
  const slot = typeof agent?.streamFunction === 'function' ? 'streamFunction' : 'streamFn';
  if (!agentDir || !agent || typeof agent[slot] !== 'function' || agent.__memoryContextGuard) return;
  const original = agent[slot];
  agent.__memoryContextGuard = true;
  agent[slot] = (model: any, context: any, options: any) => original.call(agent, model, guardMemoryContext(context, agentDir), options);
}

/** Final synchronous gate for SDK append after asynchronous extension hooks finish. */
export function installMemoryAppendGuard(session: any, agentDir: string) {
  const manager = session?.sessionManager;
  if (agentDir && manager) manager.__memoryAgentDir = agentDir;
  if (!agentDir || !manager || typeof manager.appendCompaction !== 'function' || manager.__memoryAppendGuard) return;
  const original = manager.appendCompaction;
  manager.__memoryAppendGuard = true;
  manager.appendCompaction = function (summary: string, firstKeptEntryId: string, tokensBefore: number, details: any, ...rest: any[]) {
    const epoch = summaryEvidenceEpoch({ details }, summary);
    if (!epoch) throw new Error('Compaction has no evidence epoch; regenerate it through the guarded compaction path');
    assertMemoryEvidenceEpoch(agentDir, epoch);
    return original.call(this, summary, firstKeptEntryId, tokensBefore, details, ...rest);
  };
}
