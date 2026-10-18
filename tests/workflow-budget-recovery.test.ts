// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowTool } from '../lib/tools/workflow-tool.ts';
import { WorkflowJournal } from '../lib/workflow/journal.ts';
import { createWorkflowRecoveryRoute } from '../server/routes/workflow-recovery.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const script = "export const meta = { name: 'bounded recovery', description: 'regression' }; await agent('first', { access: 'read' }); return await agent('second', { access: 'read' });";
const ctx = { sessionManager: { getSessionFile: () => '/session', getCwd: () => '/workspace' } };
const blocked = /Cumulative workflow budget accounting cannot be safely restored/;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-budget-recovery-'));
  dirs.push(dir);
  const journalDir = path.join(dir, 'workflow-journals');
  const store = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
  const entries: any[] = [];
  const ledger = { list: vi.fn(() => ({ entries })) };
  const executeIsolated = vi.fn(async (_prompt, options) => {
    entries.push({ attribution: { subagentTaskId: options.subagentTaskId }, usage: { totalTokens: 100 } });
    return { replyText: 'done' };
  });
  const deps = { executeIsolated, getDeferredStore: () => store, getJournalDir: () => journalDir, getUsageLedger: () => ledger };
  const tool = createWorkflowTool(deps);
  const journalFile = runId => path.join(journalDir, `${runId}.jsonl`);
  const route = createWorkflowRecoveryRoute({ listAgents: () => [{ id: 'agent' }], getAgent: () => ({ agentDir: dir }) });
  return { tool, deps, entries, executeIsolated, store, journalFile, route };
}

describe('workflow cumulative budget recovery safety', () => {
  it.each([
    ['token limit', { budgetTokens: 100 }, /token budget exhausted/],
    ['step limit', { maxSteps: 1 }, /step budget exhausted/],
  ])('refuses to reset an exhausted %s before a second node or recovery claim', async (_label, args, error) => {
    const f = fixture();
    const first = await f.tool.execute('first', { script, args }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(f.store.fail).toHaveBeenCalled());
    expect(String(f.store.fail.mock.calls[0][1])).toMatch(error);
    expect(f.executeIsolated).toHaveBeenCalledTimes(1);
    expect(f.entries.reduce((sum, entry) => sum + entry.usage.totalTokens, 0)).toBe(100);

    const resumed = await f.tool.execute('resume', { script, args, resumeFromRunId: first.details.taskId }, undefined, undefined, ctx);
    expect(resumed.details.error).toMatch(blocked);
    expect(f.executeIsolated).toHaveBeenCalledTimes(1);
    expect(f.store.defer).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${f.journalFile(first.details.taskId)}.resume`)).toBe(false);
  });

  it('refuses recovery after restart even when the usage ledger is missing', async () => {
    const f = fixture();
    const args = { budgetTokens: 100 };
    const first = await f.tool.execute('first', { script, args }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(f.store.fail).toHaveBeenCalled());
    const restarted = createWorkflowTool({ ...f.deps, getUsageLedger: () => undefined });
    const resumed = await restarted.execute('resume', { script, args, resumeFromRunId: first.details.taskId }, undefined, undefined, ctx);
    expect(resumed.details.error).toMatch(blocked);
    expect(f.executeIsolated).toHaveBeenCalledTimes(1);
    expect(f.store.defer).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${f.journalFile(first.details.taskId)}.resume`)).toBe(false);
  });

  it.each([undefined, {}, { budgetTokens: null }, { budgetTokens: 1000 }])('cannot strip or increase a saved budget with changed arguments %j', async args => {
    const f = fixture();
    const first = await f.tool.execute('first', { script, args: { budgetTokens: 100 } }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(f.store.fail).toHaveBeenCalled());
    const resumed = await f.tool.execute('resume', { script, args, resumeFromRunId: first.details.taskId }, undefined, undefined, ctx);
    expect(resumed.details.error).toMatch(/changed|Cumulative workflow budget/);
    expect(f.executeIsolated).toHaveBeenCalledTimes(1);
    expect(f.store.defer).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${f.journalFile(first.details.taskId)}.resume`)).toBe(false);
  });

  it.each([{ budgetTokens: 1000 }, { maxSteps: 10 }, { maxDurationMs: 10000 }])('uses the same blocker for direct execution, inspection, and recovery draft: %j', async args => {
    const f = fixture();
    const first = await f.tool.execute('first', { script, args }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(f.store.resolve).toHaveBeenCalled());
    const journal = WorkflowJournal.load(f.journalFile(first.details.taskId));
    const inspection = journal.inspectRecovery();
    expect(inspection).toMatchObject({ canPrepare: false, blockedReason: expect.stringMatching(blocked) });
    // Even a valid, apparently unused allowance cannot be restored from these
    // journals: completed checkpoints are not a cumulative usage ledger.
    const resumed = await f.tool.execute('resume', { script, args, resumeFromRunId: first.details.taskId }, undefined, undefined, ctx);
    expect(resumed.details.error).toContain(inspection.blockedReason);
    const response = await f.route.request(`/workflow-recovery/${first.details.taskId}`);
    expect(await response.json()).toMatchObject({ canPrepare: false, blockedReason: inspection.blockedReason });
    const draft = await f.route.request(`/workflow-recovery/${first.details.taskId}/draft`, { method: 'POST' });
    expect(draft.status).toBe(409);
    expect(await draft.json()).toMatchObject({ error: inspection.blockedReason });
    expect(f.executeIsolated).toHaveBeenCalledTimes(2);
    expect(f.store.defer).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${f.journalFile(first.details.taskId)}.resume`)).toBe(false);
  });

  it('also refuses trusted RunBudget contracts when called outside the recovery UI', () => {
    const journal = new WorkflowJournal(null);
    journal.setMetadata({ definitionKey: 'same', definition: { script }, budgetContract: { limits: { maxTokens: 100 } } });
    journal.finish();
    expect(() => journal.assertRecoveryBudgetSupported()).toThrow(/new reviewed budget/);
    expect(journal.inspectRecovery().canPrepare).toBe(false);
  });

  it('preserves ordinary checkpoint replay with no explicit budget', async () => {
    const f = fixture();
    const first = await f.tool.execute('first', { script }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(f.store.resolve).toHaveBeenCalledTimes(1));
    expect(WorkflowJournal.load(f.journalFile(first.details.taskId)).inspectRecovery().canPrepare).toBe(true);
    const resumed = await f.tool.execute('resume', { script, resumeFromRunId: first.details.taskId }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(f.store.resolve).toHaveBeenCalledWith(resumed.details.taskId, 'done'));
    expect(f.executeIsolated).toHaveBeenCalledTimes(2);
    expect(f.store.defer).toHaveBeenCalledTimes(2);
  });
});
