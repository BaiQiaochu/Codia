import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { CloudWorkspaceService } from '../lib/cloud-workspace/service.ts';
import { CloudWorkspaceWorker, executeDocumentTransform } from '../lib/cloud-workspace/worker.ts';
import { CLOUD_AGENT_INPUT_LIMIT, CLOUD_DOCUMENT_INPUT_LIMIT } from '../lib/cloud-workspace/input-limits.ts';

const captured = vi.hoisted(() => ({
  children: [] as { child: ChildProcess; cwd: string }[],
  onSpawn: null as ((child: ChildProcess) => void) | null,
}));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(command: string, args: string[], options: SpawnOptions) {
      const child = actual.spawn(command, args, options);
      captured.children.push({ child, cwd: String(options.cwd) });
      captured.onSpawn?.(child);
      return child;
    },
  };
});

afterEach(async () => {
  captured.onSpawn = null;
  for (const { child } of captured.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  captured.children = [];
});

describe('Cloud document executor cancellation and processing boundaries', () => {
  const run = { id: 'run-test', name: 'bounded.txt', input_version: 'pinned-version' };

  it('still processes the complete legacy 2 MiB boundary in its fixed child', async () => {
    const output = await executeDocumentTransform(run, Buffer.alloc(CLOUD_DOCUMENT_INPUT_LIMIT, 'a'));
    expect(output.toString()).toContain(`字节数：${CLOUD_DOCUMENT_INPUT_LIMIT}`);
    expect(output.toString()).toContain('pinned-version');
    expect(output.length).toBeLessThan(4096);
    expect(captured.children).toHaveLength(1);
    await expect(fs.stat(captured.children[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects oversized or pre-aborted work before starting a child', async () => {
    await expect(executeDocumentTransform(run, Buffer.alloc(CLOUD_DOCUMENT_INPUT_LIMIT + 1)))
      .rejects.toThrow('document_input_too_large');
    const controller = new AbortController();
    controller.abort();
    await expect(executeDocumentTransform(run, Buffer.from('text'), controller.signal))
      .rejects.toThrow('executor_aborted');
    expect(captured.children).toHaveLength(0);
  });

  it('kills the running child and waits for close before removing its directory', async () => {
    const controller = new AbortController();
    let closed = false;
    captured.onSpawn = child => {
      child.on('close', () => { closed = true; });
      child.once('spawn', () => controller.abort());
    };
    await expect(executeDocumentTransform(run, Buffer.alloc(CLOUD_DOCUMENT_INPUT_LIMIT, 'a'), controller.signal))
      .rejects.toThrow('executor_aborted');
    expect(closed).toBe(true);
    expect(captured.children).toHaveLength(1);
    expect(captured.children[0].child.signalCode).toBe('SIGKILL');
    await expect(fs.stat(captured.children[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    controller.abort(); // Repeated cancellation cannot settle or clean up twice.
  });

  it.each([
    ['document-summary', CLOUD_DOCUMENT_INPUT_LIMIT, 'document_input_too_large'],
    ['agent-summary', CLOUD_AGENT_INPUT_LIMIT, 'agent_input_too_large'],
    ['agent-conversation', CLOUD_AGENT_INPUT_LIMIT, 'agent_input_too_large'],
  ] as const)('fences old oversized %s jobs before downloading their stored bytes', async (operation, limit, error) => {
    const pending = { ...run, operation, size: limit + 1, object_key: 'must-not-read' };
    const get = vi.fn();
    const fail = vi.fn();
    const repository = {
      kind: 'recovery-test',
      reconcileStaging: vi.fn(), dispatchDueSchedules: vi.fn(), publishOutbox: vi.fn(),
      claim: vi.fn().mockResolvedValue(pending), fail,
    };
    const service = new CloudWorkspaceService(repository as any, { kind: 'test', get, putImmutable: vi.fn() });
    const worker = new CloudWorkspaceWorker(service);
    await expect(worker.tick()).resolves.toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(pending, error);
    await worker.stop();
  });
});
