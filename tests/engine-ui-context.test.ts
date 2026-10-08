// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GsapEngine } from "../core/engine.ts";

/**
 * 轻量测试：只校验 setUiContext / getUiContext 的 Map 行为。
 * 不实例化 HanaEngine（依赖过多），用原型方法 + 手工 fake this 测试。
 */

function makeFakeEngine() {
  const fake: any = {
    _uiContextBySession: new Map(),
    _imageStripNotified: new Set(),
    _videoStripNotified: new Set(),
    _currentTurnNativeMedia: { clearSession: vi.fn() },
    _sessionFiles: { unloadSession: vi.fn() },
    _computerHost: { abortSession: vi.fn() },
  };
  fake.setUiContext = GsapEngine.prototype.setUiContext;
  fake.getUiContext = GsapEngine.prototype.getUiContext;
  fake.clearSessionRuntimeState = GsapEngine.prototype.clearSessionRuntimeState;
  fake.getSessionIdForPath = vi.fn(() => null);
  fake._runtimeSessionKey = GsapEngine.prototype._runtimeSessionKey;
  fake._sessionRefForPath = GsapEngine.prototype._sessionRefForPath;
  return fake;
}

describe("HanaEngine uiContext", () => {
  let engine;

  beforeEach(() => {
    engine = makeFakeEngine();
  });

  it("getUiContext 初始返回 null", () => {
    expect(engine.getUiContext("/s/a")).toBeNull();
  });

  it("setUiContext 存入后 getUiContext 返回同一对象", () => {
    const ctx = { currentViewed: "/root", activeFile: "/root/a.md", pinnedFiles: [] };
    engine.setUiContext("/s/a", ctx);
    expect(engine.getUiContext("/s/a")).toEqual(ctx);
  });

  it("setUiContext(path, null) 显式清空", () => {
    engine.setUiContext("/s/a", { currentViewed: "/root" });
    engine.setUiContext("/s/a", null);
    expect(engine.getUiContext("/s/a")).toBeNull();
  });

  it("setUiContext(path, undefined) 等价于清空", () => {
    engine.setUiContext("/s/a", { currentViewed: "/root" });
    engine.setUiContext("/s/a", undefined);
    expect(engine.getUiContext("/s/a")).toBeNull();
  });

  it("不同 sessionPath 相互隔离", () => {
    engine.setUiContext("/s/a", { activeFile: "/a" });
    engine.setUiContext("/s/b", { activeFile: "/b" });
    expect(engine.getUiContext("/s/a").activeFile).toBe("/a");
    expect(engine.getUiContext("/s/b").activeFile).toBe("/b");
  });

  it("sessionPath 为 falsy 时 set/get 为 no-op / null", () => {
    engine.setUiContext("", { activeFile: "/x" });
    engine.setUiContext(null, { activeFile: "/y" });
    engine.setUiContext(undefined, { activeFile: "/z" });
    expect(engine.getUiContext("")).toBeNull();
    expect(engine.getUiContext(null)).toBeNull();
    expect(engine.getUiContext(undefined)).toBeNull();
    expect(engine._uiContextBySession.size).toBe(0);
  });

  it("重复 setUiContext 覆盖旧值", () => {
    engine.setUiContext("/s/a", { activeFile: "/old" });
    engine.setUiContext("/s/a", { activeFile: "/new" });
    expect(engine.getUiContext("/s/a").activeFile).toBe("/new");
  });

  it("clearSessionRuntimeState removes only runtime caches for the discarded session", () => {
    engine.setUiContext("/s/a", { activeFile: "/a" });
    engine.setUiContext("/s/b", { activeFile: "/b" });
    engine._imageStripNotified.add("/s/a");
    engine._imageStripNotified.add("/s/b");
    engine._videoStripNotified.add("/s/a");
    engine._videoStripNotified.add("/s/b");

    engine.clearSessionRuntimeState("/s/a", "archive");

    expect(engine.getUiContext("/s/a")).toBeNull();
    expect(engine.getUiContext("/s/b")).toEqual({ activeFile: "/b" });
    expect(engine._imageStripNotified.has("/s/a")).toBe(false);
    expect(engine._imageStripNotified.has("/s/b")).toBe(true);
    expect(engine._videoStripNotified.has("/s/a")).toBe(false);
    expect(engine._videoStripNotified.has("/s/b")).toBe(true);
    expect(engine._currentTurnNativeMedia.clearSession).toHaveBeenCalledWith({
      sessionId: null,
      sessionPath: "/s/a",
    });
    expect(engine._sessionFiles.unloadSession).toHaveBeenCalledWith("/s/a");
    expect(engine._computerHost.abortSession).toHaveBeenCalledWith("/s/a");
  });
});
