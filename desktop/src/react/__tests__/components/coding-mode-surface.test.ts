import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const PROJECT_ROOT = path.resolve(ROOT, '../../..');

function readReact(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readRoot(rel: string) {
  return fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
}

describe('removed Coding Mode surface contract', () => {
  it('keeps chat in the sidebar and removes the titlebar page menu and reader mode', () => {
    const app = readReact('App.tsx');

    expect(app).toContain('<span>聊天</span>');
    expect(app).not.toContain('HomeNavigationMenus');
    expect(fs.existsSync(path.join(ROOT, 'components/HomeNavigationMenus.tsx'))).toBe(false);
    expect(app).not.toContain('ReaderSurface');
    expect(app).not.toContain('readerMode');
    expect(app).not.toContain('CodiaIdeSurface');
    expect(app).not.toContain('codingMode');
  });

  it('does not ship Coding Mode React surfaces or VS Code runtime packaging', () => {
    const pkg = JSON.parse(readRoot('package.json'));

    expect(fs.existsSync(path.join(ROOT, 'components/CodiaIdeSurface.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'components/coding'))).toBe(false);
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'desktop/vscode-runtime.cjs'))).toBe(false);
    expect(pkg.scripts['prepare:vscode-runtime']).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toContain('vscode-main');
    expect(JSON.stringify(pkg)).not.toContain('vscode-1.125.0');
  });

  it('does not keep Coding Mode assistant context plumbing in the chat input', () => {
    const inputArea = readReact('components/InputArea.tsx');

    expect(inputArea).not.toContain('codingContext?: string | null');
    expect(inputArea).not.toContain('mergeCodingContextForPrompt');
    expect(inputArea).not.toContain('normalizeCodingContext');
  });

  it('removes VS Code extension IPC and keeps plugin marketplace on the main plugin system', () => {
    const pluginMarketplace = readReact('settings/tabs/PluginMarketplaceTab.tsx');
    const pluginsTab = readReact('settings/tabs/PluginsTab.tsx');
    const preload = readRoot('desktop/preload.cjs');
    const main = readRoot('desktop/main.cjs');

    expect(preload).not.toContain('searchVscodeExtensions:');
    expect(preload).not.toContain('installVscodeExtension:');
    expect(preload).not.toContain('onVscodeExtensionInstallProgress:');
    expect(main).not.toContain('search-vscode-extensions');
    expect(main).not.toContain('install-vscode-extension');

    expect(pluginMarketplace).not.toContain('vscodeDeclarative');
    expect(pluginMarketplace).not.toContain('vscodeOnly');
    expect(pluginsTab).toContain('settings.plugins.manageEntryTitle');
  });

  it('does not keep Coding Mode or VS Code workbench CSS selectors', () => {
    const css = readRoot('desktop/src/styles.css');

    expect(css).not.toContain('body.coding-mode');
    expect(css).not.toContain('.codia-coding-surface');
    expect(css).not.toContain('.vscode-workbench-host');
    expect(css).not.toContain('.coding-extension-panel');
  });
});
