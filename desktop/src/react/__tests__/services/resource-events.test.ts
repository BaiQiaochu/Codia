/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const gsapFetch = vi.hoisted(() => vi.fn(async (path: string) => ({
  json: async () => (path.endsWith('/subscribe') ? { ok: true, subscriptionId: 'sub-1' } : { ok: true }),
})));

vi.mock('../../hooks/use-gsap-fetch', () => ({ gsapFetch }));

describe('resource-events', () => {
  afterEach(() => {
    vi.resetModules();
    gsapFetch.mockClear();
  });

  it('shares one backend resource subscription per local file and releases it after the last subscriber leaves', async () => {
    const { retainLocalFileResourceWatch } = await import('../../services/resource-events');

    const releaseFirst = retainLocalFileResourceWatch('/tmp/note.md');
    const releaseSecond = retainLocalFileResourceWatch('/tmp/note.md');
    await Promise.resolve();

    expect(gsapFetch).toHaveBeenCalledTimes(1);
    expect(gsapFetch).toHaveBeenCalledWith('/api/resource-io/subscribe', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        purpose: 'resource-watch',
        resources: [{ kind: 'local-file', path: '/tmp/note.md' }],
      }),
    }));

    releaseFirst();
    await Promise.resolve();
    expect(gsapFetch).toHaveBeenCalledTimes(1);

    releaseSecond();
    await Promise.resolve();
    await Promise.resolve();

    expect(gsapFetch).toHaveBeenCalledWith('/api/resource-io/subscriptions/sub-1', expect.objectContaining({
      method: 'DELETE',
    }));
  });

  it('dedupes mount ResourceRefs without materializing native paths in the renderer', async () => {
    const { retainResourceWatch } = await import('../../services/resource-events');

    const releaseFirst = retainResourceWatch({ kind: 'mount', mountId: 'mount_docs', path: 'notes' });
    const releaseSecond = retainResourceWatch({ kind: 'mount', mountId: 'mount_docs', path: 'notes/' });
    await Promise.resolve();

    expect(gsapFetch).toHaveBeenCalledTimes(1);
    expect(gsapFetch).toHaveBeenCalledWith('/api/resource-io/subscribe', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        purpose: 'resource-watch',
        resources: [{ kind: 'mount', mountId: 'mount_docs', path: 'notes' }],
      }),
    }));

    releaseFirst();
    releaseSecond();
  });

  it('requests ResourceIO catch-up when the renderer returns to the foreground', async () => {
    const listeners = new Map<string, () => void>();
    const windowObj = {
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(`window:${type}`, listener)),
      removeEventListener: vi.fn(),
    };
    let visibilityState: Document['visibilityState'] = 'hidden';
    const documentObj = {
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(`document:${type}`, listener)),
      removeEventListener: vi.fn(),
      get visibilityState() {
        return visibilityState;
      },
    };
    const catchUp = vi.fn(async () => undefined);
    const { bindResourceEventForegroundCatchUp } = await import('../../services/resource-events');

    const dispose = bindResourceEventForegroundCatchUp(undefined, {
      windowObj: windowObj as never,
      documentObj: documentObj as never,
      catchUp,
      minIntervalMs: 0,
      now: () => 100,
    });

    listeners.get('window:focus')?.();
    expect(catchUp).not.toHaveBeenCalled();
    visibilityState = 'visible';
    listeners.get('document:visibilitychange')?.();
    await Promise.resolve();
    expect(catchUp).toHaveBeenCalledTimes(1);
    dispose();
    expect(windowObj.removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(documentObj.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
