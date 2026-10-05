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

describe('removed VS Code coding surface contract', () => {
  it('does not render or import the VS Code coding surface', () => {
    const app = readReact('App.tsx');

    expect(app).not.toContain('GsapIdeSurface');
    expect(app).not.toContain('codingMode');
    expect(app).not.toContain('titlebar-ide-mode');
    expect(app).not.toContain('data-gsap-ide-status-entry');
    expect(app).not.toContain("t('appMode.codingWorkspace')");
    expect(app).not.toContain('<BottomConsole');
    expect(fs.existsSync(path.join(ROOT, 'components/GsapIdeSurface.tsx'))).toBe(false);
  });

  it('keeps the standard application chrome only', () => {
    const app = readReact('App.tsx');

    expect(app).toContain("const isChatMode = currentTab === 'chat';");
    expect(app).not.toContain('readerMode');
    expect(app).toContain('<WidgetButtons />');
    expect(app).not.toContain('HomeNavigationMenus');
    expect(fs.existsSync(path.join(ROOT, 'components/HomeNavigationMenus.tsx'))).toBe(false);
    expect(app).not.toContain("onClick={() => setAppViewMode('coding')}");
    expect(app).not.toContain('obsidian-ide-menu');
  });

  it('removes VS Code runtime IPC from desktop preload/main/types/package', () => {
    const preload = readRoot('desktop/preload.cjs');
    const main = readRoot('desktop/main.cjs');
    const types = readReact('types.ts');
    const pkg = JSON.parse(readRoot('package.json'));

    expect(preload).not.toContain('getVscodeIdeStatus');
    expect(preload).not.toContain('startVscodeIdeWorkbench');
    expect(preload).not.toContain('mountVscodeIdeWorkbench');
    expect(preload).not.toContain('searchVscodeExtensions');
    expect(preload).not.toContain('installVscodeExtension');
    expect(main).not.toContain('vscode-runtime');
    expect(main).not.toContain('vscode-ide');
    expect(main).not.toContain('start-vscode-ide-workbench');
    expect(main).not.toContain('search-vscode-extensions');
    expect(types).not.toContain('VscodeExtensionItem');
    expect(types).not.toContain('VscodeRuntimeProgress');
    expect(types).not.toContain('searchVscodeExtensions');
    expect(JSON.stringify(pkg.build.extraResources)).not.toContain('vscode-main');
    expect(pkg.scripts['prepare:vscode-runtime']).toBeUndefined();
  });

  it('does not keep VS Code workbench CSS', () => {
    const css = readRoot('desktop/src/styles.css');

    expect(css).not.toContain('.gsap-coding-surface');
    expect(css).not.toContain('.vscode-workbench-shell');
    expect(css).not.toContain('.vscode-workbench-host');
    expect(css).not.toContain('.vscode-embed-placeholder');
  });
});
