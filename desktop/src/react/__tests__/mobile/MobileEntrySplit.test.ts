import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PWA_DISPLAY_NAME } from '../../../../../shared/product-branding.ts';

function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importRe = /^\s*import(?:\s+type)?(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/gm;
  const sideEffectImportRe = /^\s*import\s+['"]([^'"]+)['"];?/gm;
  for (const match of source.matchAll(importRe)) specifiers.push(match[1]);
  for (const match of source.matchAll(sideEffectImportRe)) specifiers.push(match[1]);
  return specifiers;
}

describe('Mobile PWA entry split', () => {
  it('uses a mobile-specific CSS entry and does not import the desktop app shell', () => {
    const entry = readFileSync(path.join(process.cwd(), 'desktop/src/mobile-main.tsx'), 'utf8');
    const imports = staticImportSpecifiers(entry);

    expect(imports).toContain('./react/mobile/mobile-platform');
    expect(imports).toContain('./react/mobile/mobile-entry.css');
    expect(imports).toContain('./react/mobile/MobileApp.css');
    expect(imports).not.toContain('./styles.css');
    expect(imports).not.toContain('./react/App');
    expect(entry).toContain("import('./react/mobile/MobileApp')");
    expect(entry).toContain('uploadBrowserFiles');
    expect(entry).toContain("'/api/upload-blob'");
    expect(entry).not.toMatch(/Hana|Hanako|openhanako/i);
  });

  it('uses the neutral sans-serif theme contract in the mobile-specific CSS entry', () => {
    const css = readFileSync(path.join(process.cwd(), 'desktop/src/react/mobile/mobile-entry.css'), 'utf8');

    expect(css).not.toContain('new-warm-paper-fonts.css');
    expect(css).toMatch(/--font-serif:\s*var\(--font-ui\)/);
    expect(css).not.toContain('body.font-sans');
    expect(css).toContain('.gsap-toggle');
    expect(css).not.toContain('.hana-toggle');
  });

  it('keeps Mermaid source controls styled in the mobile markdown surface', () => {
    const css = readFileSync(path.join(process.cwd(), 'desktop/src/react/mobile/mobile-entry.css'), 'utf8');

    expect(css).toContain('.md-content .mermaid-source-toolbar');
    expect(css).toContain('.md-content .mermaid-source-toolbar button');
    expect(css).toContain('.md-content .mermaid-source-toolbar button:hover');
  });

  it('does not statically pull desktop-only panels into the mobile shell', () => {
    const file = path.join(process.cwd(), 'desktop/src/react/mobile/MobileApp.tsx');
    expect(existsSync(file)).toBe(true);

    const source = readFileSync(file, 'utf8');
    const imports = staticImportSpecifiers(source);

    expect(source).not.toContain("import('../App')");
    expect(source).toContain('function MobileDesktopShell');
    expect(imports).not.toContain('../components/app/AppPages');
    expect(imports).not.toContain('../components/app/WorkspaceCompanionRail');
    expect(source).toContain('../components/SessionList');
    expect(source).toContain('../components/WelcomeScreen');
    expect(source).toContain('../components/chat/ChatArea');
    expect(source).toContain('../components/InputArea');
    expect(source).toContain('../components/right-workspace/RightWorkspacePanel');
    expect(source).toContain('surface="mobile"');
    expect(source).not.toContain('autoRetry');
    expect(imports).not.toContain('../components/PreviewPanel');
    expect(imports).not.toContain('../components/shared/MediaViewer/MediaViewer');
    expect(source).not.toMatch(/Hana|Hanako|openhanako/i);
  });

  it('does not expose desktop settings entry points in the PWA shell', () => {
    const source = readFileSync(path.join(process.cwd(), 'desktop/src/react/mobile/MobileApp.tsx'), 'utf8');
    const welcomeSource = readFileSync(path.join(process.cwd(), 'desktop/src/react/components/WelcomeScreen.tsx'), 'utf8');
    const imports = staticImportSpecifiers(source);

    expect(imports).not.toContain('../stores/settings-modal-actions');
    expect(source).not.toContain('SettingsModalShell');
    expect(source).not.toContain('openSettingsModal');
    expect(source).not.toContain('settingsModal');
    expect(source).not.toContain('id="settingsBtn"');
    expect(source).not.toContain("tr('settings.title'");
    expect(source).toContain('<WelcomeScreen />');
    expect(welcomeSource).not.toContain('openSettingsModal');
    expect(welcomeSource).not.toContain('workspaceSettingsButton');
  });

  it('uses Codia naming for the mobile HTML and manifest', () => {
    const html = readFileSync(path.join(process.cwd(), 'desktop/src/mobile.html'), 'utf8');
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'desktop/src/mobile-manifest.webmanifest'), 'utf8'));

    expect(html).toContain(`<title>${PWA_DISPLAY_NAME}</title>`);
    expect(manifest.name).toBe(PWA_DISPLAY_NAME);
  });

  it('keeps early PWA update notices until the mobile shell is ready', () => {
    const entry = readFileSync(path.join(process.cwd(), 'desktop/src/mobile-main.tsx'), 'utf8');
    const app = readFileSync(path.join(process.cwd(), 'desktop/src/react/mobile/MobileApp.tsx'), 'utf8');
    const globals = readFileSync(path.join(process.cwd(), 'desktop/src/global.d.ts'), 'utf8');

    expect(entry).toContain('gsap-mobile-update-available');
    expect(entry).toContain('gsap-mobile-apply-update');
    expect(entry).toContain('window.__gsapMobileUpdateAvailable = true');
    expect(app).toContain('window.__gsapMobileUpdateAvailable === true');
    expect(app).toContain('window.__gsapMobileUpdateAvailable = true');
    expect(globals).toContain('__gsapMobileUpdateAvailable?: boolean');
    expect(entry).not.toContain('__hanaMobileUpdateAvailable');
    expect(app).not.toContain('__hanaMobileUpdateAvailable');
  });

  it('initializes authenticated PWA sessions from the mobile-safe bootstrap route', () => {
    const mobileInit = readFileSync(path.join(process.cwd(), 'desktop/src/react/mobile/mobile-init.ts'), 'utf8');
    const mobileApp = readFileSync(path.join(process.cwd(), 'desktop/src/react/mobile/MobileApp.tsx'), 'utf8');

    expect(mobileInit).toContain('export async function initializeMobileRuntime');
    expect(mobileInit).toContain("'/api/mobile/bootstrap'");
    expect(mobileInit).not.toContain("'/api/config'");
    expect(mobileApp).toContain('initializeMobileRuntime(session.principal)');
  });

  it('keeps PWA input surface safeguards from the original mobile runtime', () => {
    const inputArea = readFileSync(path.join(process.cwd(), 'desktop/src/react/components/InputArea.tsx'), 'utf8');
    const boundary = readFileSync(path.join(process.cwd(), 'desktop/src/react/components/RegionalErrorBoundary.tsx'), 'utf8');

    expect(inputArea).toContain("surface?: 'desktop' | 'mobile'");
    expect(inputArea).toContain("immediatelyRender: surface !== 'mobile'");
    expect(inputArea).toContain('beforeInputHandlerRef');
    expect(inputArea).toContain("event.inputType !== 'insertParagraph'");
    expect(inputArea).toContain("surface !== 'mobile'");
    expect(inputArea).toContain('browserFileInputRef');
    expect(inputArea).toContain('type="file"');
    expect(inputArea).toContain("styles['input-surface-mobile']");
    expect(boundary).not.toContain('autoRetry');
    expect(boundary).not.toContain('autoRetryPending');
  });
});
