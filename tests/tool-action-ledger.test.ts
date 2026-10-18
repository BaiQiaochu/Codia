import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolActionLedger, toolActionId } from '../lib/tools/tool-action-ledger.ts';
import { wrapWithSessionPermission } from '../lib/tools/session-permission-wrapper.ts';

const directories: string[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'tool-ledger-'));
  directories.push(directory);
  return { directory, ledger: new ToolActionLedger(directory) };
}
const binding = (readOnly = false) => ({
  actionId: toolActionId('/session', 'call-1'), toolName: readOnly ? 'read' : 'write',
  parameterDigest: 'parameters', scopeDigest: 'scope', readOnly,
  approval: { mode: 'ask', decision: 'confirmed', confirmId: 'confirmation-1' },
});
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('durable tool action ledger', () => {
  it('persists intent and running before execution, and blocks unknown writes across restart', () => {
    const { ledger, directory } = setup();
    const record = ledger.begin(binding());
    expect(record.state).toBe('running');
    expect(new ToolActionLedger(directory).get(record.actionId)).toMatchObject({ state: 'running', approval: binding().approval });
    expect(() => new ToolActionLedger(directory).begin(binding())).toThrow(/may already have changed/);
  });
  it('survives forced process death after an external effect and blocks a duplicate', () => {
    const { directory, ledger } = setup();
    const target = join(directory, 'external-result.txt');
    const moduleUrl = new URL('../lib/tools/tool-action-ledger.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { ToolActionLedger } from ${JSON.stringify(moduleUrl)};
      import { appendFileSync } from 'node:fs';
      const ledger = new ToolActionLedger(${JSON.stringify(directory)});
      ledger.begin(${JSON.stringify(binding())});
      appendFileSync(${JSON.stringify(target)}, 'sent\\n');
      process.kill(process.pid, 'SIGKILL');
    `], { encoding: 'utf8' });
    expect(child.status).not.toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('sent\n');
    expect(() => ledger.begin(binding())).toThrow(/may already have changed/);
    expect(readFileSync(target, 'utf8')).toBe('sent\n');
  });
  it('does not repeat a confirmed completed write', () => {
    const { ledger } = setup();
    ledger.finish(ledger.begin(binding()), true);
    expect(() => ledger.begin(binding())).toThrow(/already completed/);
  });
  it('rejects parameter and scope changes under the same stable action ID', () => {
    const { ledger } = setup();
    ledger.begin(binding());
    expect(() => ledger.begin({ ...binding(), parameterDigest: 'changed' })).toThrow(/parameters or scope changed/);
    expect(() => ledger.begin({ ...binding(), scopeDigest: 'changed' })).toThrow(/parameters or scope changed/);
  });
  it('allows interrupted recognized reads to run again', () => {
    const { ledger, directory } = setup();
    ledger.begin(binding(true));
    expect(new ToolActionLedger(directory).begin(binding(true)).state).toBe('running');
  });
  it('fails closed on malformed records', () => {
    const { ledger, directory } = setup();
    ledger.begin(binding());
    writeFileSync(join(directory, `${binding().actionId}.json`), '{truncated');
    expect(() => ledger.begin(binding())).toThrow();
  });
});

describe('permission wrapper durable execution', () => {
  it('records before writes, blocks completed duplicate calls and redacts parameters/results from disk', async () => {
    const { ledger, directory } = setup();
    const execute = vi.fn(async () => {
      expect(ledger.get(toolActionId('/session', 'call-1'))?.state).toBe('running');
      return { content: [{ type: 'text', text: 'private-result' }] };
    });
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], { actionLedger: ledger, getPermissionMode: () => 'operate' });
    await tool.execute('call-1', { path: '/tmp/x', content: 'secret-value' }, { sessionPath: '/session' });
    const duplicate = await tool.execute('call-1', { path: '/tmp/x', content: 'secret-value' }, { sessionPath: '/session' });
    expect(duplicate.details.errorCode).toBe('ACTION_ALREADY_COMPLETED');
    expect(execute).toHaveBeenCalledTimes(1);
    const disk = readdirSync(directory).map(name => readFileSync(join(directory, name), 'utf8')).join('');
    expect(disk).not.toContain('secret-value');
    expect(disk).not.toContain('private-result');
    expect(disk).not.toContain('/session');
  });
  it('blocks duplicate external write after simulated response timeout, including concurrent requests', async () => {
    const { ledger } = setup();
    let release!: () => void;
    const execute = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error('external write succeeded but response timed out'); });
    const [tool] = wrapWithSessionPermission([{ name: 'notify', execute }], { actionLedger: ledger, getPermissionMode: () => 'operate' });
    const first = tool.execute('call-1', {}, { sessionPath: '/session' });
    const second = await tool.execute('call-1', {}, { sessionPath: '/session' });
    expect(second.details.errorCode).toBe('ACTION_RESULT_UNKNOWN');
    const rejected = expect(first).rejects.toThrow(/timed out/);
    release();
    await rejected;
    expect(ledger.get(toolActionId('/session', 'call-1'))?.state).toBe('unknown');
    expect((await tool.execute('call-1', {}, { sessionPath: '/session' })).details.errorCode).toBe('ACTION_RESULT_UNKNOWN');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('retries recognized reads but never assumes arbitrary allowed tools are reads', async () => {
    const { ledger } = setup();
    const execute = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({});
    const [tool] = wrapWithSessionPermission([{ name: 'read', execute }], { actionLedger: ledger, getPermissionMode: () => 'operate' });
    await expect(tool.execute('call-1', {}, { sessionPath: '/session' })).rejects.toThrow();
    await tool.execute('call-1', {}, { sessionPath: '/session' });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('fails closed before execution when disk persistence fails or IDs are missing', async () => {
    const execute = vi.fn();
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], {
      actionLedger: { begin() { throw new Error('disk full'); } }, getPermissionMode: () => 'operate',
    });
    expect((await tool.execute('call-1', {}, { sessionPath: '/session' })).details.errorCode).toBe('ACTION_LEDGER_UNAVAILABLE');
    expect((await tool.execute('', {}, { sessionPath: '/session' })).details.errorCode).toBe('ACTION_ID_REQUIRED');
    expect(execute).not.toHaveBeenCalled();
  });
  it('reports unknown completion if the result cannot be persisted', async () => {
    const { ledger } = setup();
    vi.spyOn(ledger, 'finish').mockImplementation(() => { throw new Error('disk full'); });
    const execute = vi.fn(async () => ({}));
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], { actionLedger: ledger, getPermissionMode: () => 'operate' });
    expect((await tool.execute('call-1', {}, { sessionPath: '/session' })).details.errorCode).toBe('ACTION_RESULT_UNKNOWN');
    expect((await tool.execute('call-1', {}, { sessionPath: '/session' })).details.errorCode).toBe('ACTION_RESULT_UNKNOWN');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects changed scope while awaiting approval before any ledger execution', async () => {
    const { ledger } = setup();
    const ctx = { sessionPath: '/session', cwd: '/project-a' };
    const execute = vi.fn();
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], {
      actionLedger: ledger, getPermissionMode: () => 'ask',
      confirmStore: { create: () => { ctx.cwd = '/project-b'; return { confirmId: 'c', promise: Promise.resolve({ action: 'confirmed' }) }; } },
    });
    expect((await tool.execute('call-1', {}, ctx)).details.errorCode).toBe('APPROVAL_PARAMETERS_CHANGED');
    expect(execute).not.toHaveBeenCalled();
    expect(ledger.get(toolActionId('/session', 'call-1'))).toBeNull();
  });
  it('binds approval card and persisted entry to the same stable action identity', async () => {
    const { ledger } = setup();
    const create = vi.fn((_kind: string, _payload: any, _session: string) => ({ confirmId: 'confirm-1', promise: Promise.resolve({ action: 'confirmed' }) }));
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute: vi.fn(async () => ({})) }], {
      actionLedger: ledger, getPermissionMode: () => 'ask', confirmStore: { create },
    });
    await tool.execute('call-1', {}, { sessionPath: '/session' });
    const id = toolActionId('/session', 'call-1');
    expect(create.mock.calls[0][1].actionId).toBe(id);
    expect(ledger.get(id)?.approval.confirmId).toBe('confirm-1');
  });
});
