import path from "path";
import { describe, expect, it, vi } from "vitest";
import { ResourceWatchRegistry } from "../lib/resource-io/resource-watch-registry.ts";
import { resourceKeyForRef } from "../lib/resource-io/resource-refs.ts";

describe("ResourceWatchRegistry", () => {
  it("shares backend watches across subscriptions and reports diagnostics", () => {
    const filePath = path.join("/workspace", "notes", "a.md");
    const resourceKey = resourceKeyForRef({ kind: "local-file", path: filePath });
    const close = vi.fn();
    const watchPath = vi.fn(() => ({ close }));
    const registry = new ResourceWatchRegistry({
      emitEvent: vi.fn(),
      watchPath,
    });

    const first = registry.subscribe({
      purpose: "preview",
      sessionPath: "/sessions/a.jsonl",
      resources: [{ kind: "local-file", path: filePath }],
    });
    const second = registry.subscribe({
      purpose: "workspace-tree",
      resources: [{ kind: "local-file", path: filePath }],
    });

    expect(first.subscriptionId).toEqual(expect.any(String));
    expect(first.resourceKeys).toEqual([resourceKey]);
    expect(watchPath).toHaveBeenCalledTimes(1);
    expect(registry.diagnostics()).toMatchObject({
      subscriptions: 2,
      watches: [{
        resourceKey,
        refCount: 2,
      }],
    });

    expect(registry.unsubscribe(first.subscriptionId)).toBe(true);
    expect(close).not.toHaveBeenCalled();

    expect(registry.unsubscribe(second.subscriptionId)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.diagnostics()).toMatchObject({ subscriptions: 0, watches: [] });
  });

  it("uses the resolved win32 path for local-file watch paths and resource keys", async () => {
    vi.resetModules();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("D:\\a\\gsap\\main");
    vi.doMock("path", async () => {
      const actual = await vi.importActual<typeof import("path")>("path");
      return {
        ...actual.win32,
        default: actual.win32,
        win32: actual.win32,
        posix: actual.posix,
      };
    });

    try {
      const { ResourceWatchRegistry: WinResourceWatchRegistry } = await import("../lib/resource-io/resource-watch-registry.ts");
      const close = vi.fn();
      const watchPath = vi.fn(() => ({ close }));
      const registry = new WinResourceWatchRegistry({
        emitEvent: vi.fn(),
        watchPath,
      });

      const subscription = registry.subscribe({
        purpose: "preview",
        resources: [{ kind: "local-file", path: "/workspace/notes/a.md" }],
      });

      expect(subscription.resourceKeys).toEqual(["local_fs:D:/workspace/notes/a.md"]);
      expect(watchPath).toHaveBeenCalledWith("D:\\workspace\\notes\\a.md", expect.any(Function));
      expect(registry.diagnostics().watches[0]).toMatchObject({
        resourceKey: "local_fs:D:/workspace/notes/a.md",
        filePath: "D:\\workspace\\notes\\a.md",
      });
    } finally {
      vi.doUnmock("path");
      vi.resetModules();
      cwdSpy.mockRestore();
    }
  });

  it("emits a versioned resource.changed event after a watched local file changes", async () => {
    vi.useFakeTimers();
    const filePath = path.join("/workspace", "notes", "a.md");
    const resourceKey = resourceKeyForRef({ kind: "local-file", path: filePath });
    const close = vi.fn();
    const emitEvent = vi.fn();
    let onChange: (() => void) | null = null;

    const registry = new ResourceWatchRegistry({
      emitEvent,
      debounceMs: 5,
      watchPath: vi.fn((_targetPath, handler) => {
        onChange = handler;
        return { close };
      }),
      statPath: vi.fn(() => ({
        exists: true,
        isDirectory: false,
        mtimeMs: 123,
        size: 7,
      })),
    });

    const release = registry.retain({ kind: "local-file", path: filePath });
    onChange?.();
    await vi.runAllTimersAsync();

    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      source: "provider_watch",
      resourceKey,
      resource: expect.objectContaining({
        kind: "local-file",
        provider: "local_fs",
        path: path.resolve(filePath),
      }),
      version: { mtimeMs: 123, size: 7 },
    }), null);

    release();
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("treats basename changes from a watched file as the file itself", async () => {
    vi.useFakeTimers();
    const filePath = path.join("/workspace", "notes", "a.md");
    const resolvedFilePath = path.resolve(filePath);
    const resourceKey = resourceKeyForRef({ kind: "local-file", path: filePath });
    const close = vi.fn();
    const emitEvent = vi.fn();
    let onChange: ((changedPath?: string | null) => void) | null = null;
    const statPath = vi.fn(() => ({
      exists: true,
      isDirectory: false,
      mtimeMs: 321,
      size: 5,
    }));

    const registry = new ResourceWatchRegistry({
      emitEvent,
      debounceMs: 5,
      resolveWatchTarget: vi.fn((resource) => ({
        ref: resource,
        filePath,
        isDirectory: false,
        resourceKey,
        resource: {
          kind: "local-file",
          provider: "local_fs",
          path: filePath,
          filePath,
        },
        toResource: (eventPath) => ({
          resourceKey: resourceKeyForRef({ kind: "local-file", path: eventPath }),
          resource: {
            kind: "local-file",
            provider: "local_fs",
            path: eventPath,
            filePath: eventPath,
          },
        }),
      })),
      watchPath: vi.fn((_targetPath, handler) => {
        onChange = handler;
        return { close };
      }),
      statPath,
    });

    const release = registry.retain({ kind: "local-file", path: filePath });
    onChange?.("a.md");
    await vi.runAllTimersAsync();

    expect(statPath).toHaveBeenCalledWith(resolvedFilePath);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      resourceKey,
      resource: expect.objectContaining({
        kind: "local-file",
        provider: "local_fs",
        path: resolvedFilePath,
        filePath: resolvedFilePath,
      }),
      version: { mtimeMs: 321, size: 5 },
    }), null);

    release();
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("uses provider watch targets and emits canonical provider resources", async () => {
    vi.useFakeTimers();
    const mountRoot = path.join("/mnt", "docs");
    const resolvedMountRoot = path.resolve(mountRoot);
    const changedPath = path.join(mountRoot, "notes", "a.md");
    const resolvedChangedPath = path.resolve(changedPath);
    const close = vi.fn();
    const emitEvent = vi.fn();
    let onChange: ((changedPath?: string | null) => void) | null = null;

    const registry = new ResourceWatchRegistry({
      emitEvent,
      debounceMs: 5,
      resolveWatchTarget: vi.fn((resource) => ({
        ref: resource,
        filePath: mountRoot,
        resourceKey: "mount:mount_local:",
        resource: {
          kind: "mount",
          mountId: "mount_local",
          path: "",
          provider: "mount",
          filePath: mountRoot,
        },
        toResource: (eventPath) => ({
          resourceKey: "mount:mount_local:notes/a.md",
          resource: {
            kind: "mount",
            mountId: "mount_local",
            path: "notes/a.md",
            provider: "mount",
            filePath: eventPath,
          },
        }),
      })),
      watchPath: vi.fn((_targetPath, handler) => {
        onChange = handler;
        return { close };
      }),
      statPath: vi.fn(() => ({
        exists: true,
        isDirectory: false,
        mtimeMs: 456,
        size: 11,
      })),
    });

    const subscription = registry.subscribe({
      purpose: "workspace-tree",
      resources: [{ kind: "mount", mountId: "mount_local", path: "" }],
    });

    expect(subscription.resourceKeys).toEqual(["mount:mount_local:"]);
    expect(registry.diagnostics().watches[0]).toMatchObject({
      resourceKey: "mount:mount_local:",
      filePath: resolvedMountRoot,
    });

    onChange?.(changedPath);
    await vi.runAllTimersAsync();

    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      source: "provider_watch",
      resourceKey: "mount:mount_local:notes/a.md",
      resource: expect.objectContaining({
        kind: "mount",
        mountId: "mount_local",
        path: "notes/a.md",
        provider: "mount",
        filePath: resolvedChangedPath,
      }),
      version: { mtimeMs: 456, size: 11 },
    }), null);

    registry.unsubscribe(subscription.subscriptionId);
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("treats directory basename echoes as a directory rescan instead of a child deletion", async () => {
    vi.useFakeTimers();
    const filePath = path.join("/workspace", "notes");
    const resolvedFilePath = path.resolve(filePath);
    const resourceKey = resourceKeyForRef({ kind: "local-file", path: resolvedFilePath });
    const emitEvent = vi.fn();
    let onChange: ((changedPath?: string | null) => void) | null = null;
    const statPath = vi.fn(() => ({
      exists: true,
      isDirectory: true,
      mtimeMs: 654,
      size: null,
    }));
    const registry = new ResourceWatchRegistry({
      emitEvent,
      debounceMs: 5,
      resolveWatchTarget: vi.fn((resource) => ({
        ref: resource,
        filePath,
        isDirectory: true,
        resourceKey,
        resource: {
          kind: "local-file",
          provider: "local_fs",
          path: filePath,
          filePath,
        },
        toResource: (eventPath) => ({
          resourceKey: resourceKeyForRef({ kind: "local-file", path: eventPath }),
          resource: {
            kind: "local-file",
            provider: "local_fs",
            path: eventPath,
            filePath: eventPath,
          },
        }),
      })),
      watchPath: vi.fn((_targetPath, handler) => {
        onChange = handler;
        return { close: vi.fn() };
      }),
      statPath,
    });

    registry.retain({ kind: "local-file", path: filePath });
    onChange?.("notes");
    await vi.runAllTimersAsync();

    expect(statPath).toHaveBeenCalledWith(resolvedFilePath);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      resourceKey,
      resource: expect.objectContaining({
        path: resolvedFilePath,
        filePath: resolvedFilePath,
        isDirectory: true,
      }),
      version: { mtimeMs: 654, size: null },
    }), null);
    const fakeChildKey = resourceKeyForRef({ kind: "local-file", path: path.join(resolvedFilePath, "notes") });
    expect(emitEvent.mock.calls.some(([event]) => (
      event?.type === "resource.deleted" && event?.resourceKey === fakeChildKey
    ))).toBe(false);
    vi.useRealTimers();
  });
});
