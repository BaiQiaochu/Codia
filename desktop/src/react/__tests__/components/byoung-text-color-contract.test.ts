import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('Codia interface text color contract', () => {
  it('uses the plum Codia palette for desktop and mobile interface copy', () => {
    const desktop = read('desktop/src/styles.css');
    const mobile = read('desktop/src/react/mobile/mobile-entry.css');
    expect(desktop).toContain('color: var(--text, #342A45) !important;');
    expect(mobile).toContain('--byoung-brand-text: #342A45;');
    expect(mobile).toContain('color: var(--byoung-brand-text) !important;');
    expect(desktop).toContain('[data-byoung-chat-color-scope] *');
    expect(mobile).toContain('[data-byoung-chat-color-scope] *');
  });

  it('isolates desktop, mobile, channel, and quick-chat surfaces', () => {
    for (const path of [
      'desktop/src/react/App.tsx',
      'desktop/src/react/mobile/MobileApp.tsx',
      'desktop/src/react/components/ChannelsPanel.tsx',
      'desktop/src/react/quick-chat/QuickChatApp.tsx',
    ]) {
      expect(read(path)).toContain('data-byoung-chat-color-scope');
    }
  });

  it('uses the Codia plum and lilac surfaces on the initialization splash', () => {
    const splash = read('desktop/src/splash.html');
    expect(splash).toContain('color: #342A45;');
    expect(splash).toContain('background: #F8F4FF;');
    expect(read('desktop/src/react/splash/SplashApp.tsx')).toContain('正在初始化…');
  });
});
