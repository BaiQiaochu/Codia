import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function extractRule(css: string, selector: string): string {
  const escaped = selector
    .split(/\r?\n/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  return match?.[1] || '';
}

describe('titlebar drag region', () => {
  it('keeps the frameless main window titlebar draggable while controls remain clickable', () => {
    const css = read('../../src/styles.css');
    const titlebar = extractRule(css, '.titlebar');
    const winTitlebar = extractRule(css, 'html[data-platform="win32"] .titlebar,\nhtml[data-platform="linux"] .titlebar');
    const titlebarGroups = extractRule(css, '.tb-left-group,\n.tb-right-group');
    const toggle = extractRule(css, '.tb-toggle');
    const windowControls = extractRule(css, '.window-controls');

    expect(titlebar).toContain('-webkit-app-region: drag');
    expect(titlebar).toContain('position: relative');
    expect(titlebar).not.toContain('position: fixed');
    expect(titlebar).toContain('pointer-events: auto');
    expect(titlebar).not.toContain('pointer-events: none');
    expect(titlebarGroups).toContain('-webkit-app-region: drag');
    expect(titlebarGroups).not.toContain('-webkit-app-region: no-drag');
    expect(toggle).toContain('-webkit-app-region: no-drag');
    expect(windowControls).toContain('-webkit-app-region: no-drag');
    expect(winTitlebar).toContain('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) var(--window-controls-w)');
    expect(winTitlebar).toContain('padding-right: 0');
    expect(windowControls).toContain('position: static');
    expect(windowControls).toContain('grid-column: 4');
  });

  it('keeps titlebar in document flow so content surfaces do not double-offset', () => {
    const css = read('../../src/styles.css');
    const app = read('App.tsx');
    const previewCss = read('components/Preview.module.css');
    const pluginCss = read('components/plugin/PluginPageView.module.css');
    const computerUseCss = read('components/ComputerUseOverlay.module.css');
    const channelsCss = read('components/channels/Channels.module.css');

    expect(app).toContain('className="app-shell"');
    expect(extractRule(css, '.app-shell')).toContain('flex-direction: column');
    expect(extractRule(css, '.app')).toContain('flex: 1');
    expect(previewCss).not.toContain('padding-top: var(--titlebar-h)');
    expect(previewCss).not.toContain('padding-top: 48px');
    expect(pluginCss).not.toContain('padding-top: 44px');
    expect(computerUseCss).toContain('inset: 0');
    expect(channelsCss).not.toContain('padding-top: 60px');
  });

  it('draws only short themed corner borders around the main window', () => {
    const css = read('../../src/styles.css');
    const root = extractRule(css, ':root');
    const shell = extractRule(css, '.app-shell');
    const cornerLayer = extractRule(css, '.app-shell::before');

    expect(root).toContain('--window-corner-border-size: 88px');
    expect(root).toContain('--window-corner-border-width: 1px');
    expect(root).toContain('--window-corner-border-color: color-mix(in srgb, var(--chrome-border) 78%, transparent)');
    expect(shell).toContain('position: relative');
    expect(cornerLayer).toContain('position: fixed');
    expect(cornerLayer).toContain('pointer-events: none');
    expect(cornerLayer).toContain('top left / var(--window-corner-border-size) var(--window-corner-border-width) no-repeat');
    expect(cornerLayer).toContain('top right / var(--window-corner-border-width) var(--window-corner-border-size) no-repeat');
    expect(cornerLayer).toContain('bottom left / var(--window-corner-border-width) var(--window-corner-border-size) no-repeat');
    expect(cornerLayer).toContain('bottom right / var(--window-corner-border-size) var(--window-corner-border-width) no-repeat');
    expect(cornerLayer).not.toContain('border:');
  });

  it('keeps titlebar tabs and widget buttons out of the drag region', () => {
    const tabsCss = read('components/channels/Channels.module.css');
    const widgetCss = read('components/plugin/WidgetButtons.module.css');

    expect(extractRule(tabsCss, '.tbTabs')).toContain('-webkit-app-region: no-drag');
    expect(extractRule(widgetCss, '.container')).toContain('-webkit-app-region: no-drag');
  });

  it('keeps global toasts below the frameless titlebar', () => {
    const css = read('../../src/styles.css');
    const toast = extractRule(css, '.gsap-toast');

    expect(toast).toContain('top: calc(var(--titlebar-h) + 12px)');
    expect(toast).not.toContain('top: 40px');
  });
});
