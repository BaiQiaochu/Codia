import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function extractRule(css: string, selector: string) {
  const start = css.indexOf(selector);
  if (start < 0) return '';
  const end = css.indexOf('}', start);
  return end < 0 ? css.slice(start) : css.slice(start, end + 1);
}

describe('home shell UI contract', () => {
  it('keeps titlebar tools visible on the standard application chrome', () => {
    const app = read('App.tsx');
    const css = read('../styles.css');

    expect(app).not.toContain('bottomConsoleOpen');
    expect(app).toContain('tb-left-tools');
    expect(app).toContain('tb-right-tools');
    expect(app).toContain('tb-pinned-tools');
    expect(app).toContain('data-titlebar-pinned-tools');
    expect(app).not.toContain('<BottomConsole');
    expect(app).not.toContain('tb-console-toggle');
    expect(app).not.toContain('titlebarToolsCollapsed');
    expect(app).not.toContain('tb-tools-collapsed');
    expect(app).not.toContain('tb-toolbar-collapse');
    expect(app).not.toContain('tb-toggle-settings');
    expect(app).not.toContain('id="tbSettings"');
    expect(app).not.toContain('ideMode');
    expect(app).not.toContain('readerMode');
    expect(app).toContain('<WidgetButtons />');
    expect(app).toContain('WindowControls');
    const pinnedToolsIndex = app.indexOf('data-titlebar-pinned-tools');
    const rightToolsIndex = app.indexOf('className="tb-right-tools"');
    expect(pinnedToolsIndex).toBeGreaterThan(rightToolsIndex);

    expect(css).toContain('--chrome-bg');
    expect(css).toContain('--panel-bg');
    expect(css).not.toContain('.tb-toolbar-collapse');
    expect(css).not.toContain('.tb-tools-collapsed');
    expect(css).toContain('.tb-left-tools');
    expect(css).toContain('.tb-right-tools');
    expect(css).toContain('.tb-pinned-tools');
  });

  it('keeps workspace tools out of the welcome surface so only the composer owns tool selection', () => {
    const welcome = read('components/WelcomeScreen.tsx');
    const css = read('components/Welcome.module.css');

    expect(welcome).toContain('requestInputDraft');
    expect(welcome).not.toContain('PRODUCTIVITY_ACTIONS');
    expect(welcome).not.toContain('activeActionId');
    expect(welcome).not.toContain('setActiveActionId');
    expect(welcome).not.toContain('requestWorkspaceToolSelection');
    expect(welcome).not.toContain('styles.homeActionDetail');
    expect(welcome).not.toContain('data-home-action-detail');
    expect(welcome).not.toContain('styles.homeActionMenuButton');
    expect(welcome).not.toContain('styles.homeActionMenu');
    expect(welcome).not.toContain('role="menu"');
    expect(welcome).not.toContain('role="menuitemradio"');
    expect(welcome).not.toContain('aria-checked={isActive}');
    expect(welcome).not.toContain('setCurrentTab');
    expect(welcome).not.toContain("mode: 'replace'");
    expect(welcome).not.toContain("id: 'research'");
    expect(welcome).not.toContain("id: 'documents'");
    expect(welcome).not.toContain("id: 'meeting'");
    expect(welcome).not.toContain("id: 'selection'");
    expect(welcome).not.toContain("id: 'workflow-market'");
    expect(welcome).not.toContain("id: 'agent-publish'");
    expect(welcome).not.toContain("id: 'media-center'");
    expect(welcome).not.toContain("id: 'provider-debugger'");
    expect(welcome).not.toContain("id: 'browser'");
    expect(welcome).not.toContain("openSettingsModal('diagnostics')");
    expect(welcome).not.toContain("openSettingsModal('media')");
    expect(welcome).not.toContain("openSettingsModal('bridge')");
    expect(welcome).not.toContain('HOME_ACTIONS_COLLAPSED_KEY');
    expect(welcome).not.toContain('styles.homeActionsShell');
    expect(welcome).not.toContain('styles.homeActionsCollapsed');
    expect(welcome).not.toContain('WelcomePromptTitle');
    expect(welcome).not.toContain('styles.welcomeTargetFolder');
    expect(welcome).toContain('applyFolder(folder)');
    expect(welcome).not.toContain('commandMark');
    expect(welcome).not.toContain('Workspace tools');
    expect(welcome).not.toContain('Browser');
    expect(welcome).not.toContain('Terminal');
    expect(welcome).not.toContain('Open a website');
    expect(welcome).not.toContain('Start an interactive shell');
    expect(welcome).not.toContain('openShellTool');
    expect(welcome).not.toContain("detail: { action: 'show-terminal' }");
    expect(welcome).not.toContain('ShellIcon');
    expect(welcome).not.toContain('styles.homeActionCompactButton');
    expect(welcome).not.toContain("const method = 'open' + 'Brows' + 'erViewer'");
    expect(welcome).not.toContain("?.[method]?.()");

    expect(css).not.toContain('.homeActionsShell');
    expect(css).not.toContain('.homeActionsHeader');
    expect(css).not.toContain('.homeActionsCollapsed');
    expect(css).not.toContain('.homeActionCompactButton');
    expect(css).not.toContain('.homeActionMenuButton');
    expect(css).not.toContain('.homeActionMenu');
    expect(css).not.toContain('.homeActionMenuItem');
    expect(css).not.toContain('.homeActionMenuItemActive');
    expect(css).not.toContain('.homeActionCardGrid');
    expect(css).not.toContain('.homeActionDetail');
    expect(css).not.toContain('.homeActionDetailHeader');
    expect(css).not.toContain('.homeActionDetailList');
    expect(css).not.toContain('.commandMark');
    expect(css).not.toContain('.welcomeTitleWithFolder');
    expect(css).not.toContain('.welcomeTargetFolder');
  });

  it('keeps the compact workspace picker and removes the redundant welcome title', () => {
    const welcome = read('components/WelcomeScreen.tsx');

    expect(welcome).toContain('function getFolderDisplayName');
    expect(welcome).toContain("const folderName = folderPath ? getFolderDisplayName(folderPath) : null;");
    expect(welcome).toContain('const targetName = workspaceName || folderName;');
    expect(welcome).toContain("`${t('input.workspace')}${targetName}`");
    expect(welcome).not.toContain('今天想对');
    expect(welcome).not.toContain('workspaceSettingsButton');
    expect(welcome).not.toContain('开始一段对话');
    expect(read('App.tsx')).toContain('账户与偏好设置');
    expect(read('App.tsx')).toContain('aria-expanded={sidebarVisible}');
    expect(welcome).toContain('const name = getFolderDisplayName(path);');
    expect(welcome).not.toContain("const name = path.split('/').pop() || path;");
  });

  it('keeps the welcome workspace picker scrollable when many paths are available', () => {
    const css = read('components/Welcome.module.css');
    const historyRule = extractRule(css, '.folderHistory');

    expect(historyRule).toContain('max-height:');
    expect(historyRule).toContain('overflow-y: auto');
    expect(historyRule).toContain('overscroll-behavior: contain');
    expect(historyRule).toContain('scrollbar-gutter: stable');
  });

  it('keeps chat mode clean and keeps the old bottom terminal out of the app shell', () => {
    const app = read('App.tsx');
    const css = read('../styles.css');

    expect(app).toContain('titlebar-chat-mode');
    expect(app).not.toContain('bottomConsoleToggleLabel');
    expect(app).not.toContain('bottomConsoleOpen');
    expect(app).not.toContain('<BottomConsole');
    expect(app).not.toContain('Expand toolbar');
    expect(app).not.toContain('Collapse toolbar');

    expect(css).toContain('.bottom-console {');
    expect(css).toContain('bottom: 0;');
    expect(css).toContain('top: auto;');
    expect(css).toContain('.bottom-console.collapsed');
    const collapsedRule = extractRule(css, '.bottom-console.collapsed');
    expect(collapsedRule).toContain('display: none;');
    expect(collapsedRule).not.toContain('top: calc(var(--titlebar-h) + 8px);');
    expect(css).toContain('.titlebar-chat-mode .tb-left-tools');
    const chatRightGroup = extractRule(css, '.titlebar-chat-mode .tb-right-group');
    const chatRightTools = extractRule(css, '.titlebar-chat-mode .tb-right-tools');
    const chatPinnedTools = extractRule(css, '.titlebar-chat-mode .tb-pinned-tools');
    const chatPinnedButtons = extractRule(css, '.titlebar-chat-mode .tb-pinned-tools > .tb-toggle');
    expect(chatRightGroup).toContain('max-width: none');
    expect(chatRightGroup).toContain('min-width: max-content');
    expect(chatRightGroup).toContain('flex: 0 0 auto');
    expect(chatRightGroup).toContain('overflow: visible');
    expect(chatRightTools).toContain('display: none');
    expect(chatRightTools).toContain('overflow: visible');
    expect(chatPinnedTools).toContain('display: flex');
    expect(chatPinnedTools).toContain('min-width: max-content');
    expect(chatPinnedTools).toContain('flex-wrap: nowrap');
    expect(chatPinnedTools).toContain('overflow: visible');
    expect(chatPinnedButtons).toContain('display: flex');
    expect(chatPinnedButtons).toContain('visibility: visible');
    expect(chatPinnedButtons).toContain('flex: 0 0 26px');
    expect(css).not.toContain('.titlebar-chat-mode .tb-toolbar-collapse,');
    expect(css).not.toContain('.titlebar-chat-mode .tb-center-group,');
    expect(css).toContain('.titlebar-chat-mode .tb-right-group');
  });

  it('removes the IDE menu footprint from the chat titlebar while preserving window controls', () => {
    const css = read('../styles.css');

    expect(css).toContain('.titlebar-chat-mode {');
    expect(css).toContain('border-bottom-color: transparent;');
    expect(css).toContain('.titlebar-chat-mode .tb-left-group');
    expect(css).toContain('max-width: none;');
    expect(css).toContain('.titlebar-chat-mode .tb-right-group');
    expect(css).not.toContain('.titlebar-chat-mode .obsidian-ide-menu');
    expect(css).toContain('.titlebar-chat-mode .window-controls');
  });

  it('does not reintroduce openhanako or Hanako branding on the home shell', () => {
    const app = read('App.tsx');
    const welcome = read('components/WelcomeScreen.tsx');

    expect(`${app}\n${welcome}`).not.toMatch(/openhanako|Hanako/i);
  });
});
