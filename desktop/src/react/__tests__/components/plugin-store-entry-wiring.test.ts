import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('plugin store entry wiring', () => {
  it('keeps Codia plugin management inside settings instead of the app chrome', () => {
    const app = read('App.tsx');
    const pluginsTab = read('settings/tabs/PluginsTab.tsx');
    const settingsContent = read('settings/SettingsContent.tsx');

    expect(app).not.toContain('id="tbPluginStore"');
    expect(app).not.toContain('id="pluginStoreBar"');
    expect(app).not.toContain('openPluginStore');

    expect(pluginsTab).toContain('settings.plugins.manageEntryTitle');
    expect(pluginsTab).toContain('settings.plugins.manageEntryDesc');
    expect(pluginsTab).not.toContain('const openMarketplace = useCallback');
    expect(pluginsTab).not.toContain("openSettingsModal('plugin-marketplace')");
    expect(settingsContent).toContain('PluginMarketplaceTab');
    expect(settingsContent).toContain("'plugin-marketplace': PluginMarketplaceTab");
  });

  it('does not expose VS Code extension install or Coding Mode plugin panels', () => {
    const marketplaceTab = read('settings/tabs/PluginMarketplaceTab.tsx');
    const preload = fs.readFileSync(path.join(process.cwd(), 'desktop/preload.cjs'), 'utf8');

    expect(marketplaceTab).toContain('/api/plugins/marketplace');
    expect(marketplaceTab).not.toContain('/api/plugins/marketplace/search');
    expect(marketplaceTab).not.toContain('/api/plugins/marketplace/install');
    expect(marketplaceTab).not.toContain('data-plugin-marketplace-search');
    expect(marketplaceTab).not.toContain('vscodeDeclarative');
    expect(fs.existsSync(path.join(ROOT, 'components/coding'))).toBe(false);
    expect(preload).not.toContain('searchVscodeExtensions');
    expect(preload).not.toContain('installVscodeExtension');
    expect(preload).not.toContain('onVscodeExtensionInstallProgress');
  });
});
