// @ts-nocheck
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWorkspaceWatchRegistry } from "../desktop/workspace-watch-registry.cjs";

class FakeWatcher {
  constructor() {
    this.handlers = new Map();
    this.close = vi.fn();
  }

  on(eventName, handler) {
    const handlers = this.handlers.get(eventName) || [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
    return this;
  }

  emit(eventName, ...args) {
    for (const handler of this.handlers.get(eventName) || []) handler(...args);
  }
}

describe("workspace-watch-registry", () => {
  let watchMock;
  let watchers;
  let notified;

  beforeEach(() => {
    watchers = new Map();
    notified = [];
    watchMock = vi.fn((rootPath) => {
      const watcher = new FakeWatcher();
      watchers.set(rootPath, watcher);
      return watcher;
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one shallow workspace watcher and notifies subscribers with the affected directory", () => {
    const root = path.resolve("workspace");
    const file = path.join(root, "src", "App.tsx");
    const affectedDir = path.join(root, "src");
    const registry = createWorkspaceWatchRegistry({
      watch: watchMock,
      notifySubscriber: (subscriberId, payload) => notified.push({ subscriberId, payload }),
      debounceMs: 30,
    });

    expect(registry.watchWorkspace(root, 1)).toBe(true);
    expect(registry.watchWorkspace(root, 2)).toBe(true);
    expect(watchMock).toHaveBeenCalledTimes(1);

    watchers.get(root).emit("all", "add", file);
    vi.advanceTimersByTime(35);

    expect(notified).toEqual([
      { subscriberId: 1, payload: { rootPath: root, changedPath: file, affectedDir, eventType: "add" } },
      { subscriberId: 2, payload: { rootPath: root, changedPath: file, affectedDir, eventType: "add" } },
    ]);
  });

  it("ignores heavyweight and hidden workspace paths before they reach the watcher", () => {
    const root = path.resolve("workspace");
    const registry = createWorkspaceWatchRegistry({
      watch: watchMock,
      notifySubscriber: () => {},
    });

    registry.watchWorkspace(root, 1);
    const options = watchMock.mock.calls[0][1];

    expect(options.ignored(path.join(root, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(options.ignored(path.join(root, ".git", "index"))).toBe(true);
    expect(options.ignored(path.join(root, "src", "App.tsx"))).toBe(false);
  });

  it("limits each watcher to the watched directory so opening a workspace never recursively scans the whole tree", () => {
    const root = path.resolve("workspace");
    const registry = createWorkspaceWatchRegistry({
      watch: watchMock,
      notifySubscriber: () => {},
    });

    expect(registry.watchWorkspace(root, 1)).toBe(true);
    const options = watchMock.mock.calls[0][1];

    expect(options.depth).toBe(0);
    expect(options.awaitWriteFinish).toBe(false);
    expect(options.ignoreInitial).toBe(true);
  });

  it("removes only the current subscriber and closes the watcher after the last subscriber leaves", () => {
    const root = path.resolve("workspace");
    const registry = createWorkspaceWatchRegistry({
      watch: watchMock,
      notifySubscriber: () => {},
    });

    registry.watchWorkspace(root, 1);
    registry.watchWorkspace(root, 2);

    expect(registry.unwatchWorkspace(root, 1)).toBe(true);
    expect(watchers.get(root).close).not.toHaveBeenCalled();

    expect(registry.unwatchWorkspace(root, 2)).toBe(true);
    expect(watchers.get(root).close).toHaveBeenCalledOnce();
  });
});
