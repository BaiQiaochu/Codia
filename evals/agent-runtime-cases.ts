import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeFixture } from './agent-runtime-fixture.ts';
import { McpStdioClient } from '../plugins/mcp/lib/mcp-stdio-client.ts';
import { createMcpToolDefinition } from '../plugins/mcp/lib/mcp-runtime.ts';
import { RunController } from '../lib/execution/run-controller.ts';
import { createBrowserTool } from '../lib/tools/browser-tool.ts';
import { createIsolatedBrowser } from './agent-runtime-browser.ts';
import { resolveWin32SandboxHelper } from '../lib/sandbox/win32-sandbox-helper.ts';

type Fixture = Awaited<ReturnType<typeof createRuntimeFixture>>;
const call = (name: string, args: object) => ({ name, arguments: args });
function textResults(f: Fixture) {
  return f.events.filter(e => e.type === 'tool_execution_end').map(e => JSON.stringify(e.result)).join('\n');
}
export async function runRuntimeCases() {
  const rows: any[] = [];
  const run = async (id: string, setup: () => Promise<Fixture>, verify: (f: Fixture) => Promise<void>) => {
    let fixture: Fixture | undefined;
    const startedAt = Date.now();
    try {
      fixture = await setup(); await verify(fixture);
      rows.push({ id, status: 'passed', durationMs: Date.now() - startedAt,
        usage: fixture.control.snapshot()?.used,
        trace: fixture.events.filter(e => /^tool_execution_/.test(e.type)).map(e => ({
          type: e.type, id: e.toolCallId, parentId: e.parentToolCallId, tool: e.toolName, isError: e.isError, durationMs: e.durationMs,
        })) });
    } catch (error) {
      rows.push({ id, status: 'failed', error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt });
    } finally { await fixture?.close(); }
  };
  await run('multi-file-check-fail-repair', () => createRuntimeFixture([
    [call('write', { path: 'a.txt', content: 'wrong' }), call('write', { path: 'check.cjs', content: "const fs=require('fs');if(fs.readFileSync('a.txt','utf8')!=='right')process.exit(2);console.log('CHECK_OK')" })],
    [call('read', { path: 'check.cjs' }), call('grep', { pattern: 'wrong', path: '.' }), call('bash', { command: 'node check.cjs' })],
    [call('edit', { path: 'a.txt', edits: [{ oldText: 'wrong', newText: 'right' }] })],
    [call('bash', { command: 'node check.cjs' })], 'Complete.',
  ]), async f => {
    await f.session.prompt('Inspect, edit and verify the local project.');
    assert.equal(fs.readFileSync(path.join(f.workspace, 'a.txt'), 'utf8'), 'right');
    assert.match(textResults(f), /code 2|exit.*2/i); assert.match(textResults(f), /CHECK_OK/);
    assert.equal(f.control.snapshot()?.status, 'completed');
    assert.ok(fs.readdirSync(path.join(f.root, 'checkpoints')).length);
  });
  await run('parallel-codemode-and-plugin', () => createRuntimeFixture([
    [call('write', { path: 'a.txt', content: 'a' }), call('write', { path: 'b.txt', content: 'b' })],
    [call('codemode', { code: 'text(await Promise.all([tools.read({path:"a.txt"}), tools.read({path:"b.txt"})])); text(await tools.fixture_plugin({}));' })], 'Complete.',
  ], undefined, () => [{
    name: 'fixture_plugin', label: 'Fixture plugin', description: 'Explicitly enabled local plugin fixture',
    _pluginId: 'runtime-fixture', parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'PLUGIN_OK' }] }),
  }]), async f => {
    await f.session.prompt('Use the available tools in parallel.');
    assert.match(textResults(f), /PLUGIN_OK/);
    const reads = f.events.filter(e => e.type === 'tool_execution_end' && e.toolName === 'read');
    assert.equal(reads.length, 2); assert.notEqual(reads[0].toolCallId, reads[1].toolCallId);
    assert.ok(reads.every(e => e.parentToolCallId));
    assert.equal(f.control.snapshot()?.used.toolCalls, 6);
  });
  let client: McpStdioClient | undefined;
  await run('mcp-local-transport', async () => {
    client = new McpStdioClient({ id: 'fixture', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/runtime-mcp.mjs', import.meta.url))], resolveWindowsShims: false });
    await client.start();
    const tool = createMcpToolDefinition({ connectorId: 'fixture', toolName: 'echo', description: 'Local fixture MCP',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      getGlobalEnabled: () => true, getAgentConfig: () => ({ mcp: { connectors: { fixture: { enabled: true, tools: { echo: true } } } } }),
      callTool: (_id, name, args) => client!.callTool(name, args) });
    return createRuntimeFixture([[call(tool.name, { text: 'MCP_OK' })], 'Complete.'], undefined, () => [{
      ...tool, execute: (id, args, _signal, _update, ctx) => tool.execute(id, args, ctx),
    }]);
  }, async f => { await f.session.prompt('Call the local MCP fixture.'); assert.match(textResults(f), /MCP_OK/); });
  await client?.stop();
  await run('permission-denial-and-revocation', () => createRuntimeFixture([
    [call('write', { path: 'denied.txt', content: 'must not exist' })], 'Done.',
    [call('write', { path: 'allowed.txt', content: 'allowed' })],
    [call('write', { path: 'revoked.txt', content: 'must not exist' })], 'Done.',
  ]), async f => {
    f.setPermission('read_only'); await f.session.prompt('Try a denied operation.');
    assert.equal(fs.existsSync(path.join(f.workspace, 'denied.txt')), false);
    assert.match(textResults(f), /ACTION_BLOCKED_BY_READ_ONLY/);
    f.setPermission('operate');
    const unsub = f.session.subscribe(e => { if (e.type === 'tool_execution_end' && e.toolName === 'write') f.setPermission('read_only'); });
    await f.session.prompt('Respect permission changes.');
    unsub();
    assert.equal(fs.readFileSync(path.join(f.workspace, 'allowed.txt'), 'utf8'), 'allowed');
    assert.equal(fs.existsSync(path.join(f.workspace, 'revoked.txt')), false);
  });
  await run('pause-resume-replay-and-late-result', () => createRuntimeFixture([
    [call('write', { path: 'once.txt', content: 'once' })], 'Done.',
  ], { modelCalls: 1, toolCalls: 10, activeMs: 60000 }), async f => {
    await f.session.prompt('Work until the allowance is reached.');
    const paused = f.control.snapshot()!; assert.equal(paused.status, 'paused');
    f.deferred.defer('late', f.sessionPath, { type: 'background-task' });
    const callsBeforeResult = f.requests.length;
    f.deferred.resolve('late', 'LATE_RESULT');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.requests.length, callsBeforeResult);
    assert.equal(f.deferred.query('late').delivered, false);
    assert.equal(f.control.canContinueAutomatically(), false);
    const current = f.control.snapshot()!;
    f.control.resume(current.runId, current.revision);
    assert.throws(() => f.control.resume(current.runId, current.revision), /conflict/);
    await f.session.prompt('Continue from the completed write.');
    assert.equal(f.control.snapshot()?.runId, paused.runId);
    assert.equal(f.events.filter(e => e.type === 'tool_execution_end' && e.toolName === 'write').length, 1);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'once.txt'), 'utf8'), 'once');
  });
  await run('cancel-running-command', () => createRuntimeFixture([
    [call('bash', { command: 'node -e "setTimeout(()=>console.log(123),30000)"' })], 'Must not request.',
  ]), async f => {
    const unsub = f.session.subscribe(e => {
      if (e.type === 'tool_execution_start') setTimeout(() => f.control.cancel(), 100);
    });
    await f.session.prompt('Run a cancellable command.'); unsub();
    assert.equal(f.requests.length, 1);
    assert.equal(f.control.snapshot()?.status === 'cancelled' || f.control.snapshot()?.status === 'needs_attention', true);
  });
  await run('restart-retains-budget-and-unknown-write', () => createRuntimeFixture([]), async f => {
    f.control.begin(); f.control.admitModel(); f.control.admitTool('unresolved', 'write', true);
    const restored = new RunController({ file: `${f.sessionPath}.run.json` });
    assert.equal(restored.snapshot()?.status, 'needs_attention');
    assert.equal(restored.snapshot()?.used.modelCalls, 1);
    assert.throws(() => restored.resume(restored.snapshot()!.runId, restored.snapshot()!.revision), /not_resumable/);
  });
  await run('cold-session-resume-without-repeated-write', () => createRuntimeFixture([
    [call('write', { path: 'restart.txt', content: 'retained' })], 'Continue complete.',
  ], { modelCalls: 1, toolCalls: 10, activeMs: 60000 }), async f => {
    await f.session.prompt('Write once, then pause.');
    const id = f.control.snapshot()!.runId;
    await f.restart();
    const snapshot = f.control.snapshot()!;
    assert.equal(snapshot.runId, id); assert.equal(snapshot.status, 'paused');
    f.control.resume(id, snapshot.revision);
    await f.session.prompt('Continue from the saved result.');
    assert.equal(f.control.snapshot()?.used.toolCalls, 1);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'restart.txt'), 'utf8'), 'retained');
  });
  await run('sdk-compaction-counts-within-task', () => createRuntimeFixture([
    'Original task context and progress.', 'More progress. '.repeat(200), 'Summary preserving goal and files.', 'Finished after compaction.',
  ]), async f => {
    await f.session.prompt('Retain the goal and file state. '.repeat(100));
    f.control.activateContinuation();
    await f.control.run(() => f.session.prompt('Continue the same task and retain this more recent progress.'));
    // Same task is waiting for an explicit context-maintenance operation.
    f.control.activateContinuation();
    const release = f.control.enter();
    try { await f.session.compact('Keep the task goal, decisions and pending work.'); }
    finally { release(); }
    assert.ok(f.requests.length >= 3);
    assert.equal(f.control.snapshot()?.used.modelCalls, f.requests.length);
    f.control.activateContinuation();
    await f.control.run(() => f.session.prompt('Finish the original task.'));
  });
  await run('negative-control-wrong-artifact', () => createRuntimeFixture([
    [call('write', { path: 'result.txt', content: 'wrong' })], 'Everything is correct.',
  ]), async f => {
    await f.session.prompt('Produce the expected artifact.');
    // The grader must reject a successful tool result and an unsupported success claim.
    assert.throws(() => assert.equal(fs.readFileSync(path.join(f.workspace, 'result.txt'), 'utf8'), 'expected'));
  });
  let browser: Awaited<ReturnType<typeof createIsolatedBrowser>> = null;
  try { browser = await createIsolatedBrowser(); }
  catch (error) { rows.push({ id: 'browser-host-startup', status: 'environment_blocked', reason: String(error) }); }
  if (browser) {
    try {
      await run('local-browser-page', () => {
        const turns: Parameters<typeof createRuntimeFixture>[0] = [];
        return createRuntimeFixture(turns, undefined, (_workspace, context) => {
          turns.push([call('browser', { action: 'start' })],
            [call('browser', { action: 'navigate', url: `${context.baseUrl}/page` })],
            [call('browser', { action: 'evaluate', expression: "document.querySelector('#result').textContent='BROWSER_OK'; document.title" })],
            [call('browser', { action: 'snapshot' })], 'Complete.');
          return [createBrowserTool(() => context.sessionPath, { browserManager: browser!.manager })];
        });
      }, async f => {
        await f.session.prompt('Read and update the local test page.');
        assert.match(textResults(f), /BROWSER_OK/);
        assert.equal(await browser!.manager.evaluate("document.querySelector('#result').textContent", f.sessionPath), '"BROWSER_OK"');
        await browser!.manager.close(f.sessionPath);
      });
    } finally { await browser.close(); }
  } else rows.push({ id: 'local-browser-page', status: 'environment_blocked', reason: 'An isolated installed Electron/Chromium host is unavailable.' });
  if (process.platform === 'win32' && resolveWin32SandboxHelper()) {
    await run('os-sandbox-isolation', () => createRuntimeFixture([
      [call('bash', { command: 'node sandbox.cjs' })], 'Complete.',
    ]), async f => {
      f.setSandbox(true);
      const outside = path.join(f.root, 'must-not-change.txt');
      fs.writeFileSync(outside, 'original');
      fs.writeFileSync(path.join(f.workspace, 'sandbox.cjs'),
        `const fs=require('fs');fs.writeFileSync('allowed.txt','ok');try{fs.writeFileSync(${JSON.stringify(outside)},'changed');}catch{console.log('SANDBOX_DENIED')}`);
      await f.session.prompt('Verify the configured file isolation policy.');
      assert.equal(fs.readFileSync(path.join(f.workspace, 'allowed.txt'), 'utf8'), 'ok');
      assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
      assert.match(textResults(f), /SANDBOX_DENIED/);
    });
  } else rows.push({ id: 'os-sandbox-isolation', status: 'environment_blocked',
    reason: 'Windows sandbox helper is not installed, or this platform needs its own OS sandbox fixture. Permission checks are not evidence of OS isolation.' });
  return rows;
}
