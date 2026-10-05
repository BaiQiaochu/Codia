import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDITOR_TYPOGRAPHY,
  applyEditorTypography,
  normalizeEditorTypography,
} from '../../editor/typography';

function readPreviewStyles(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/Preview.module.css'),
    'utf8',
  );
}

function readEditorTheme(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/editor/theme.ts'),
    'utf8',
  );
}

function readEditorHighlight(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/editor/highlight.ts'),
    'utf8',
  );
}

describe('editor typography settings', () => {
  it('uses markdown defaults and preserves heading controls', () => {
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.fontPreset).toBe('follow');
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.bodyFontSize).toBe(15);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading1FontSize).toBe(24);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading2FontSize).toBe(20);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading3FontSize).toBe(18);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading4FontSize).toBe(16);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading5FontSize).toBe(15);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading6FontSize).toBe(14);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.lineHeight).toBe(1.72);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.contentPadding).toBe(24);
  });

  it('normalizes partial and invalid values without mutating defaults', () => {
    const normalized = normalizeEditorTypography({
      markdown: {
        bodyFontSize: 99,
        heading1FontSize: 10,
        heading6FontSize: 80,
        lineHeight: 'wide',
        contentPadding: -12,
        fontPreset: 'comic',
      },
    });

    expect(normalized.markdown.fontPreset).toBe('follow');
    expect(normalized.markdown.bodyFontSize).toBe(24);
    expect(normalized.markdown.heading1FontSize).toBe(16);
    expect(normalized.markdown.heading2FontSize).toBe(20);
    expect(normalized.markdown.heading6FontSize).toBe(24);
    expect(normalized.markdown.lineHeight).toBe(1.72);
    expect(normalized.markdown.contentPadding).toBe(0);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.contentPadding).toBe(24);

    const selected = normalizeEditorTypography({ markdown: { fontPreset: 'sans' } });
    expect(selected.markdown.fontPreset).toBe('sans');
  });

  it('applies normalized typography as document-level CSS variables', () => {
    const values = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        getPropertyValue: (name: string) => values.get(name) || '',
      },
    } as unknown as HTMLElement;

    applyEditorTypography({
      markdown: {
        bodyFontSize: 17,
        heading1FontSize: 26,
        heading2FontSize: 21,
        heading3FontSize: 19,
        heading4FontSize: 18,
        heading5FontSize: 17,
        heading6FontSize: 16,
        lineHeight: 1.8,
        contentPadding: 28,
        fontPreset: 'sans',
      },
    }, root);

    const style = root.style;
    expect(style.getPropertyValue('--editor-markdown-font-family')).toBe('var(--font-ui)');
    expect(style.getPropertyValue('--editor-markdown-font-size')).toBe('17px');
    expect(style.getPropertyValue('--editor-markdown-h1-font-size')).toBe('26px');
    expect(style.getPropertyValue('--editor-markdown-h2-font-size')).toBe('21px');
    expect(style.getPropertyValue('--editor-markdown-h3-font-size')).toBe('19px');
    expect(style.getPropertyValue('--editor-markdown-h4-font-size')).toBe('18px');
    expect(style.getPropertyValue('--editor-markdown-h5-font-size')).toBe('17px');
    expect(style.getPropertyValue('--editor-markdown-h6-font-size')).toBe('16px');
    expect(style.getPropertyValue('--editor-markdown-line-height')).toBe('1.8');
    expect(style.getPropertyValue('--editor-markdown-content-padding-x')).toBe('28px');
  });

  it('uses editor typography variables in markdown preview', () => {
    const css = readPreviewStyles();

    expect(css).toMatch(/:global\(\.preview-markdown\)\s*\{[\s\S]*font-size:\s*var\(--editor-markdown-font-size\)/);
    expect(css).toMatch(/:global\(\.preview-markdown\)\s*\{[\s\S]*font-family:\s*var\(--editor-markdown-font-family,\s*var\(--font-serif\)\)/);
    expect(css).toMatch(/:global\(\.preview-markdown\)\s*\{[\s\S]*font-weight:\s*400/);
    expect(css).toMatch(/:global\(\.preview-markdown\) h1\s*\{[\s\S]*font-size:\s*var\(--editor-markdown-h1-font-size\)[\s\S]*font-weight:\s*700/);
    expect(css).toMatch(/:global\(\.preview-markdown\.markdown-has-cover\) h1\s*\{[\s\S]*text-align:\s*left/);

    for (const level of [2, 3, 4, 5, 6]) {
      expect(css).toMatch(new RegExp(
        `:global\\(\\.preview-markdown\\) h${level}\\s*\\{[\\s\\S]*font-size:\\s*var\\(--editor-markdown-h${level}-font-size\\)[\\s\\S]*font-weight:\\s*600`,
      ));
    }
  });

  it('adds page-header space to markdown previews without a cover', () => {
    const css = readPreviewStyles();

    expect(css).toMatch(
      /:global\(\.markdown-cover-drop-host \.preview-markdown\)\s*\{[\s\S]*padding-top:\s*calc\(var\(--space-xl\)\s*\+\s*var\(--space-lg\)\)/,
    );
  });

  it('uses the same page-header spacing in the markdown editor', () => {
    const theme = readEditorTheme();

    expect(theme).toMatch(/padding:\s*'calc\(var\(--space-xl\) \+ var\(--space-lg\)\) 0 var\(--preview-markdown-editor-bottom-space, var\(--space-md\)\)'/);
    expect(theme).toMatch(/'&\.cm-markdown-has-top-cover \.cm-scroller':\s*\{[\s\S]*paddingTop:\s*'0'/);
  });

  it('keeps markdown editor and preview bottoms away from the card edge', () => {
    const css = readPreviewStyles();
    const theme = readEditorTheme();
    expect(css).toMatch(/\.previewPanelBody\s*\{[\s\S]*--preview-markdown-bottom-space:\s*calc\(var\(--space-xl\)\s*\+\s*var\(--space-xl\)\s*\+\s*var\(--space-lg\)\s*\+\s*var\(--space-lg\)\)/);
    expect(css).toMatch(/\.markdownPreviewDocument\s*\{[\s\S]*padding-bottom:\s*var\(--preview-markdown-bottom-space\)/);
    expect(css).toMatch(/:global\(\.preview-editor\.mode-markdown\)\s*\{[\s\S]*--preview-markdown-editor-bottom-space:\s*var\(--preview-markdown-bottom-space,\s*calc\(var\(--space-xl\)\s*\+\s*var\(--space-xl\)\s*\+\s*var\(--space-lg\)\s*\+\s*var\(--space-lg\)\)\)/);
    expect(theme).toMatch(/var\(--preview-markdown-editor-bottom-space,\s*var\(--space-md\)\)/);
  });

  it('lets preview editor content use the full panel width', () => {
    const css = readPreviewStyles();
    const contentRule = css.match(/:global\(\.artifact-editor \.cm-content\)\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';

    expect(contentRule).toMatch(/width:\s*100%/);
    expect(contentRule).not.toMatch(/max-width/);
    expect(contentRule).not.toMatch(/margin:\s*0 auto/);
  });

  it('keeps markdown cover spacing measurable inside the CodeMirror cover element', () => {
    const theme = readEditorTheme();

    expect(theme).toMatch(/fontFamily:\s*'var\(--editor-markdown-font-family,\s*var\(--font-serif\)\)'/);
    expect(theme).toMatch(/'\.cm-markdown-cover':\s*\{[\s\S]*margin:\s*'0 auto'/);
    expect(theme).toMatch(/'\.cm-markdown-cover':\s*\{[\s\S]*paddingBottom:\s*'var\(--space-lg\)'/);
    expect(theme).toMatch(/'\.cm-markdown-cover':\s*\{[\s\S]*boxSizing:\s*'content-box'/);
    expect(theme).toMatch(/'\.cm-markdown-cover-resize':\s*\{[\s\S]*bottom:\s*'var\(--space-lg\)'/);
  });

  it('uses the same typography variables in markdown editor and preview rendering', () => {
    const theme = readEditorTheme();
    const highlight = readEditorHighlight();
    const previewCss = readPreviewStyles();

    expect(theme).toMatch(/'&':\s*\{\s*fontSize:\s*'var\(--editor-markdown-font-size\)'/);
    expect(theme).toMatch(/lineHeight:\s*'var\(--editor-markdown-line-height\)'/);
    expect(theme).toMatch(/padding:\s*'0 var\(--editor-markdown-content-padding-x\)'/);
    expect(highlight).toMatch(/tags\.heading1,\s*fontSize:\s*'var\(--editor-markdown-h1-font-size\)'/);
    expect(highlight).toMatch(/tags\.heading6,\s*fontSize:\s*'var\(--editor-markdown-h6-font-size\)'/);
    expect(previewCss).toMatch(/font-size:\s*var\(--editor-markdown-font-size\)/);
    expect(previewCss).toMatch(/font-size:\s*var\(--editor-markdown-h1-font-size\)/);
    expect(previewCss).toMatch(/font-size:\s*var\(--editor-markdown-h6-font-size\)/);
  });
});
