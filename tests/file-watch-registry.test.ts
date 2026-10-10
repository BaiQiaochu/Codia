import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStableFileWatcher } from "../desktop/file-watch-adapter.cjs";
import { createFileWatchRegistry } from "../desktop/file-watch-registry.cjs";

describe("file-watch-registry", () => {
  let watchMock;
  let callbacks;
  let closeFns;
  let notified;

  beforeEach(() => {
    callbacks = new Map();
    closeFns = new Map();
    notified = [];
    watchMock = vi.fn((filePath, _opts, cb) => {
      callbacks.set(filePath, cb);
      const close = vi.fn();
      closeFns.set(filePath, close);
      return { close };
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one low-level watcher for the same file and notifies all subscribers", () => {
    const target = path.resolve("/tmp/a.txt");
    const registry = createFileWatchRegistry({
      watch: watchMock,
      notifySubscriber: (subscriberId, filePath) => notified.push({ subscriberId, filePath }),
    });

    expect(registry.watchFile(target, 1)).toBe(true);
    expect(registry.watchFile(target, 2)).toBe(true);
    expect(watchMock).toHaveBeenCalledTimes(1);

    callbacks.get(target)("change", target);
    vi.advanceTimersByTime(60);

    expect(notified).toEqual([
      { subscriberId: 1, filePath: target },
      { subscriberId: 2, filePath: target },
    ]);
  });

  it("keeps the watcher open until the last subscriber leaves", () => {
    const target = path.resolve("/tmp/a.txt");
    const registry = createFileWatchRegistry({
      watch: watchMock,
      notifySubscriber: () => {},
    });

    registry.watchFile(target, 1);
    registry.watchFile(target, 2);

    expect(registry.unwatchFile(target, 1)).toBe(true);
    expect(closeFns.get(target)).not.toHaveBeenCalled();

    expect(registry.unwatchFile(target, 2)).toBe(true);
    expect(closeFns.get(target)).toHaveBeenCalledOnce();
  });

  it("unwatchAllForSubscriber removes only that subscriber", () => {
    const first = path.resolve("/tmp/a.txt");
    const second = path.resolve("/tmp/b.txt");
    const registry = createFileWatchRegistry({
      watch: watchMock,
      notifySubscriber: () => {},
    });

    registry.watchFile(first, 1);
    registry.watchFile(second, 1);
    registry.watchFile(second, 2);

    registry.unwatchAllForSubscriber(1);

    expect(closeFns.get(first)).toHaveBeenCalledOnce();
    expect(closeFns.get(second)).not.toHaveBeenCalled();

    callbacks.get(second)("rename", second);
    vi.advanceTimersByTime(60);
  });

  it("returns false and leaves no state when low-level watch creation fails", () => {
    const target = path.resolve("/tmp/a.txt");
    const registry = createFileWatchRegistry({
      watch: vi.fn(() => { throw new Error("watch failed"); }),
      notifySubscriber: () => {},
    });

    expect(registry.watchFile(target, 1)).toBe(false);
    expect(registry.unwatchFile(target, 1)).toBe(true);
  });

  it("keeps notifying the same file after atomic replacement", async () => {
    vi.useRealTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-file-watch-"));
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "one\n", "utf-8");

    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const changes = [];
    const registry = createFileWatchRegistry({
      debounceMs: 5,
      watch: (targetPath, options, onChange) => {
        const watcher = createStableFileWatcher(targetPath, options, onChange);
        watcher.on("ready", readyResolve);
        watcher.on("error", readyReject);
        return watcher;
      },
      notifySubscriber: (_subscriberId, changedPath) => {
        changes.push(fs.readFileSync(changedPath, "utf-8"));
      },
    });

    try {
      expect(registry.watchFile(filePath, 1)).toBe(true);
      await ready;
      await new Promise(resolve => setTimeout(resolve, 50));

      fs.writeFileSync(filePath, "two\n", "utf-8");
      await vi.waitFor(() => expect(changes).toContain("two\n"));

      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, "three\n", "utf-8");
      fs.renameSync(tmpPath, filePath);
      await vi.waitFor(() => expect(changes).toContain("three\n"));

      fs.writeFileSync(filePath, "four\n", "utf-8");
      await vi.waitFor(() => expect(changes).toContain("four\n"));
    } finally {
      registry.unwatchFile(filePath, 1);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
