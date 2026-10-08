import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

describe('Codia desktop navigation simplification', () => {
  it('keeps only the requested sidebar destinations', () => {
    const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');

    expect(app).toContain('<span>聊天</span>');
    expect(app).toContain('<span>Agent 小队</span>');
    expect(app).toContain('<span>工作流</span>');
    expect(app).toContain('<span>活动与插件</span>');
    expect(app).not.toContain('<span>文件与项目</span>');
    expect(app).not.toContain('codia-sidebar-section-label');
    expect(app).not.toContain('id="bridgeBar"');
    expect(app).not.toContain('id="activityBar"');
    expect(app).not.toContain('id="sidebarCollapseBtn"');
    expect(app).not.toContain('HomeNavigationMenus');
    expect(app).not.toContain('className="sidebar-header"');
    expect(app).not.toContain("t('sidebar.title')");
    expect(app).not.toContain('id="settingsBtn"');
    expect(app).not.toContain('id="automationBar"');
    expect(app).not.toContain('id="skillsBar"');
    expect(app).toContain("onClick={() => openSettingsModal('me')}");
  });

  it('keeps new chat beside the Chat navigation item as a separate accessible button', () => {
    const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
    const navigation = app.slice(app.indexOf('<nav className="codia-primary-nav"'), app.indexOf('</nav>'));
    expect(navigation).toContain('codia-chat-nav-row');
    expect(navigation).toContain('id="newSessionBtn"');
    expect(navigation).toContain("aria-label={t('sidebar.newChat')}");
    expect(navigation).toContain('goChat(); void createNewSession();');
    expect(app.match(/id="newSessionBtn"/g)).toHaveLength(1);
  });

  it('keeps the window-level left and right sidebar controls', () => {
    const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');

    expect(app).toContain('id="tbToggleLeft"');
    expect(app).toContain('id="tbToggleRight"');
    expect(app).toContain('<WindowControls />');
  });
});
