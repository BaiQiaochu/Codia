// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "../core/plugin-manager.js";
import { PluginDevService } from "../core/plugin-dev-service.js";

function makeBus() {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    request: vi.fn(),
    hasHandler: vi.fn(() => false),
    listCapabilities: vi.fn(() => []),
    getCapability: vi.fn(() => null),
  };
}

function writeDevPlugin(root, id, options = {}) {
  const pluginDir = path.join(root, id);
  fs.mkdirSync(path.join(pluginDir, "tools"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    id,
    name: options.name || id,
    version: options.version || "0.1.0",
    ...(options.trust ? { trust: options.trust } : {}),
    ...(options.manifest || {}),
  }, null, 2));
  fs.writeFileSync(path.join(pluginDir, "tools", "echo.js"), `
    export const name = "echo";
    export const description = "Echo input text";
    export async function execute(params) {
      return ${JSON.stringify(options.prefix || "Echo")} + " " + params.text;
    }
  `);
  return pluginDir;
}

describe("PluginDevService", () => {
  let tmpDir;
  let sourceRoot;
  let devPluginsDir;
  let runDataDir;
  let pluginManager;
  let syncPluginExtensions;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-plugin-dev-"));
    sourceRoot = path.join(tmpDir, "sources");
    devPluginsDir = path.join(tmpDir, "codia-home", "plugins-dev");
    runDataDir = path.join(tmpDir, "codia-home", "plugin-dev-runs");
    fs.mkdirSync(sourceRoot, { recursive: true });
    syncPluginExtensions = vi.fn();
    pluginManager = new PluginManager({
      pluginsDirs: [devPluginsDir],
      dataDir: path.join(tmpDir, "codia-home", "plugin-data"),
      bus: makeBus(),
      preferencesManager: {
        getDisabledPlugins: () => [],
        setDisabledPlugins: vi.fn(),
        getAllowFullAccessPlugins: () => false,
      },
    });
    service = new PluginDevService({
      pluginManager,
      devPluginsDir,
      runDataDir,
      allowedSourceRoots: [sourceRoot],
      syncPluginExtensions,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("installs an allowed source as a dev plugin and invokes its tool", async () => {
    const sourcePath = writeDevPlugin(sourceRoot, "dev-echo", { prefix: "Echo" });

    const install = await service.installFromSource({ sourcePath });
    const invocation = await service.invokeTool({
      pluginId: "dev-echo",
      toolName: "echo",
      input: { text: "hi" },
      sessionPath: "/tmp/session.jsonl",
    });

    expect(install.plugin).toMatchObject({
      id: "dev-echo",
      source: "dev",
      status: "loaded",
    });
    expect(fs.existsSync(path.join(devPluginsDir, "dev-echo", "manifest.json"))).toBe(true);
    expect(syncPluginExtensions).toHaveBeenCalledTimes(1);
    expect(invocation.toolName).toBe("dev-echo_echo");
    expect(invocation.result.content[0].text).toBe("Echo hi");
  });

  it("keeps dev plugin enablement out of normal plugin preferences", async () => {
    const sourcePath = writeDevPlugin(sourceRoot, "dev-life", { prefix: "Life" });
    const install = await service.installFromSource({ sourcePath });

    const disabled = await service.disablePlugin("dev-life");
    const enabled = await service.enablePlugin("dev-life", { devRunId: install.devRunId });
    const removed = await service.uninstallPlugin("dev-life", { devRunId: install.devRunId });

    expect(disabled.plugin).toMatchObject({ id: "dev-life", status: "disabled", source: "dev" });
    expect(enabled.plugin).toMatchObject({ id: "dev-life", status: "loaded", source: "dev" });
    expect(removed).toMatchObject({ ok: true, pluginId: "dev-life" });
    expect(pluginManager.getPlugin("dev-life")).toBeNull();
  });

  it("rejects source paths outside configured allowed roots", async () => {
    const outsideRoot = path.join(tmpDir, "outside");
    fs.mkdirSync(outsideRoot, { recursive: true });
    const sourcePath = writeDevPlugin(outsideRoot, "outside-dev");

    await expect(service.installFromSource({ sourcePath }))
      .rejects.toMatchObject({ code: "PLUGIN_DEV_SOURCE_OUTSIDE_ALLOWED_ROOTS", status: 403 });
    expect(fs.existsSync(path.join(devPluginsDir, "outside-dev"))).toBe(false);
  });

  it("registers EventBus capabilities for plugin UI debug and scenarios", async () => {
    const { EventBus } = await import("../hub/event-bus.js");
    const eventBus = new EventBus();

    const unregister = service.registerEventBusHandlers(eventBus);

    expect(eventBus.getCapability("plugin.dev.listSurfaces")).toMatchObject({
      type: "plugin.dev.listSurfaces",
      available: true,
      permission: "plugin.dev.read",
    });
    expect(eventBus.getCapability("plugin.dev.describeSurfaceDebug")).toMatchObject({
      type: "plugin.dev.describeSurfaceDebug",
      available: true,
      permission: "plugin.dev.read",
    });
    expect(eventBus.getCapability("plugin.dev.getScenarios")).toMatchObject({
      type: "plugin.dev.getScenarios",
      available: true,
      permission: "plugin.dev.read",
    });
    expect(eventBus.getCapability("plugin.dev.runScenario")).toMatchObject({
      type: "plugin.dev.runScenario",
      available: true,
      permission: "plugin.dev.execute",
      errors: expect.arrayContaining(["NOT_FOUND", "FORBIDDEN"]),
    });
    expect(eventBus.getCapability("plugin.dev.install")).toMatchObject({
      type: "plugin.dev.install",
      errors: expect.arrayContaining(["INVALID_PAYLOAD", "FORBIDDEN"]),
    });

    unregister();
    expect(eventBus.getCapability("plugin.dev.listSurfaces")).toBeNull();
  });

  it("runs manifest dev scenarios with UI surface steps", async () => {
    const sourcePath = writeDevPlugin(sourceRoot, "surface-scenario-dev", {
      trust: "full-access",
      manifest: {
        contributes: {
          page: { title: "Surface Dev", route: "/page" },
        },
        dev: {
          scenarios: [{
            id: "open-page",
            title: "Open page",
            steps: [{ openSurface: "/page" }],
          }],
        },
      },
    });
    fs.mkdirSync(path.join(sourcePath, "routes"), { recursive: true });
    await service.installFromSource({ sourcePath, allowFullAccess: true });

    const result = await service.runScenario({
      pluginId: "surface-scenario-dev",
      scenarioId: "open-page",
    });

    expect(result).toMatchObject({
      pluginId: "surface-scenario-dev",
      scenarioId: "open-page",
      status: "passed",
      steps: [{
        index: 0,
        type: "openSurface",
        status: "passed",
        surface: expect.objectContaining({
          kind: "page",
          route: "/page",
          routeUrl: "/api/plugins/surface-scenario-dev/page",
        }),
        debug: expect.objectContaining({
          strategy: "element-first",
        }),
      }],
    });
  });

  it("rejects dev operations when the remembered target directory leaves the dev root", async () => {
    const sourcePath = writeDevPlugin(sourceRoot, "slot-guard-dev");
    await service.installFromSource({ sourcePath });
    const slot = service._slots.get("slot-guard-dev");
    slot.targetDir = path.join(tmpDir, "outside-target");

    await expect(service.disablePlugin("slot-guard-dev"))
      .rejects.toMatchObject({ code: "PLUGIN_DEV_SLOT_OUTSIDE_DEV_DIR", status: 403 });
  });
});
