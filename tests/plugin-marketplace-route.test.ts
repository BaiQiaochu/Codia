// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";

const extractZipMock = vi.fn(async (_zipPath, destDir) => {
  const extensionDir = path.join(destDir, "extension");
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, "package.json"), JSON.stringify({
    publisher: "pub",
    name: "theme-demo",
    displayName: "Theme Demo",
    version: "1.2.3",
    engines: { vscode: "^1.80.0" },
    contributes: {
      commands: [{ command: "demo.hello", title: "Hello Demo" }],
    },
  }), "utf-8");
});

vi.mock("../lib/extract-zip.js", () => ({
  extractZip: (...args) => extractZipMock(...args),
}));

const { createPluginsRoute } = await import("../server/routes/plugins.js");

function createApp(engine = { pluginManager: null }) {
  const app = new Hono();
  app.route("/api", createPluginsRoute(engine));
  return app;
}

describe("plugin marketplace route", () => {
  const tempRoots = [];

  afterEach(() => {
    vi.restoreAllMocks();
    extractZipMock.mockClear();
    while (tempRoots.length > 0) {
      fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
    }
  });

  it("maps VS Code Marketplace results as declarative-compatible extensions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{
          extensions: [{
            extensionName: "theme-demo",
            displayName: "Theme Demo",
            shortDescription: "A VS Code theme",
            publisher: { publisherName: "pub" },
            tags: ["theme"],
            categories: ["Themes"],
            versions: [{
              version: "1.2.3",
              files: [{ assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/pub/vsextensions/theme-demo/1.2.3/vspackage" }],
            }],
          }],
        }],
      }),
    })));

    const res = await createApp().request("/api/plugins/marketplace/search?q=theme");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0]).toMatchObject({
      id: "pub.theme-demo",
      displayName: "Theme Demo",
      version: "1.2.3",
      compatibility: { kind: "vscode-extension", installable: true, runtime: "declarative-compat" },
    });
    expect(body.items[0].compatibility.reason).toMatch(/generated compatibility page/i);
  });

  it("marks Marketplace entries with Codia compatibility metadata as installable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{
          extensions: [{
            extensionName: "tools",
            displayName: "Codia Tools",
            shortDescription: "Tools",
            publisher: { publisherName: "codia" },
            tags: ["codia-plugin"],
            versions: [{ version: "0.1.0", files: [] }],
          }],
        }],
      }),
    })));

    const res = await createApp().request("/api/plugins/marketplace/search?q=codia");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].compatibility).toMatchObject({ kind: "codia-plugin", installable: true });
  });

  it("rejects marketplace entries that are not installable", async () => {
    const engine = {
      pluginManager: { getUserPluginsDir: () => "/tmp/plugins" },
    };
    const res = await createApp(engine).request("/api/plugins/marketplace/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installUrl: "https://marketplace.visualstudio.com/demo.vsix",
        compatibility: { installable: false },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/installable/i);
  });

  it("accepts VS Code Marketplace CDN download URLs before fetching the package", async () => {
    const engine = {
      pluginManager: { getUserPluginsDir: () => "/tmp/plugins" },
      fetch: vi.fn(async () => ({
        ok: false,
        status: 418,
      })),
    };

    const res = await createApp(engine).request("/api/plugins/marketplace/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installUrl: "https://vscode.download.prss.microsoft.com/dbazure/download/stable/demo/plugin.vsix",
        compatibility: { installable: true, kind: "vscode-extension" },
      }),
    });

    expect(res.status).toBe(502);
    expect(engine.fetch).toHaveBeenCalledWith(
      "https://vscode.download.prss.microsoft.com/dbazure/download/stable/demo/plugin.vsix",
      expect.objectContaining({ headers: { "User-Agent": "CODIA Plugin Store" } }),
    );
  });

  it("installs VS Code Marketplace extensions through the declarative compatibility layer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-marketplace-route-"));
    tempRoots.push(root);
    const pluginsDir = path.join(root, "plugins");
    let installedDir = null;
    const engine = {
      fetch: vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => Buffer.from("fake vsix").buffer,
      })),
      syncPluginExtensions: vi.fn(),
      pluginManager: {
        getUserPluginsDir: () => pluginsDir,
        isValidPluginDir: (dirPath) => fs.existsSync(path.join(dirPath, "manifest.json")),
        installPlugin: vi.fn(async (dirPath) => {
          installedDir = dirPath;
          const manifest = JSON.parse(fs.readFileSync(path.join(dirPath, "manifest.json"), "utf-8"));
          return {
            id: manifest.id,
            name: manifest.name,
            status: "loaded",
            contributions: manifest.contributes,
          };
        }),
      },
    };

    const res = await createApp(engine).request("/api/plugins/marketplace/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installUrl: "https://vscode.download.prss.microsoft.com/dbazure/download/stable/demo/plugin.vsix",
        compatibility: { installable: true, kind: "vscode-extension" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "vscode.pub.theme-demo",
      name: "Theme Demo",
      status: "loaded",
    });
    expect(engine.pluginManager.installPlugin).toHaveBeenCalledTimes(1);
    expect(engine.syncPluginExtensions).toHaveBeenCalledTimes(1);
    expect(installedDir).toBe(path.join(pluginsDir, "vscode-pub.theme-demo"));

    const manifest = JSON.parse(fs.readFileSync(path.join(installedDir, "manifest.json"), "utf-8"));
    expect(manifest.compatibility).toMatchObject({
      kind: "vscode-extension",
      runtime: "declarative-compat",
      vscode: { id: "pub.theme-demo" },
    });
    expect(fs.existsSync(path.join(installedDir, "routes", "codia-vscode-compat.cjs"))).toBe(true);
  });
});
