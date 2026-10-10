import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('reader mode removal wiring', () => {
  it('uses sidebar destinations and removes the titlebar page menu and reader route', () => {
    const app = read('App.tsx');

    expect(app).not.toContain('HomeNavigationMenus');
    expect(fs.existsSync(path.join(ROOT, 'components/HomeNavigationMenus.tsx'))).toBe(false);
    expect(app).toContain('<span>聊天</span>');
    expect(app).toContain('<span>Agent 小队</span>');
    expect(app).toContain('<span>工作流</span>');
    expect(app).not.toContain('ReaderSurface');
    expect(app).not.toContain('readerMode');
    expect(app).not.toContain("setAppViewMode('coding')");
    expect(app).not.toContain("t('appMode.coding')");
    expect(app).not.toContain('codingMode');
    expect(app).not.toContain('titlebar-ide-mode');
    expect(app).not.toContain('data-codia-ide-status-entry');
  });

  it('keeps files in the persistent right workspace without a duplicate sidebar destination', () => {
    const app = read('App.tsx');
    const workspace = read('components/right-workspace/RightWorkspacePanel.tsx');

    expect(app).not.toContain('<span>文件与项目</span>');
    expect(app).toContain('toggleJianSidebar()');
    expect(workspace).toContain('rightWorkspaceLayout openFilesOnSingleClick');
    expect(fs.existsSync(path.join(ROOT, 'components/ReaderSurface.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'components/ObsidianSessionHistory.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'components/CodiaIdeSurface.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'components/coding'))).toBe(false);
  });

  it('removes VS Code runtime IPC and packaging from the desktop app', () => {
    const preload = fs.readFileSync(path.join(process.cwd(), 'desktop/preload.cjs'), 'utf8');
    const main = fs.readFileSync(path.join(process.cwd(), 'desktop/main.cjs'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

    expect(preload).not.toContain('getVscodeIdeStatus');
    expect(preload).not.toContain('mountVscodeIdeWorkbench');
    expect(preload).not.toContain('searchVscodeExtensions');
    expect(preload).not.toContain('installVscodeExtension');
    expect(main).not.toContain('createVscodeRuntimeService');
    expect(main).not.toContain('get-vscode-ide-status');
    expect(main).not.toContain('mount-vscode-ide-workbench');
    expect(main).not.toContain('search-vscode-extensions');
    expect(main).not.toContain('install-vscode-extension');
    expect(pkg.scripts['prepare:vscode-runtime']).toBeUndefined();
    expect(JSON.stringify(pkg.build.extraResources)).not.toContain('vscode-main');
    expect(JSON.stringify(pkg.build.files)).not.toContain('desktop/vscode-runtime.cjs');
  });

  it('hides the native Electron menu so application chrome owns the window surface', () => {
    const main = fs.readFileSync(path.join(process.cwd(), 'desktop/main.cjs'), 'utf8');

    expect(main).toContain('mainWindow.setAutoHideMenuBar(true)');
    expect(main).toContain('mainWindow.setMenuBarVisibility(false)');
    expect(main).toContain('mainWindow.removeMenu()');
    expect(main).toContain('Menu.setApplicationMenu(null)');
  });
});
