import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import { createPluginsRoute } from "../server/routes/plugins.js";

const roots = [];

function makePluginDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-plugin-matrix-"));
  roots.push(root);
  const pluginDir = path.join(root, "plugins", "demo");
  fs.mkdirSync(path.join(pluginDir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "ui"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    id: "demo",
    name: "Demo Plugin",
    version: "1.0.0",
    permissions: ["files.read", "resources.read"],
    contributions: ["tools", "pages", "settings"],
  }));
  fs.writeFileSync(path.join(pluginDir, "tools", "demo-tool.js"), "export const name='demo_tool';\n");
  fs.writeFileSync(path.join(pluginDir, "ui", "page.html"), "<main>demo</main>\n");
  return pluginDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("plugin capability matrix route", () => {
  it("reports plugin tools, UI contributions, permissions, size, and enabled state in one matrix", async () => {
    const pluginDir = makePluginDir();
    const app = new Hono();
    app.route("/api", createPluginsRoute({
      pluginManager: {
        listPlugins: () => [{
          id: "demo",
          name: "Demo Plugin",
          version: "1.0.0",
          status: "loaded",
          source: "community",
          trust: "restricted",
          pluginDir,
          manifest: { permissions: ["files.read", "resources.read"], contributions: ["tools", "pages"] },
          contributions: ["tools", "pages"],
        }],
        getDiagnostics: () => [{
          id: "demo",
          tools: [{ name: "demo_tool" }],
          routes: { pages: [{ id: "demo.page" }], widgets: [], settingsTabs: [{ id: "demo.settings" }] },
          config: { keys: ["enabled"] },
        }],
        getAllConfigSchemas: () => [],
        getUserPluginsDir: () => path.dirname(pluginDir),
        getAllowFullAccess: () => false,
      },
    }));

    const res = await app.request("/api/plugins/capability-matrix");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.summary.total).toBe(1);
    expect(data.plugins[0]).toMatchObject({
      id: "demo",
      name: "Demo Plugin",
      status: "loaded",
      enabled: true,
      permissions: ["files.read", "resources.read"],
      tools: ["demo_tool"],
      ui: { pages: 1, widgets: 0, settingsTabs: 1 },
    });
    expect(data.plugins[0].sizeBytes).toBeGreaterThan(0);
  });
});
