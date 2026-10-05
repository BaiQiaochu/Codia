/**
 * @vitest-environment jsdom
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMarkdownDecorations,
  collectLivePreviewRanges,
  markdownBlockDecoField,
  markdownDecoPlugin,
} from '../../editor/md-decorations';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('collectLivePreviewRanges', () => {
  it('collects Obsidian highlights and math ranges on inactive lines', () => {
    const ranges = collectLivePreviewRanges([
      'GDP ==deflator== and $x+1$',
      '$$',
      'y^2',
      '$$',
      '<span style="background:#fff88f">highlight</span>',
    ].join('\n'), new Set());

    expect(ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'mark', text: 'deflator' }),
      expect.objectContaining({ kind: 'inlineMath', source: 'x+1' }),
      expect.objectContaining({ kind: 'blockMath', source: 'y^2' }),
      expect.objectContaining({ kind: 'mark', text: 'highlight', color: '#fff88f' }),
    ]));
  });

  it('skips live preview ranges on active lines so the source remains editable', () => {
    const ranges = collectLivePreviewRanges('GDP ==deflator== and $x+1$', new Set([1]));

    expect(ranges).toEqual([]);
  });

  it('does not collect math or highlight ranges inside code blocks', () => {
    const ranges = collectLivePreviewRanges([
      '```js',
      'const price = "$x+1$"; // ==keep raw==',
      '```',
    ].join('\n'), new Set());

    expect(ranges).toEqual([]);
  });

  it('does not collect math or highlight ranges inside inline code', () => {
    const ranges = collectLivePreviewRanges('Use `$x+1$` and `==raw==` outside ==mark==', new Set());

    expect(ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'mark', text: 'mark' }),
    ]));
    expect(ranges).toHaveLength(3);
  });

  it('does not provide block math decorations through the view plugin decoration set', () => {

    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: 'intro\n$$\ny^2\n$$' }),
    });

    const blockSpecs: unknown[] = [];
    buildMarkdownDecorations(view).between(0, view.state.doc.length, (_from, _to, deco) => {
      if ((deco.spec as { block?: boolean }).block) blockSpecs.push(deco.spec);
    });

    view.destroy();
    expect(blockSpecs).toEqual([]);
  });

  it('provides block math decorations through the direct state field', () => {
    const state = EditorState.create({
      doc: 'intro\n$$\ny^2\n$$',
      extensions: [markdownBlockDecoField],
    });
    const specs: unknown[] = [];

    state.field(markdownBlockDecoField).between(0, state.doc.length, (_from, _to, deco) => {
      if ((deco.spec as { block?: boolean }).block) specs.push(deco.spec);
    });

    expect(specs).toHaveLength(1);
  });

  it('reveals block math source when the rendered block is clicked', () => {

    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'intro\n$$\ny^2\n$$',
        extensions: [markdownBlockDecoField],
      }),
    });

    const widget = parent.querySelector('.cm-math-block-widget');
    expect(widget).toBeInstanceOf(HTMLElement);

    widget?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(view.state.selection.main.head).toBe(6);
    const blockSpecs: unknown[] = [];
    view.state.field(markdownBlockDecoField).between(0, view.state.doc.length, (_from, _to, deco) => {
      if ((deco.spec as { block?: boolean }).block) blockSpecs.push(deco.spec);
    });
    expect(blockSpecs).toEqual([]);

    view.destroy();
  });

  it('shows a copy button on inactive fenced code blocks in the markdown editor', async () => {
    window.t = ((key: string) => {
      if (key === 'attach.copy') return 'Copy';
      if (key === 'attach.copied') return 'Copied';
      return key;
    }) as typeof window.t;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          'intro',
          '```ts',
          'const x = 1;',
          '```',
        ].join('\n'),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownDecoPlugin,
        ],
      }),
    });

    let button: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      button = parent.querySelector<HTMLButtonElement>('.cm-codeblock-copy-btn');
      expect(button).toBeInstanceOf(HTMLButtonElement);
    });

    expect(button?.querySelector('svg.cm-codeblock-copy-icon')).toBeInstanceOf(SVGSVGElement);
    expect(button?.querySelector('.cm-codeblock-copy-label')?.textContent).toBe('Copy');
    expect(button?.getAttribute('aria-label')).toBe('Copy');
    button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('const x = 1;');
    expect(button?.dataset.copied).toBe('true');
    expect(button?.querySelector('.cm-codeblock-copy-label')?.textContent).toBe('Copied');
    expect(button?.getAttribute('aria-label')).toBe('Copied');

    view.destroy();
  });
});
