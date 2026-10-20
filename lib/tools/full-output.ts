import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 2 * 1024 * 1024;
export function boundedToolOutput() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let originalBytes = 0;
  return {
    append(text: string) {
      const chunk = Buffer.from(text + '\n');
      originalBytes += chunk.length;
      if (bytes >= MAX_BYTES) return;
      const kept = chunk.subarray(0, MAX_BYTES - bytes);
      chunks.push(kept); bytes += kept.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    originalBytes: () => originalBytes,
  };
}
/** A bounded, readable result artifact; never implies that an upstream query was exhaustive. */
export function saveToolOutput(text: string, sessionPath?: string | null, register?: (entry: any) => unknown, sourceBytes?: number) {
  const directory = sessionPath ? path.join(path.dirname(sessionPath), 'tool-results') : path.join(os.tmpdir(), 'codia-tool-results');
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(text);
  const filePath = path.join(directory, `${randomUUID()}.txt`);
  fs.writeFileSync(filePath, bytes.subarray(0, MAX_BYTES), { flag: 'wx', mode: 0o600 });
  const resource = sessionPath && register ? register({ sessionPath, filePath, label: path.basename(filePath),
    origin: 'tool_output', operation: 'created', storageKind: 'managed_cache' }) : null;
  return { fullOutputPath: filePath, storedBytes: Math.min(bytes.length, MAX_BYTES),
    originalBytes: sourceBytes ?? bytes.length, fullOutputTruncated: (sourceBytes ?? bytes.length) > MAX_BYTES, sessionFile: resource };
}
