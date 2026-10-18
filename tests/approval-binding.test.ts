import { describe, it, expect, vi } from 'vitest';
import { toolActionId } from '../lib/tools/tool-action-ledger.ts';
import { approvalDigest } from '../lib/permission/approval-binding.ts';
import { wrapWithSessionPermission } from '../lib/tools/session-permission-wrapper.ts';

describe('single action approval binding', () => {
  it('is stable under key order but changes with target, tool or scope', () => {
    const digest = approvalDigest('write', { path: 'a', content: 'x' }, 's');
    expect(approvalDigest('write', { content: 'x', path: 'a' }, 's')).toBe(digest);
    expect(approvalDigest('write', { path: 'b', content: 'x' }, 's')).not.toBe(digest);
    expect(approvalDigest('send', { path: 'a', content: 'x' }, 's')).not.toBe(digest);
    expect(approvalDigest('write', { path: 'a', content: 'x' }, 'other')).not.toBe(digest);
  });
  it('rejects mutable parameters after the user approves the original target', async () => {
    let approve!: (value: unknown) => void;
    const execute = vi.fn();
    const params = { path: 'safe.txt', content: 'hello' };
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], {
      getPermissionMode: () => 'ask', getSessionPath: () => 'session',
      confirmStore: { create: () => ({ confirmId: 'c', promise: new Promise(resolve => { approve = resolve; }) }) },
    });
    const pending = tool.execute('a', params);
    params.path = 'different.txt';
    approve({ action: 'confirmed' });
    const result = await pending;
    expect(execute).not.toHaveBeenCalled();
    expect(result.details.confirmation.reason).toBe('approval-parameters-changed');
  });
  it('rejects an approval after its deadline even if the confirmation source responds late', async () => {
    vi.useFakeTimers();
    try {
      let approve!: (value: unknown) => void;
      const execute = vi.fn();
      const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], {
        getSessionPath: () => 'session',
        confirmStore: { create: () => ({ confirmId: 'c', promise: new Promise(resolve => { approve = resolve; }) }) },
      });
      const pending = tool.execute('a', { path: 'a' });
      vi.advanceTimersByTime(300_001);
      approve({ action: 'confirmed' });
      const result = await pending;
      expect(execute).not.toHaveBeenCalled();
      expect(result.details.confirmation.status).toBe('timeout');
    } finally { vi.useRealTimers(); }
  });
  it('redacts credentials in approval cards and stored presentation metadata', async () => {
    const emitEvent = vi.fn();
    const create = vi.fn((_kind: string, _payload: unknown, _session: string) => ({ confirmId: 'c', promise: Promise.resolve({ action: 'rejected' }) }));
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute: vi.fn() }], {
      getSessionPath: () => 'session', emitEvent, confirmStore: { create },
    });
    await tool.execute('a', { path: 'a', password: 'secret-password', token: 'secret-token' });
    expect(JSON.stringify(emitEvent.mock.calls)).not.toContain('secret-password');
    expect(JSON.stringify(create.mock.calls)).not.toContain('secret-token');
    expect(create.mock.calls[0][1]).toMatchObject({ actionId: toolActionId('session', 'a'), scope: 'single-action' });
  });
});

describe('live permission scope revalidation', () => {
  it.each(['read_only', 'operate'])('rejects a late approval after mode changes from ask to %s', async nextMode => {
    let mode = 'ask';
    let approve!: (value: unknown) => void;
    const execute = vi.fn();
    const begin = vi.fn();
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], {
      getPermissionMode: () => mode, getSessionPath: () => '/session', actionLedger: { begin },
      confirmStore: { create: () => ({ confirmId: 'c', promise: new Promise(resolve => { approve = resolve; }) }) },
    });
    const pending = tool.execute('late-mode', { path: '/tmp/result.txt', content: 'x' });
    mode = nextMode;
    approve({ action: 'confirmed' });
    expect((await pending).details.errorCode).toBe('APPROVAL_PARAMETERS_CHANGED');
    expect(execute).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it.each(['context', 'sessionCwd', 'runtimeCwd', 'workspace', 'authorized', 'toolAuthorized', 'contextFolders'])(
    'rejects permission %s changes before claiming a durable action', async field => {
      let approve!: (value: unknown) => void;
      const state = { sessionCwd: '/a', runtimeCwd: '/a', workspace: ['/a'], authorized: ['/extra'], toolAuthorized: ['/extra'] };
      const permissionContext = { isSubagent: false, requireInteractiveApproval: true };
      const ctx = { sessionPath: '/session', authorizedFolders: ['/extra'], sessionManager: { getSessionFile: () => '/session', getCwd: () => state.runtimeCwd } };
      const execute = vi.fn();
      const begin = vi.fn();
      const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], {
        getPermissionMode: () => 'ask', permissionContext, actionLedger: { begin },
        getSessionCwd: () => state.sessionCwd,
        getSessionWorkspaceFolders: () => [...state.workspace],
        getSessionAuthorizedFolders: () => [...state.authorized],
        getAuthorizedFolders: () => [...state.toolAuthorized],
        confirmStore: { create: () => ({ confirmId: 'c', promise: new Promise(resolve => { approve = resolve; }) }) },
      });
      const pending = tool.execute('scope-change', { path: '/tmp/result.txt' }, undefined, undefined, ctx);
      if (field === 'context') permissionContext.requireInteractiveApproval = false;
      else if (field === 'sessionCwd') state.sessionCwd = '/b';
      else if (field === 'runtimeCwd') state.runtimeCwd = '/b';
      else if (field === 'workspace') state.workspace.push('/b');
      else if (field === 'authorized') state.authorized.length = 0;
      else if (field === 'toolAuthorized') state.toolAuthorized.length = 0;
      else ctx.authorizedFolders.length = 0;
      approve({ action: 'confirmed' });
      expect((await pending).details.errorCode).toBe('APPROVAL_PARAMETERS_CHANGED');
      expect(execute).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
    },
  );

  it('applies the same dynamic-scope check after automatic approval', async () => {
    let finishReview!: (value: unknown) => void;
    let folders = ['/project'];
    const execute = vi.fn();
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], {
      getPermissionMode: () => 'auto', getSessionPath: () => '/session',
      getSessionAuthorizedFolders: () => folders,
      approvalGateway: { review: () => new Promise(resolve => { finishReview = resolve; }) },
    });
    const pending = tool.execute('auto-scope', { path: '/tmp/result.txt' });
    folders = [];
    finishReview({ action: 'allow' });
    expect((await pending).details.errorCode).toBe('APPROVAL_PARAMETERS_CHANGED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed if live scope cannot be re-read after approval', async () => {
    let approve!: (value: unknown) => void;
    let unavailable = false;
    const execute = vi.fn();
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], {
      getPermissionMode: () => 'ask', getSessionPath: () => '/session',
      getSessionAuthorizedFolders: () => { if (unavailable) throw new Error('scope unavailable'); return ['/a']; },
      confirmStore: { create: () => ({ confirmId: 'c', promise: new Promise(resolve => { approve = resolve; }) }) },
    });
    const pending = tool.execute('unavailable-scope', { path: '/tmp/result.txt' });
    unavailable = true;
    approve({ action: 'confirmed' });
    expect((await pending).details.errorCode).toBe('APPROVAL_SCOPE_UNAVAILABLE');
    expect(execute).not.toHaveBeenCalled();
  });

  it('still permits unchanged scope returned as fresh callback objects', async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const [tool] = wrapWithSessionPermission([{ name: 'write', execute }], {
      getPermissionMode: () => 'ask', getSessionPath: () => '/session',
      getSessionWorkspaceFolders: () => ['/project'], getSessionAuthorizedFolders: () => ['/extra'],
      confirmStore: { create: () => ({ confirmId: 'c', promise: Promise.resolve({ action: 'confirmed' }) }) },
    });
    await tool.execute('unchanged-scope', { path: '/tmp/result.txt' });
    expect(execute).toHaveBeenCalledOnce();
  });
});
