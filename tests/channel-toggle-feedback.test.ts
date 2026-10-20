import { describe, expect, it, vi } from 'vitest';
import { ConfigCoordinator } from '../core/config-coordinator.ts';

describe('Agent team switch persistence', () => {
  it('restores the confirmed preference if runtime switching fails', async () => {
    let enabled = false;
    const toggleChannels = vi.fn().mockRejectedValueOnce(new Error('runtime unavailable')).mockResolvedValueOnce(undefined);
    const coordinator = new ConfigCoordinator({
      getPrefs: () => ({ getChannelsEnabled: () => enabled, setChannelsEnabled: value => { enabled = value; } }),
      getHub: () => ({ toggleChannels }),
    });
    await expect(coordinator.setChannelsEnabled(true)).rejects.toThrow('runtime unavailable');
    expect(enabled).toBe(false);
    expect(toggleChannels.mock.calls).toEqual([[true], [false]]);
  });
});
