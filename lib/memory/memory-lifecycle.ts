/** Durable revocation journal. Contains hashes and IDs, never deleted fact text. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteSync } from '../../shared/safe-fs.ts';
import { clearCompiledMemoryArtifacts, clearCompiledSummarySources, writeCompiledResetMarker } from './compiled-memory-state.ts';

export function memoryContentHash(text: string) {
  return createHash('sha256').update(String(text || '').normalize('NFKC').trim().replace(/\s+/g, ' ')).digest('hex');
}

export function readMemoryLifecycle(memoryDir: string | null) {
  if (!memoryDir) return { generation: '0', tombstones: [], resetAt: null };
  try {
    const value = JSON.parse(fs.readFileSync(path.join(memoryDir, 'lifecycle.json'), 'utf8'));
    if (!Array.isArray(value.tombstones) || typeof value.generation !== 'string') throw new Error('Invalid memory lifecycle journal');
    return value;
  } catch (error: any) {
    if (error.code === 'ENOENT') return { generation: '0', tombstones: [], resetAt: null };
    // A damaged journal must never silently turn forgotten content back on.
    throw error;
  }
}

export function appendMemoryRevocation(memoryDir: string | null, event: any, previous: any) {
  const state = memoryDir ? readMemoryLifecycle(memoryDir) : previous;
  const now = new Date().toISOString();
  const next = {
    schemaVersion: 1,
    generation: randomUUID(),
    resetAt: now,
    tombstones: [...(state?.tombstones || []), { eventId: randomUUID(), at: now, ...event }],
  };
  if (memoryDir) {
    fs.mkdirSync(memoryDir, { recursive: true });
    // Persist the deny record before touching SQLite or derived files. On failure,
    // fail closed; reopening replays this record against an older DB backup.
    atomicWriteSync(path.join(memoryDir, 'lifecycle.json'), JSON.stringify(next, null, 2) + '\n');
    writeCompiledResetMarker(memoryDir, now);
    clearCompiledMemoryArtifacts(memoryDir);
    clearCompiledSummarySources(path.join(memoryDir, 'summaries'));
  }
  return next;
}

/** Exclude secrets from facts, tags, provenance and generated summaries. */
export function scrubMemorySecrets(text: string) {
  return String(text || '')
    .replace(/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+)?PRIVATE KEY-----|$)/g, '[REDACTED_SECRET]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED_SECRET]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/((?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|验证码|密码|口令|otp|(?:one[- ]time|verification)\s+code)\s*(?:is|是|为|[:=：])\s*)[^\s,，;；]+/gi, '$1[REDACTED_SECRET]');
}
