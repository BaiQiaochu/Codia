// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "../core/plugin-manager.js";

let tmpHome;
let pluginsDir;
let dataDir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-pm-automation-"));
  pluginsDir = path.join(tmpHome, "plugins");
  dataDir = path.join(tmpHome, "plugin-data");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function makeBus() {
  const { EventBus } = await import("../hub/event-bus.js");
  return new EventBus();
}

describe("PluginManager automation tool context", () => {
  it("prefers explicit runtime sessionPath over focus fallback for plugin tools", async () => {
    const dir = path.join(pluginsDir, "session-path-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "scope.js"), `
      export const name = "scope";
      export const description = "Return session path";
      export const parameters = {};
      export async function execute(_input, ctx) {
        return ctx.sessionPath || "";
      }
    `);
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      getSessionPath: () => "/sessions/focus.jsonl",
    });
    pm.scan();
    await pm.loadAll();

    const tool = pm.getAllTools()[0];
    const result = await tool.execute("call-1", {}, {
      sessionPath: "/sessions/bridge-owner.jsonl",
    });

    expect(result.content[0].text).toBe("/sessions/bridge-owner.jsonl");
  });

  it("uses the Pi SDK fifth argument session ctx for static plugin tools", async () => {
    const dir = path.join(pluginsDir, "pi-context-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "scope.js"), `
      export const name = "scope";
      export const description = "Return session path";
      export const parameters = {};
      export async function execute(_input, ctx) {
        return ctx.sessionPath || "";
      }
    `);
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
    });
    pm.scan();
    await pm.loadAll();

    const tool = pm.getAllTools()[0];
    const result = await tool.execute("call-1", {}, new AbortController().signal, vi.fn(), {
      sessionManager: { getSessionFile: () => "/sessions/pi-context.jsonl" },
    });

    expect(result.content[0].text).toBe("/sessions/pi-context.jsonl");
  });

  it("invokes static plugin tools through the unified automation adapter", async () => {
    const dir = path.join(pluginsDir, "static-invoke");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "echo.js"), `
      export const name = "echo";
      export const description = "Echo text";
      export const parameters = {};
      export async function execute(input, ctx) {
        return (ctx.sessionPath || "") + ":" + input.text;
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();

    const tool = pm.getPluginTool("static-invoke", "echo");
    const result = await pm.executePluginTool(tool, {
      toolCallId: "call-static",
      input: { text: "hello" },
      runtimeCtx: { sessionPath: "/sessions/static.jsonl" },
    });

    expect(result.content[0].text).toBe("/sessions/static.jsonl:hello");
  });

  it("finds plugin tools when the action id contains underscores or is already prefixed", async () => {
    const dir = path.join(pluginsDir, "underscore-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "create-note.js"), `
      export const name = "create_note";
      export const description = "Create note";
      export const parameters = {};
      export async function execute(input) {
        return input.title;
      }
    `);
    fs.writeFileSync(path.join(dir, "tools", "archive.js"), `
      export const name = "underscore-plugin_archive";
      export const description = "Archive note";
      export const parameters = {};
      export async function execute(input) {
        return input.title;
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();

    expect(pm.getPluginTool("underscore-plugin", "create_note")?.name)
      .toBe("underscore-plugin_create_note");
    expect(pm.getPluginTool("underscore-plugin", "underscore-plugin_create_note")?.name)
      .toBe("underscore-plugin_create_note");
    expect(pm.getPluginTool("underscore-plugin", "underscore-plugin_archive")?.name)
      .toBe("underscore-plugin_underscore-plugin_archive");
  });
});
