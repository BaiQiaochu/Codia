import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.ts';
import { errorBus } from './error-bus.ts';

type AnyRecord = Record<string, any>;

export function safeReadFile(filePath: string, fallback: string | null = '') {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
 //
    if (err.code !== 'ENOENT') {
      const code = err.code === 'EACCES' ? 'FS_PERMISSION' : 'UNKNOWN';
      errorBus.report(new AppError(code, { cause: err, context: { filePath } }));
    }
    return fallback;
  }
}

export function safeReadJSON(filePath: string, fallback: unknown = null) {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

export async function safeReadYAML(filePath: string, fallback: unknown = null) {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    const yaml = await import('js-yaml');
    return yaml.default?.load?.(text) ?? yaml.load(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

export function safeReadYAMLSync(filePath: string, fallback: unknown = null, yaml: AnyRecord) {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    return yaml.load(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

/**
 * Atomic file write: write to tmp, then rename over target.
 * Prevents partial writes if the process crashes mid-write.
 */
export function atomicWriteSync(filePath: string, content: string | NodeJS.ArrayBufferView, { mode }: { mode?: number } = {}) {
  // Independent processes can save the same target concurrently. Each writer
  // must own its staging file; the final same-directory rename remains atomic.
  const tmp = path.join(path.dirname(filePath), `.gsap-write-${randomUUID()}.tmp`);
  let descriptor: number | null = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, content, 'utf-8');
    if (mode !== undefined) {
      try { fs.fchmodSync(descriptor, mode); } catch { /* best effort */ }
    }
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tmp, filePath);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* retain the original failure */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* renamed, or best effort on failure */ }
  }
}

/**
 * Atomic directory copy with rollback.
 * 1. Copy src -> dst.tmp_{ts}
 * 2. If dst exists, rename dst -> dst.bak_{ts}
 * 3. Rename dst.tmp_{ts} -> dst
 * 4. Delete dst.bak_{ts}
 * Recovery: if step 3 fails, rename dst.bak_{ts} back to dst, clean up tmp.
 */
export function safeCopyDir(src: string, dst: string) {
  const ts = Date.now();
  const tmpDst = `${dst}.tmp_${ts}`;
  const bakDst = `${dst}.bak_${ts}`;

  try {
    _copyDirRecursive(src, tmpDst);

    let hadExisting = false;
    if (fs.existsSync(dst)) {
      fs.renameSync(dst, bakDst);
      hadExisting = true;
    }

    try {
      fs.renameSync(tmpDst, dst);
    } catch (renameErr) {
      if (hadExisting) {
        try { fs.renameSync(bakDst, dst); } catch { /* best effort rollback */ }
      }
      _cleanupDir(tmpDst);
      throw renameErr;
    }

    if (hadExisting) _cleanupDir(bakDst);
  } catch (err) {
    _cleanupDir(tmpDst);
    throw new AppError('FS_COPY_FAILED', { cause: err, context: { src, dst } });
  }
}

function _copyDirRecursive(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      _copyDirRecursive(s, d);
    } else {
      if (fs.existsSync(d)) {
        try { fs.chmodSync(d, 0o644); } catch { /* Windows NTFS */ }
      }
      fs.copyFileSync(s, d);
    }
  }
}

function _cleanupDir(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
