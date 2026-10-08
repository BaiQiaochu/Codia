import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteSync } from '../shared/safe-fs.ts';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-atomic-write-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

async function waitForFile(filename: string) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(filename)) {
    if (Date.now() > deadline) throw new Error('local writer did not reach publication barrier');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function startWriter(target: string, payload: string, slot: string) {
  const staged = path.join(directory, `${slot}.staged`);
  const release = path.join(directory, `${slot}.release`);
  const payloadPath = path.join(directory, `${slot}.payload`);
  fs.writeFileSync(payloadPath, payload);
  const script = `
    import fs from 'node:fs';
    import { atomicWriteSync } from ${JSON.stringify(new URL('../shared/safe-fs.ts', import.meta.url).href)};
    const [target, payloadPath, staged, release] = process.argv.slice(1);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      fs.writeFileSync(staged, 'ready');
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(release)) {
        if (Date.now() > deadline) throw new Error('publication barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return rename(from, to);
    };
    atomicWriteSync(target, fs.readFileSync(payloadPath));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, target, payloadPath, staged, release], {
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<{code: number | null; stderr: string}>(resolve => {
    child.once('error', error => { stderr += String(error); });
    child.once('close', code => resolve({ code, stderr }));
  });
  return { child, staged, release, closed };
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill('SIGKILL'); });
}

describe('atomicWriteSync publication and cleanup', () => {
  it('keeps overlapping native writers isolated until each publishes its complete bytes', async () => {
    const target = path.join(directory, 'state.json');
    const firstPayload = JSON.stringify({ writer: 1, text: 'a'.repeat(65536) });
    const secondPayload = JSON.stringify({ writer: 2, text: 'b'.repeat(65536) });
    const first = startWriter(target, firstPayload, 'first');
    let second: ReturnType<typeof startWriter> | undefined;
    try {
      await waitForFile(first.staged);
      second = startWriter(target, secondPayload, 'second');
      await waitForFile(second.staged);
      fs.writeFileSync(first.release, 'go');
      expect(await first.closed).toEqual({ code: 0, stderr: '' });
      expect(fs.readFileSync(target, 'utf8')).toBe(firstPayload);
      fs.writeFileSync(second.release, 'go');
      expect(await second.closed).toEqual({ code: 0, stderr: '' });
      expect(fs.readFileSync(target, 'utf8')).toBe(secondPayload);
      expect(fs.readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await stopChild(first.child);
      if (second) await stopChild(second.child);
    }
  });

  it('does not overwrite or remove another writer’s existing legacy staging file', () => {
    const target = path.join(directory, 'state.json');
    fs.writeFileSync(`${target}.tmp`, 'unrelated staged bytes');
    atomicWriteSync(target, 'saved');
    expect(fs.readFileSync(target, 'utf8')).toBe('saved');
    expect(fs.readFileSync(`${target}.tmp`, 'utf8')).toBe('unrelated staged bytes');
  });

  it('preserves the previous target and removes its own staging file when publication fails', () => {
    const target = path.join(directory, 'state.json');
    fs.writeFileSync(target, 'previous');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('synthetic rename failure'); });
    expect(() => atomicWriteSync(target, 'replacement')).toThrow('synthetic rename failure');
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
    expect(fs.readdirSync(directory)).toEqual(['state.json']);
  });

  it('cleans partial staging bytes after a write failure without removing the target', () => {
    const target = path.join(directory, 'state.json');
    fs.writeFileSync(target, 'previous');
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((filename, _content, options) => {
      write(filename, 'partial', options);
      throw new Error('synthetic write failure');
    });
    expect(() => atomicWriteSync(target, 'replacement')).toThrow('synthetic write failure');
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
    expect(fs.readdirSync(directory)).toEqual(['state.json']);
  });

  it('keeps default creation permissions subject to the process umask', () => {
    const target = path.join(directory, 'default.json');
    atomicWriteSync(target, 'default permissions');
    expect(fs.readFileSync(target, 'utf8')).toBe('default permissions');
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it('reports a missing parent without creating partial files elsewhere', () => {
    expect(() => atomicWriteSync(path.join(directory, 'missing', 'state.json'), 'value')).toThrow();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('retains Buffer and explicit file-mode support', () => {
    const target = path.join(directory, 'private.json');
    const content = Buffer.from([0, 1, 127, 255]);
    atomicWriteSync(target, content, { mode: 0o600 });
    expect(fs.readFileSync(target)).toEqual(content);
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(['private.json']);
  });
});
