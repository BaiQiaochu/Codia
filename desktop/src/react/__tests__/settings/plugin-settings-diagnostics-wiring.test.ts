import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('plugin settings diagnostics wiring', () => {
  it('keeps plugin config diagnostics controls in the plugin settings tab', () => {
    const pluginsTab = read('settings/tabs/PluginsTab.tsx');

    expect(pluginsTab).toContain('settings.plugins.manageEntryTitle');
    expect(pluginsTab).toContain('settings.plugins.manageEntryDesc');
    expect(pluginsTab).not.toContain('const openMarketplace = useCallback');
    expect(pluginsTab).not.toContain("openSettingsModal('plugin-marketplace')");
    expect(pluginsTab).toContain("codiaFetch('/api/plugins')");
    expect(pluginsTab).toContain("plugin.source === 'builtin'");
    expect(pluginsTab).toContain("settings.skills.builtinBadge");
    expect(pluginsTab).toContain('/api/plugins/diagnostics');
    expect(pluginsTab).toContain('/api/plugins/${encodeURIComponent(configPlugin.id)}/config');
    expect(pluginsTab).toContain("plugin.contributions?.includes('configuration')");
    expect(pluginsTab).toContain('settings.plugins.showDiagnostics');
    expect(pluginsTab).toContain('settings.plugins.configure');
  });

  it('keeps only Codia plugin marketplace controls in settings', () => {
    const marketplaceTab = read('settings/tabs/PluginMarketplaceTab.tsx');
    const preload = fs.readFileSync(path.join(process.cwd(), 'desktop/preload.cjs'), 'utf8');

    expect(marketplaceTab).toContain('/api/plugins/marketplace');
    expect(marketplaceTab).toContain('/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/install');
    expect(marketplaceTab).not.toContain('data-plugin-marketplace-search');
    expect(marketplaceTab).not.toContain('/api/plugins/marketplace/search');
    expect(marketplaceTab).not.toContain('/api/plugins/marketplace/install');
    expect(marketplaceTab).not.toContain('vscodeDeclarative');
    expect(fs.existsSync(path.join(ROOT, 'components/coding'))).toBe(false);
    expect(preload).not.toContain('searchVscodeExtensions');
    expect(preload).not.toContain('installVscodeExtension');
    expect(preload).not.toContain('onVscodeExtensionInstallProgress');
  });
});
