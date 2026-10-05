import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const cssPath = path.resolve(__dirname, '../Settings.module.css');

function readCss() {
  return fs.readFileSync(cssPath, 'utf8');
}

function extractRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  return match?.[1] || '';
}

function extractRuleContaining(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)([^{}]*${escaped}[^{}]*)\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  return match?.[2] || '';
}

describe('settings layout CSS', () => {
  it('keeps stylesheet comments balanced so module rules are not swallowed', () => {
    const css = readCss();
    const stack: number[] = [];

    for (let index = 0, line = 1; index < css.length; index += 1) {
      if (css[index] === '\n') line += 1;
      if (css.startsWith('/*', index)) {
        stack.push(line);
        index += 1;
      } else if (css.startsWith('*/', index)) {
        expect(stack.pop()).toBeDefined();
        index += 1;
      }
    }

    expect(stack).toEqual([]);
  });

  it('keeps both settings navigation and content scrollable inside the fixed panel', () => {
    const css = readCss();
    const nav = extractRule(css, '.settings-nav');
    const main = extractRule(css, '.settings-main');

    expect(nav).toContain('min-height: 0');
    expect(nav).toContain('overflow-y: auto');
    expect(main).toContain('position: relative');
    expect(main).toContain('min-width: 0');
    expect(main).toContain('overflow-y: auto');
    expect(main).toContain('padding: 0 var(--settings-main-x-padding, var(--space-xl)) var(--space-xl)');
  });

  it('keeps standard settings pages constrained and only widens wide pages', () => {
    const css = readCss();
    const main = extractRule(css, '.settings-main');
    const wide = extractRule(css, '.settings-main-wide');

    expect(main).toContain('max-width: 640px');
    expect(wide).toContain('max-width: 960px');
  });

  it('keeps provider bottom model controls padded and responsive', () => {
    const css = readCss();
    const wrapper = extractRule(css, '.providers-other-models');
    const grid = extractRule(css, '.provider-model-grid');
    const field = extractRule(css, '.provider-model-field');
    const keyWrapper = extractRuleContaining(css, '.provider-model-field .settings-key-wrapper');
    const keyToggle = extractRuleContaining(css, '.provider-model-field .settings-key-toggle');

    expect(wrapper).toContain('padding: var(--space-md)');
    expect(grid).toContain('display: grid');
    expect(grid).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr))');
    expect(field).toContain('min-width: 0');
    expect(field).toContain('margin-bottom: 0');
    expect(keyWrapper).toContain('display: grid');
    expect(keyWrapper).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(keyToggle).toContain('position: static');
  });

  it('keeps media provider default controls responsive in narrow detail panes', () => {
    const css = readCss();
    const list = extractRuleContaining(css, '.pv-list');
    const grid = extractRule(css, '.media-provider-defaults-grid');
    const field = extractRule(css, '.media-provider-default-field');
    const control = extractRule(css, '.media-provider-default-control');

    expect(list).toContain('width: 33.33%');
    expect(list).toContain('flex: 0 0 33.33%');
    expect(grid).toContain('display: grid');
    expect(grid).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr))');
    expect(field).toContain('min-width: 0');
    expect(control).toContain('width: 100%');
    expect(control).toContain('min-width: 0');
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
  });

  it('keeps literal class fallbacks for provider and media settings controls', () => {
    const css = readCss();

    expect(css).toContain(':global(.pv-layout)');
    expect(css).toContain(':global(.pv-list)');
    expect(css).toContain(':global(.pv-list-item)');
    expect(css).toContain(':global(.media-module-button)');
    expect(css).toContain(':global(.media-default-select)');
  });

  it('keeps a scoped themed fallback for settings controls that miss a specific component class', () => {
    const css = readCss();

    expect(css).toContain(':global(.settings-tab-content) :where(button)');
    expect(css).toContain('appearance: none');
    expect(css).toContain('background-color: var(--bg-card)');
    expect(css).toContain('border: 1px solid var(--border)');
    expect(css).toContain(':global(.settings-tab-content) :where(button:hover:not(:disabled))');
    expect(css).toContain(':global(.settings-tab-content) :where(select)');
    expect(css).toContain(':global(.settings-tab-content) :where(input:not([type="checkbox"]):not([type="radio"]), textarea)');
  });

  it('keeps settings save buttons compact instead of stretching to the form width', () => {
    const css = readCss();
    const saveButton = extractRule(css, '.settings-save-btn-sm');
    const primaryButton = extractRule(css, '.settings-btn-primary');

    for (const rule of [saveButton, primaryButton]) {
      expect(rule).toContain('display: inline-flex');
      expect(rule).toContain('flex: 0 0 auto');
      expect(rule).toContain('width: auto');
      expect(rule).toContain('white-space: nowrap');
    }

    expect(saveButton).toContain('max-width: max-content');
    expect(primaryButton).toContain('max-width: 100%');
    expect(saveButton).toContain('min-width: 42px');
    expect(saveButton).toContain('min-height: 22px');
    expect(primaryButton).toContain('min-width: 52px');
    expect(primaryButton).toContain('min-height: 24px');
  });
});
