import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import type { ResourceVersion } from './types.ts';

// Per invocation: parallel edits cannot replace one another's read versions.
const edits = new AsyncLocalStorage<Map<string, ResourceVersion>>();
export function withToolEditContext<T>(operation: () => T): T { return edits.run(new Map(), operation); }
export function rememberEditVersion(path: string, version: ResourceVersion | undefined) {
  if (version) edits.getStore()?.set(path, version);
}
export function readEditVersion(path: string) { return edits.getStore()?.get(path); }

const writes = new Map<string, Promise<unknown>>();
const heldPaths = new AsyncLocalStorage<Set<string>>();
/** Serialize our writes, including the checkpoint, without hiding external changes. */
export async function withFileMutation<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const resolved = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (heldPaths.getStore()?.has(key)) return operation();
  const previous = writes.get(key);
  const run = (previous || Promise.resolve()).catch(() => {}).then(() =>
    heldPaths.run(new Set([...(heldPaths.getStore() || []), key]), operation));
  writes.set(key, run);
  try { return await run; }
  finally { if (writes.get(key) === run) writes.delete(key); }
}
