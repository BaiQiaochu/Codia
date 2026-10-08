import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculateInputCardBottomInset } from '../../utils/input-card-layout';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function cssBlock(css: string, selector: string): string {
  return css.match(new RegExp(`${selector}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

describe('InputArea compact bottom inset layout', () => {
  it('keeps one transient editor row free before pushing the chat cut point', () => {
    expect(calculateInputCardBottomInset({
      cardHeight: 80,
      editorHeight: 24,
      editorLineHeight: 24,
    })).toBe(40);

    expect(calculateInputCardBottomInset({
      cardHeight: 104,
      editorHeight: 48,
      editorLineHeight: 24,
    })).toBe(40);

    expect(calculateInputCardBottomInset({
      cardHeight: 128,
      editorHeight: 72,
      editorLineHeight: 24,
    })).toBe(64);
  });

  it('uses the measured input bottom inset as the chat panel and footer cut point', () => {
    const css = read('components/chat/Chat.module.css');
    const shellBlock = cssBlock(css, String.raw`\.sessionShell`);
    const footerBlock = cssBlock(css, String.raw`\.sessionFooter`);

    expect(shellBlock).toMatch(/--chat-scrollbar-bottom-inset:\s*var\(--input-card-bottom-inset,\s*calc\(var\(--input-card-h,\s*0px\) \/ 2\)\)/);
    expect(shellBlock).toMatch(/bottom:\s*calc\(var\(--chat-scrollbar-bottom-inset\) \+ var\(--space-lg\)\)/);
    expect(footerBlock).toMatch(/height:\s*calc\(var\(--chat-scrollbar-bottom-inset\) \+ var\(--space-lg\) \+ 5rem\)/);
  });

  it('measures the input card and editor metrics instead of only the outer composer height', () => {
    const appSource = read('App.tsx');

    expect(appSource).toContain('calculateInputCardBottomInset');
    expect(appSource).toContain('inputCardRef');
    expect(appSource).toContain("parent.style.setProperty('--input-card-bottom-inset'");
    expect(appSource).toContain('ref={inputAreaRef}');
    expect(appSource).toContain('cardRef={inputCardRef}');
  });

  it('reserves chat scroll space for the visible prompt queue panel', () => {
    const appSource = read('App.tsx');
    const inputSource = read('components/InputArea.tsx');

    expect(inputSource).toContain('data-prompt-queue-panel');
    expect(appSource).toContain("el.querySelector<HTMLElement>('[data-prompt-queue-panel]')");
    expect(appSource).toContain('reservedBottomInset');
    expect(appSource).toContain('bottomInset + upperSurfaceHeight');
  });

  it('keeps the approval prompt compact so it does not cover the document preview', () => {
    const css = read('components/input/InputArea.module.css');
    const promptBlock = cssBlock(css, String.raw`\.session-confirmation-prompt`);

    expect(promptBlock).toMatch(/z-index:\s*2/);
    expect(promptBlock).toMatch(/align-items:\s*center/);
    expect(promptBlock).toMatch(/margin:\s*0 0 var\(--space-xs\)/);
    expect(promptBlock).toMatch(/padding:\s*0\.5rem 0\.65rem/);
    expect(promptBlock).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(promptBlock).not.toMatch(/margin:\s*0 0 -/);
    expect(promptBlock).not.toMatch(/padding:\s*[^;]*2\.\d+rem/);
  });

  it('uses container fallbacks for narrow chat composers so controls do not overlap', () => {
    const css = read('components/input/InputArea.module.css');

    expect(cssBlock(css, String.raw`\.input-wrapper`)).toMatch(/container-type:\s*inline-size/);
    expect(css).toMatch(/@container\s*\(max-width:\s*560px\)\s*\{[\s\S]*\.input-bottom-bar\s*\{[\s\S]*flex-direction:\s*column/);
    expect(css).toMatch(/@container\s*\(max-width:\s*560px\)\s*\{[\s\S]*\.input-controls\s*\{[\s\S]*width:\s*100%/);
    expect(css).toMatch(/@container\s*\(max-width:\s*560px\)\s*\{[\s\S]*\.plan-mode-label[\s\S]*display:\s*none/);
    expect(css).toMatch(/@container\s*\(max-width:\s*440px\)\s*\{[\s\S]*\.model-selector\s*\{[\s\S]*max-width:\s*120px/);
  });

  it('renders workspace tools as a compact dropdown inside the composer instead of a welcome-page detail block', () => {
    const inputSource = read('components/InputArea.tsx');
    const inputCss = read('components/input/InputArea.module.css');
    const welcomeSource = read('components/WelcomeScreen.tsx');
    const welcomeCss = read('components/Welcome.module.css');

    expect(inputSource).toContain('WORKSPACE_TOOL_SELECT_EVENT');
    expect(inputSource).toContain('WORKSPACE_TOOL_OPTIONS');
    expect(inputSource).toContain('readWorkspaceToolSelectionDetail');
    expect(inputSource).toContain('data-testid="workspace-tool-menu-button"');
    expect(inputSource).toContain("styles['workspace-tool-menu-button']");
    expect(inputSource).toContain('WORKSPACE_TOOL_OPTIONS.map');
    expect(inputCss).toContain('.workspace-tool-menu-button');
    expect(inputCss).toContain('.workspace-tool-menu');
    expect(cssBlock(inputCss, String.raw`\.workspace-tool-menu-button`)).toMatch(/max-width:\s*clamp/);
    expect(inputSource).toMatch(/<AnchoredPortal[\s\S]*?open=\{visible && workspaceToolMenuOpen\}[\s\S]*?anchorRef=\{workspaceToolMenuRef\}/);
    expect(cssBlock(inputCss, String.raw`\.workspace-tool-menu`)).not.toMatch(/position:\s*absolute|bottom:/);
    expect(cssBlock(inputCss, String.raw`\.workspace-tool-menu`)).toMatch(/max-height:\s*min\(360px, 48vh\)/);
    expect(welcomeSource).not.toContain('HomeActions');
    expect(welcomeSource).not.toContain('styles.homeActionsShell');
    expect(welcomeCss).not.toContain('.homeActionsShell');
    expect(welcomeCss).not.toContain('.homeActionMenuButton');
    expect(welcomeSource).not.toContain('data-home-action-detail');
    expect(welcomeSource).not.toContain('styles.homeActionDetail');
    expect(welcomeCss).not.toContain('.homeActionDetail');
  });

  it('opens skills from the desktop star while preserving typed slash commands and skill insertion', () => {
    const source = read('components/InputArea.tsx');
    const utilities = read('components/input/InputUtilityButtons.tsx');
    expect(source).toContain('<InputUtilityButtons');
    expect(utilities).toContain("setActivePanel('skills')");
    expect(source).toContain('getSlashMatches(text, slashCommands)');
    expect(source).toContain('if (!fileMention && slashMatches.length > 0');
    expect(source).toContain('<SlashCommandMenu');
    expect(source).toContain('buildSkillEditorContent(exactSkill.name, trailingArgs || parsed.args)');
    expect(source).toContain("mobileCommands={surface === 'mobile' ?");
    expect(source).not.toContain('else openSlashMenu()');
  });

  it('docks welcome actions above the composer and adapts four quick tasks by content width', () => {
    const source = read('components/WelcomeScreen.tsx');
    const css = read('components/Welcome.module.css');
    expect(source).toContain('styles.codiaHeroStage');
    expect(source).toContain('styles.codiaActionDock');
    expect(source).toContain('styles.codiaContextControls');
    expect(cssBlock(css, String.raw`\.codiaQuickGrid`)).toContain('repeat(4, minmax(0, 1fr))');
    expect(css).toMatch(/@container codia-welcome \(max-width:\s*959px\)[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@container codia-welcome \(max-width:\s*639px\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(cssBlock(css, String.raw`\.codiaQuickGrid > button`)).toMatch(/flex-direction:\s*row/);
    expect(cssBlock(css, String.raw`\.codiaQuickGrid > button`)).toMatch(/min-height:\s*62px/);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(source).toContain('<CodiaStaticMascot');
    const staticSource = read('components/CodiaStaticMascot.tsx');
    const staticCss = read('components/CodiaStaticMascot.module.css');
    expect(staticSource).toContain('codia-mascot-gaze-strip.png');
    expect(staticSource).toContain('data-codia-static-mascot');
    expect(staticCss).toContain('animation: none');
    expect(staticCss).toContain('transform: none');
    expect(source).not.toContain('codia-kitten.png');
    expect(cssBlock(staticCss, String.raw`\.sprite`)).toMatch(/width:\s*300%/);
    expect(source.match(/className=\{styles.codiaQuickCopy\}/g)).toHaveLength(4);
  });

  it('sizes the Live2D surface independently of the clipped sprite fallback', () => {
    const source = read('components/WelcomeScreen.tsx');
    const css = read('components/Welcome.module.css');
    const live2D = cssBlock(css, String.raw`\.codiaLive2D`);
    expect(source).toContain('<CodiaLive2DMascot');
    expect(source).toContain('className={styles.codiaLive2D}');
    expect(source).toContain('fallback={(');
    expect(live2D).toMatch(/width:\s*clamp\(174px, 18cqw, 200px\)/);
    expect(live2D).toMatch(/overflow:\s*visible/);
    expect(live2D).not.toMatch(/animation:|transform:|border-radius:/);
    expect(css).not.toContain('.codiaLive2D::after');
    expect(css).toMatch(/@container codia-welcome \(max-width:\s*639px\)[\s\S]*\.codiaLive2D\s*\{\s*width:\s*clamp\(106px, 20cqw, 126px\)/);
  });
});
