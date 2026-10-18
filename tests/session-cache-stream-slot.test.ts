import { expect, it, vi } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { SessionCoordinator } from '../core/session-coordinator.ts';

it('guards the active SDK transport and preserves ordinary request options', async () => {
  const original = vi.fn((_model: unknown, _context: unknown, _options: unknown) => 'stream');
  const agent = new Agent({ streamFn: original } as any);
  const assertContract = vi.fn();
  const coordinator = { _assertCachePrefixContract: assertContract };
  const entry = { session: { agent } };
  SessionCoordinator.prototype._installCachePrefixGuard.call(coordinator, 'session', entry);
  const options = { maxRetries: 2, cacheRetention: 'long' };
  expect(await (agent as any).streamFunction({}, {}, options)).toBe('stream');
  expect(assertContract).toHaveBeenCalledOnce();
  expect(original.mock.calls[0][2]).toBe(options);
});
