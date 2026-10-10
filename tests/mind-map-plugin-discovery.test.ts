// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../hub/event-bus.js";
import { PluginManager } from "../core/plugin-manager.js";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("chat visual plugin discovery", () => {
  it("keeps knowledge graph and mind map as chat tools without standalone pages", async () => {
    const dataDir = makeTempDir("codia-mm-plugin-data-");
    const pm = new PluginManager({
      pluginsDirs: [path.join(process.cwd(), "plugins")],
      dataDir,
      bus: new EventBus(),
    });

    pm.scan();
    await pm.loadAll();

    expect(pm.getPlugin("mind-map")).toEqual(expect.objectContaining({
      status: "loaded",
      hidden: false,
      trust: "full-access",
    }));
    expect(pm.getPlugin("knowledge-graph")).toEqual(expect.objectContaining({
      status: "loaded",
      hidden: false,
      trust: "full-access",
    }));
    expect(pm.getPages().some((page) =>
      page.pluginId === "mind-map" || page.pluginId === "knowledge-graph"
    )).toBe(false);
    expect(pm.getAllTools()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "mind-map_build-mind-map",
        _pluginId: "mind-map",
      }),
      expect.objectContaining({
        name: "knowledge-graph_build-graph",
        _pluginId: "knowledge-graph",
      }),
    ]));

    await pm.unloadPlugin("mind-map");
    await pm.unloadPlugin("knowledge-graph");
  });
});
