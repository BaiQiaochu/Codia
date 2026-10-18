import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteSync } from '../../shared/safe-fs.ts';
import { CAPABILITIES, QUALIFICATION_SUITE_VERSION } from './types.ts';
import type { QualificationReport } from './types.ts';

/** Private, bounded latest-per-model records. No prompts, answers, URLs or credentials. */
export class QualificationStore {
  private readonly directory: string | null;
  constructor(directory: string | null) { this.directory = directory; }
  private filename(model: { id: string; provider: string }) {
    if (!this.directory) throw new Error('qualification_storage_unavailable');
    const key = createHash('sha256').update(JSON.stringify([model.provider, model.id])).digest('hex');
    return path.join(this.directory, `${key}.json`);
  }
  read(model: { id: string; provider: string }): QualificationReport | null {
    try {
      const file = this.filename(model);
      if (fs.statSync(file).size > 64_000) return null;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.suiteVersion !== QUALIFICATION_SUITE_VERSION || value.model?.id !== model.id || value.model?.provider !== model.provider
          || !['configured-provider', 'test-injected'].includes(value.provenance) || !['running', 'completed', 'interrupted'].includes(value.status)
          || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.expiresAt)
          || !Array.isArray(value.results) || value.results.length !== CAPABILITIES.length
          || CAPABILITIES.some(cap => value.results.filter((result: any) => result.capability === cap).length !== 1)
          || value.results.some((result: any) => !['pass', 'fail', 'unsupported', 'blocked', 'not-run'].includes(result.status))) return null;
      return value;
    } catch { return null; }
  }
  write(report: QualificationReport) {
    const filename = this.filename(report.model);
    fs.mkdirSync(this.directory!, { recursive: true, mode: 0o700 });
    atomicWriteSync(filename, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
}
