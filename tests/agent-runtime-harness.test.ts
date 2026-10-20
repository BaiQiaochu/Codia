import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimeFixture } from '../evals/agent-runtime-fixture.ts';
import { loadSessionHistoryMessages } from '../core/message-utils.ts';
import { runAgentSession } from '../hub/agent-executor.ts';

describe('real SDK with deterministic local provider', () => {
  it('uses the shared task allowance across the real Hub multi-round entrypoint', async () => {
    const f = await createRuntimeFixture(['First round.', 'Must not request.'], { modelCalls: 1, toolCalls: 10, activeMs: 60000 });
    const options = f.sessionOptions;
    const agent = { id: 'fixture', agentDir: path.join(f.root, 'agent'), config: {}, tools: [], systemPrompt: 'Complete the test task.' };
    const engine = {
      getAgent: () => agent, getHomeCwd: () => f.workspace,
      createSessionContext: () => ({
        resourceLoader: options.resourceLoader, modelRuntime: options.modelRuntime,
        getSkillsForAgent: () => ({ skills: [], diagnostics: [] }), resolveModel: () => options.model,
        buildTools: () => ({ tools: options.tools, customTools: options.customTools }),
      }),
    };
    f.control.begin();
    const release = f.control.enter();
    try {
      await expect(f.control.run(() => runAgentSession('fixture',
        [{ text: 'First round', capture: true }, { text: 'Continue', capture: true }],
        { engine, keepSession: true }))).rejects.toThrow('run_paused');
      release();
      expect(f.requests).toHaveLength(1);
      expect(f.control.snapshot()).toMatchObject({ status: 'paused', used: { modelCalls: 1 }, grants: 1 });
    } finally { release(); await f.close(); }
  }, 30000);
  it('shares the parent allowance across a second SDK session', async () => {
    const parent = await createRuntimeFixture(['Parent progress.'], { modelCalls: 1, toolCalls: 10, activeMs: 60000 });
    const child = await createRuntimeFixture(['Must not request.'], undefined, undefined, undefined, parent.control);
    try {
      await parent.session.prompt('Start a task.');
      const runId = parent.control.snapshot()!.runId;
      await parent.control.run(() => child.session.prompt('Continue as a child.'));
      expect(child.requests).toHaveLength(0);
      expect(parent.control.snapshot()).toMatchObject({ runId, status: 'paused', used: { modelCalls: 1 } });
    } finally { await child.close(); await parent.close(); }
  }, 30000);
  it('executes production read/edit/write tools and records complete stable settlement', async () => {
    const f = await createRuntimeFixture([
      [{ name: 'write', arguments: { path: '中文 文件.txt', content: 'first' } }],
      [{ name: 'read', arguments: { path: '中文 文件.txt' } }],
      [{ name: 'edit', arguments: { path: '中文 文件.txt', edits: [{ oldText: 'first', newText: 'second' }] } }],
      'Complete.',
    ]);
    try {
      await f.session.prompt('Perform the scripted task.');
      expect(fs.readFileSync(path.join(f.workspace, '中文 文件.txt'), 'utf8')).toBe('second');
      expect(f.requests).toHaveLength(4);
      expect(f.control.snapshot()).toMatchObject({ status: 'completed', used: { modelCalls: 4, toolCalls: 3 }, pendingTools: [] });
      expect(f.events.filter(event => event.type === 'tool_execution_end')).toHaveLength(3);
      const history = await loadSessionHistoryMessages(null, f.sessionPath);
      expect(history.filter(message => message.role === 'assistant').every(message => message.runId === f.control.snapshot()?.runId)).toBe(true);
    } finally { await f.close(); }
  }, 30000);
  it('enforces the shared tool limit inside Codemode before nested writes', async () => {
    const f = await createRuntimeFixture([
      [{ name: 'codemode', arguments: { code: 'text(await tools.write({path:"first.txt",content:"once"})); text(await tools.write({path:"second.txt",content:"blocked"}));' } }],
      'Must not start.',
    ], { modelCalls: 10, toolCalls: 2, activeMs: 60000 });
    try {
      await f.session.prompt('Respect the nested tool allowance.');
      expect(fs.readFileSync(path.join(f.workspace, 'first.txt'), 'utf8')).toBe('once');
      expect(fs.existsSync(path.join(f.workspace, 'second.txt'))).toBe(false);
      expect(f.requests).toHaveLength(1);
      expect(f.control.snapshot()?.used.toolCalls).toBe(2);
      expect(['paused', 'needs_attention']).toContain(f.control.snapshot()?.status);
    } finally { await f.close(); }
  }, 30000);
  it('pauses at the provider boundary and resumes the same run once', async () => {
    const f = await createRuntimeFixture([
      [{ name: 'write', arguments: { path: 'a.txt', content: 'once' } }],
      'Finished after explicit continuation.',
    ], { modelCalls: 1, toolCalls: 10, activeMs: 60000 });
    try {
      await f.session.prompt('Run until paused.');
      const paused = f.control.snapshot()!;
      expect(paused.status).toBe('paused');
      expect(f.requests).toHaveLength(1);
      f.control.resume(paused.runId, paused.revision);
      await f.session.prompt('Continue from recorded results.');
      expect(f.control.snapshot()).toMatchObject({ runId: paused.runId, used: { modelCalls: 2, toolCalls: 1 }, grants: 2 });
      expect(f.events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'write')).toHaveLength(1);
    } finally { await f.close(); }
  }, 30000);
});
