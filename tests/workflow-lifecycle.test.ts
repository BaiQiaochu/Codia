import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowTool } from '../lib/tools/workflow-tool.ts';

const META = "export const meta = { name: 'lifecycle', description: 'offline cancellation check' };\n";
const DEADLINE_MS = 10 * 60 * 1000;
const ctx = { sessionManager: { getSessionFile: () => '/synthetic/parent.jsonl', getCwd: () => '/synthetic' } };

function createPendingExecutor() {
  const signals: AbortSignal[] = [];
  const cancelled = vi.fn();
  const executeIsolated = vi.fn((_prompt: string, options: { signal?: AbortSignal }) => {
    signals.push(options.signal);
    return new Promise<{ replyText: string; error: string }>(resolve => {
      options.signal?.addEventListener('abort', () => {
        cancelled();
        resolve({ replyText: '', error: 'node aborted' });
      }, { once: true });
    });
  });
  return { signals, cancelled, executeIsolated };
}

afterEach(() => { vi.useRealTimers(); });

describe('workflow execution lifetime', () => {
  it('aborts an active deferred node when the workflow deadline reports failure', async () => {
    vi.useFakeTimers();
    const executor = createPendingExecutor();
    const store = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
    const emitEvent = vi.fn();
    const tool = createWorkflowTool({ executeIsolated: executor.executeIsolated, getDeferredStore: () => store, emitEvent });
    const result = await tool.execute('call', { script: META + "return await agent('pending task');" }, undefined, undefined, ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(executor.executeIsolated).toHaveBeenCalledOnce();
    expect(executor.signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(store.fail).toHaveBeenCalledExactlyOnceWith((result.details as Extract<typeof result.details, { taskId: string }>).taskId, expect.stringContaining('timed out'));
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'block_update', patch: expect.objectContaining({ streamStatus: 'failed' }) }), '/synthetic/parent.jsonl');
    expect(executor.cancelled).toHaveBeenCalledOnce();
    expect(executor.signals[0].aborted).toBe(true);
    expect(store.resolve).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels still-running siblings when a workflow fails', async () => {
    vi.useFakeTimers();
    const pending = createPendingExecutor();
    const store = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
    const executeIsolated = vi.fn((prompt, options) => prompt === 'fails'
      ? Promise.resolve({ replyText: '', error: 'one node failed' })
      : pending.executeIsolated(prompt, options));
    const tool = createWorkflowTool({ executeIsolated, getDeferredStore: () => store });
    const result = await tool.execute('call', { script: META + "return await Promise.all([agent('pending'), agent('fails')]);" }, undefined, undefined, ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.fail).toHaveBeenCalledExactlyOnceWith((result.details as Extract<typeof result.details, { taskId: string }>).taskId, expect.stringContaining('one node failed'));
    expect(pending.cancelled).toHaveBeenCalledOnce();
    expect(store.resolve).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an active node when synchronous fallback reaches its deadline', async () => {
    vi.useFakeTimers();
    const executor = createPendingExecutor();
    const tool = createWorkflowTool({ executeIsolated: executor.executeIsolated });
    const completion = tool.execute('call', { script: META + "return await agent('pending task');" }, undefined, undefined, ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(executor.executeIsolated).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const result = await completion;
    expect(result.content[0].text).toContain('timed out');
    expect(executor.cancelled).toHaveBeenCalledOnce();
    expect(executor.signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not interrupt successful deferred work or leave an abort timer', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const store = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
    const executeIsolated = vi.fn(async (_prompt, options) => {
      expect(options.signal.aborted).toBe(false);
      options.signal.addEventListener('abort', cancelled);
      return { replyText: 'finished', error: null };
    });
    const tool = createWorkflowTool({ executeIsolated, getDeferredStore: () => store });
    const result = await tool.execute('call', { script: META + "return await agent('quick task');" }, undefined, undefined, ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.resolve).toHaveBeenCalledExactlyOnceWith((result.details as Extract<typeof result.details, { taskId: string }>).taskId, 'finished');
    expect(store.fail).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
