import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('plugin marketplace README rendering', () => {
  it('routes README markdown through the sanitized preview renderer', () => {
    const marketplaceTab = read('settings/tabs/PluginMarketplaceTab.tsx');

    expect(marketplaceTab).toContain('renderMarkdownPreview');
    expect(marketplaceTab).not.toContain('renderMarkdown(readmeLoading');
  });

  it('surfaces marketplace trust, permissions, distribution, and compatibility metadata', () => {
    const marketplaceTab = read('settings/tabs/PluginMarketplaceTab.tsx');

    expect(marketplaceTab).toContain('renderPluginTrustPanel');
    expect(marketplaceTab).toContain('selectedPlugin.permissions');
    expect(marketplaceTab).toContain('selectedPlugin.distribution?.sha256');
    expect(marketplaceTab).toContain('selectedPlugin.compatibility?.minAppVersion');
    expect(marketplaceTab).toContain('selectedPlugin.installedVersion');
    expect(marketplaceTab).toContain('data-plugin-marketplace-trust-panel');
  });
});
