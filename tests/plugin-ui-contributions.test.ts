// @ts-nocheck
// tests/plugin-ui-contributions.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PluginManager } from '../core/plugin-manager.js';
import { ensureVsCodeCompatibilityManifest, VSCODE_COMPAT_PAGE_ROUTE } from '../shared/vscode-extension-compat.ts';

function tmpPluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codia-plugin-test-'));
}

function createPluginWithPage(dir, id = 'test-page-plugin') {
  const pluginDir = path.join(dir, id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'routes'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
    id,
    trust: 'full-access',
    contributes: {
      page: {
        title: { zh: '测试', en: 'Test' },
        icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
        route: '/dashboard',
      },
    },
  }));
  fs.writeFileSync(path.join(pluginDir, 'routes', 'dashboard.js'), `
    export default function(app) {
      app.get('/dashboard', (c) => c.text('ok'));
    }
  `);
}

function makePM(communityDir) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-data-'));
  const builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-builtin-'));
  return new PluginManager({
    pluginsDirs: [builtinDir, communityDir],
    dataDir,
    bus: { emit() {}, subscribe() { return () => {}; } },
    preferencesManager: {
      getAllowFullAccessPlugins: () => true,
      getDisabledPlugins: () => [],
    },
  });
}

describe('Plugin UI Contributions', () => {
  let tmpDir;
  let pm;

  beforeEach(() => { tmpDir = tmpPluginDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('loads page contribution from manifest', async () => {
    createPluginWithPage(tmpDir);
    pm = makePM(tmpDir);
    await pm.loadAll();
    const pages = pm.getPages();
    expect(pages).toHaveLength(1);
    expect(pages[0].pluginId).toBe('test-page-plugin');
    expect(pages[0].title).toEqual({ zh: '测试', en: 'Test' });
    expect(pages[0].route).toBe('/dashboard');
  });

  it('ignores page from restricted plugin', async () => {
    const pluginDir = path.join(tmpDir, 'restricted-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
      id: 'restricted-plugin',
      contributes: { page: { title: 'Test', route: '/page' } },
    }));
    fs.writeFileSync(path.join(pluginDir, 'routes', 'page.js'), 'export default function(app) {}');
    pm = makePM(tmpDir);
    await pm.loadAll();
    expect(pm.getPages()).toHaveLength(0);
  });

  it('loads widget contribution from manifest', async () => {
    const pluginDir = path.join(tmpDir, 'widget-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
      id: 'widget-plugin',
      trust: 'full-access',
      contributes: { widget: { title: 'Monitor', icon: null, route: '/sidebar' } },
    }));
    fs.writeFileSync(path.join(pluginDir, 'routes', 'sidebar.js'), 'export default function(app) {}');
    pm = makePM(tmpDir);
    await pm.loadAll();
    const widgets = pm.getWidgets();
    expect(widgets).toHaveLength(1);
    expect(widgets[0].pluginId).toBe('widget-plugin');
    expect(widgets[0].route).toBe('/sidebar');
  });

  it('loads both page and widget when both declared', async () => {
    const pluginDir = path.join(tmpDir, 'both-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
      id: 'both-plugin',
      trust: 'full-access',
      contributes: {
        page: { title: 'Page', route: '/page' },
        widget: { title: 'Widget', route: '/widget' },
      },
    }));
    fs.writeFileSync(path.join(pluginDir, 'routes', 'page.js'), 'export default function(app) {}');
    pm = makePM(tmpDir);
    await pm.loadAll();
    expect(pm.getPages()).toHaveLength(1);
    expect(pm.getWidgets()).toHaveLength(1);
    expect(pm.getPages()[0].pluginId).toBe('both-plugin');
    expect(pm.getWidgets()[0].pluginId).toBe('both-plugin');
  });

  it('loads generated VS Code compatibility page without full-access', async () => {
    const pluginDir = path.join(tmpDir, 'vscode-demo');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
      name: 'demo-icons',
      publisher: 'demo',
      displayName: 'Demo Icons',
      version: '1.0.0',
      engines: { vscode: '^1.80.0' },
      contributes: {
        iconThemes: [{ id: 'demo-icons', label: 'Demo Icons', path: './icons.json' }],
        languages: [{ id: 'demo', aliases: ['Demo'], extensions: ['.demo'] }],
      },
    }));
    fs.mkdirSync(path.join(pluginDir, 'icons'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'icons', 'demo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#42a5f5"/></svg>');
    fs.writeFileSync(path.join(pluginDir, 'icons', 'folder.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 4h14v10H1z" fill="#f6c343"/></svg>');
    fs.writeFileSync(path.join(pluginDir, 'icons.json'), JSON.stringify({
      iconDefinitions: {
        '_file': { iconPath: './icons/demo.svg' },
        '_folder': { iconPath: './icons/folder.svg' },
      },
      fileExtensions: { demo: '_file' },
      fileNames: { 'exact.demo': '_file' },
      folderNames: { src: '_folder' },
      file: '_file',
      folder: '_folder',
    }));
    fs.mkdirSync(path.join(pluginDir, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'routes', 'evil.js'), 'throw new Error("should not load");');

    expect(ensureVsCodeCompatibilityManifest(pluginDir)).toBe(true);

    pm = makePM(tmpDir);
    await pm.loadAll();

    const pages = pm.getPages();
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      pluginId: 'vscode.demo.demo-icons',
      title: 'Demo Icons',
      route: VSCODE_COMPAT_PAGE_ROUTE,
    });

    const app = pm.getRouteApp('vscode.demo.demo-icons');
    expect(app).toBeTruthy();
    const page = await app.request(VSCODE_COMPAT_PAGE_ROUTE);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Demo Icons');

    const ignored = await app.request('/evil');
    expect(ignored.status).toBe(404);

    const themes = pm.getVsCodeFileIconThemes();
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({
      pluginId: 'vscode.demo.demo-icons',
      themeId: 'demo-icons',
      label: 'Demo Icons',
    });
    expect(themes[0].fileExtensions.demo).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(themes[0].fileNames['exact.demo']).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(themes[0].folderNames.src).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});
