import { describe, expect, it, vi } from "vitest";
import { GsapEngine } from "../core/engine.js";

function makeFactory(name) {
  return Object.assign(() => {}, { _testName: name });
}

function names(factories) {
  return factories.map((factory) => factory._testName);
}

function makeEngine({ pluginFactories = [] } = {}) {
  const engine = Object.create(GsapEngine.prototype);
  engine._coreExtensionFactories = [
    makeFactory("core-provider"),
    makeFactory("core-image"),
  ];
  engine._frameworkExtFactories = [];
  engine._extensionFactories = [...engine._coreExtensionFactories];
  engine._baseExtensionFactoryCount = engine._coreExtensionFactories.length;
  engine._pluginManager = {
    getExtensionFactories: vi.fn(() => pluginFactories),
  };
  engine._resourceLoader = {
    reload: vi.fn().mockResolvedValue(undefined),
  };
  engine._sessionCoord = null;
  return engine;
}

describe("GsapEngine extension factories", () => {
  it("reloads ResourceLoader after plugin extension factories are synced", async () => {
    const engine = makeEngine({
      pluginFactories: [makeFactory("plugin-a")],
    });

    await engine.syncPluginExtensions();

    expect(names(engine._extensionFactories)).toEqual([
      "core-provider",
      "core-image",
      "plugin-a",
    ]);
    expect(engine._resourceLoader.reload).toHaveBeenCalledTimes(1);
  });

  it("keeps all core factories when framework factories are registered later", async () => {
    const engine = makeEngine({
      pluginFactories: [makeFactory("plugin-a")],
    });
    const frameworkFactory = makeFactory("framework-deferred");

    await engine.registerExtensionFactory(frameworkFactory);

    expect(names(engine._extensionFactories)).toEqual([
      "core-provider",
      "core-image",
      "framework-deferred",
      "plugin-a",
    ]);
    expect(engine._resourceLoader.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads idle live sessions after plugin extension factories change", async () => {
    const engine = makeEngine({
      pluginFactories: [makeFactory("plugin-a")],
    });
    engine._sessionCoord = {
      reloadExtensionRunners: vi.fn().mockResolvedValue({ reloaded: 1, skipped: 0, failed: 0 }),
    };

    await engine.syncPluginExtensions();

    expect(engine._sessionCoord.reloadExtensionRunners).toHaveBeenCalledWith("plugin_extension_sync");
  });
});
