import fs from 'node:fs/promises';
import { once } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodiaDocumentAgentExecutor } from '../lib/cloud-workspace/agent-executor.ts';

const captured = vi.hoisted(() => ({
  children: [] as { child: ChildProcess; cwd: string }[],
  onSpawn: null as ((child: ChildProcess) => void) | null,
  program: 'setInterval(() => {}, 1000)',
  spawnFailure: false,
}));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(command: string, _args: string[], options: SpawnOptions) {
      // The process-lifetime probe replaces only the child program with a local
      // fixture that keeps its event loop alive without models or network.
      const child = actual.spawn(captured.spawnFailure ? `${command}.missing-codia-fixture` : command, ['-e', captured.program], options);
      captured.children.push({ child, cwd: String(options.cwd) });
      captured.onSpawn?.(child);
      return child;
    },
  };
});
afterEach(async () => {
  captured.onSpawn = null;
  captured.program = 'setInterval(() => {}, 1000)';
  captured.spawnFailure = false;
  for (const { child } of captured.children) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  }
  captured.children = [];
});
const run = { id: 'agent-cancel', name: 'input.txt', input_version: 'version', operation: 'agent-summary', owner_user: 'fixture', studio_id: 'fixture' };
const executor = (timeoutMs = 5000) => new CodiaDocumentAgentExecutor({ resolve: async () => ({ model: {}, apiKey: 'synthetic-unused' }) }, { timeoutMs });

describe('Cloud Agent child cancellation lifetime', () => {
  it.each(['abort', 'timeout', 'output-limit'] as const)('waits for process close after %s before settling or deleting its directory', async reason => {
    const controller = new AbortController();
    if (reason === 'output-limit') captured.program = 'process.stdout.write(Buffer.alloc(1024 * 1024 + 1)); setInterval(() => {}, 1000)';
    let killRequested!: () => void, releaseKill!: () => void;
    const requested = new Promise<void>(resolve => { killRequested = resolve; });
    let closed = false, settled = false, killRequests = 0;
    captured.onSpawn = child => {
      // Hold actual termination to exercise the documented asynchronous kill
      // contract. Only a real local Node child is used; no model request is sent.
      const kill = child.kill.bind(child);
      child.kill = (() => { killRequests++; killRequested(); return true; }) as ChildProcess['kill'];
      releaseKill = () => { child.kill = kill; kill('SIGKILL'); };
      child.on('close', () => { closed = true; });
      if (reason === 'abort') child.once('spawn', () => controller.abort());
    };
    const pending = executor(reason === 'timeout' ? 15 : 5000).execute(run, Buffer.from('synthetic'), controller.signal)
      .then(value => ({ value, error: null }), error => ({ value: null, error }))
      .finally(() => { settled = true; });
    try {
      await requested;
      controller.abort(); // A later cancellation must not replace the first stop reason.
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(closed).toBe(false);
      expect(killRequests).toBe(1);
      expect(settled, 'kill is a request, not process termination').toBe(false);
      expect((await fs.stat(captured.children[0].cwd)).isDirectory()).toBe(true);
    } finally { releaseKill(); await pending; }
    const result = await pending;
    expect(result.error).toMatchObject({ message: reason === 'abort' ? 'executor_aborted' : reason === 'timeout' ? 'executor_timeout' : 'executor_output_limit' });
    expect(closed).toBe(true);
    await expect(fs.stat(captured.children[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    controller.abort();
  });
  it('reports spawn failure only after close and removes its temporary directory', async () => {
    captured.spawnFailure = true; let closed = false;
    captured.onSpawn = child => { child.on('close', () => { closed = true; }); };
    await expect(executor().execute(run, Buffer.from('synthetic'), new AbortController().signal)).rejects.toThrow('executor_runtime_unavailable');
    expect(closed).toBe(true);
    await expect(fs.stat(captured.children[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not spawn a child when already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(executor().execute(run, Buffer.from('synthetic'), controller.signal)).rejects.toThrow('executor_aborted');
    expect(captured.children).toHaveLength(0);
  });
});
