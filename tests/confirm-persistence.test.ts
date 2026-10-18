import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfirmStore } from '../lib/confirm-store.ts';

describe('approval restart evidence', () => {
  it('recovers pending metadata but never resurrects approval authority', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-restart-'));
    try {
      const persistPath = path.join(root, 'approvals.json');
      const before = new ConfirmStore({ persistPath });
      const request = before.create('tool_action_approval', { actionId: 'a', token: 'private-token', parameterDigest: 'abc' }, 'session');
      const after = new ConfirmStore({ persistPath });
      expect(after.listPending()).toEqual([]);
      expect(after.listInterrupted()).toEqual([expect.objectContaining({ id: request.confirmId, status: 'interrupted' })]);
      expect(after.resolve(request.confirmId, 'confirmed', undefined)).toBe(false);
      expect(fs.readFileSync(persistPath, 'utf8')).not.toContain('private-token');
      before.abortBySession('session');
      expect(await request.promise).toEqual({ action: 'aborted' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('does not resurrect resolved decisions as pending', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-resolved-'));
    try {
      const persistPath = path.join(root, 'approvals.json');
      const before = new ConfirmStore({ persistPath });
      const request = before.create('tool_action_approval', {}, 'session');
      before.resolve(request.confirmId, 'rejected', undefined);
      await request.promise;
      const after = new ConfirmStore({ persistPath });
      expect(after.listInterrupted()).toEqual([]);
      expect(after.resolve(request.confirmId, 'confirmed', undefined)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
