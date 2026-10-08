import { describe, expect, it, vi } from 'vitest';
import { createPluginContext } from '../core/plugin-context.ts';

function makeContext(options: Record<string, unknown> = {}) {
  const bus = {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    request: vi.fn(),
    hasHandler: vi.fn(() => false),
    listCapabilities: vi.fn(() => []),
    getCapability: vi.fn(() => null),
  };
  const resourceIO = {
    read: vi.fn(async ref => ({ ref, content: Buffer.from('ok') })),
    write: vi.fn(async (...args) => ({ args })),
  };
  const emitResourceChanged = vi.fn();
  const emitResourceDeleted = vi.fn();
  const emitResourceRenamed = vi.fn();
  const ctx = createPluginContext({
    pluginId: 'resource-plugin',
    pluginDir: '/tmp/plugin',
    dataDir: '/tmp/plugin-data',
    bus,
    capabilities: [],
    sensitiveCapabilities: [],
    resourceIO,
    emitResourceChanged,
    emitResourceDeleted,
    emitResourceRenamed,
    runtimeContext: { sessionId: 'sess_1', sessionPath: '/sessions/current.jsonl' },
    ...options,
  } as any);
  return { ctx, bus, resourceIO, emitResourceChanged, emitResourceDeleted, emitResourceRenamed };
}

describe('plugin ResourceIO context', () => {
  it('requires manifest resource capabilities before resource access', async () => {
    const { ctx } = makeContext();

    await expect(ctx.resources.read({ kind: 'local-file', path: '/tmp/a.txt' }))
      .rejects.toMatchObject({
        code: 'PLUGIN_RESOURCE_CAPABILITY_NOT_DECLARED',
        capability: 'resource.read',
      });
  });

  it('delegates reads and writes through ResourceIO when declared', async () => {
    const { ctx, resourceIO } = makeContext({
      capabilities: ['resource.read', 'resource.write'],
    });

    await expect(ctx.resources.read({ kind: 'local-file', path: '/tmp/a.txt' }))
      .resolves.toMatchObject({ ref: { kind: 'local-file', path: '/tmp/a.txt' } });
    await ctx.resources.write({ kind: 'local-file', path: '/tmp/a.txt' }, 'updated');

    expect(resourceIO.read).toHaveBeenCalledWith({ kind: 'local-file', path: '/tmp/a.txt' });
    expect(resourceIO.write).toHaveBeenCalledWith(
      { kind: 'local-file', path: '/tmp/a.txt' },
      'updated',
      expect.objectContaining({
        source: 'plugin',
        reason: 'plugin:resource-plugin:write',
        sessionId: 'sess_1',
        sessionPath: '/sessions/current.jsonl',
        principal: expect.objectContaining({
          kind: 'plugin',
          pluginId: 'resource-plugin',
          sessionId: 'sess_1',
          sessionPath: '/sessions/current.jsonl',
        }),
      }),
    );
  });

  it('forwards plugin resource events through the host emitter', () => {
    const { ctx, emitResourceChanged } = makeContext();

    expect(ctx.resourceEvents.changed({ filePath: '/tmp/a.txt' })).toBe(true);
    expect(emitResourceChanged).toHaveBeenCalledWith({ filePath: '/tmp/a.txt' });
  });

  it('forwards delete and rename resource events through the host emitter', () => {
    const { ctx, emitResourceDeleted, emitResourceRenamed } = makeContext();

    expect(ctx.resourceEvents.deleted({ filePath: '/tmp/a.txt' })).toBe(true);
    expect(ctx.resourceEvents.renamed({ from: '/tmp/a.txt', to: '/tmp/b.txt' })).toBe(true);
    expect(emitResourceDeleted).toHaveBeenCalledWith({ filePath: '/tmp/a.txt' });
    expect(emitResourceRenamed).toHaveBeenCalledWith({ from: '/tmp/a.txt', to: '/tmp/b.txt' });
  });
});
