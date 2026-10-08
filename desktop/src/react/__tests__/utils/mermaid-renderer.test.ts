/**
 * @vitest-environment jsdom
 */

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setMermaidLoaderForTests,
  renderMermaidDiagrams,
} from '../../utils/mermaid-renderer';

describe('renderMermaidDiagrams', () => {
  const initialize = vi.fn();
  const render = vi.fn(async (id: string, source: string) => ({
    svg: `<svg data-id="${id}" viewBox="0 0 640 320"><text>${source}</text></svg>`,
  }));

  beforeEach(() => {
    document.body.innerHTML = '';
    (window as unknown as { t?: (key: string) => string }).t = (key: string) => key;
    initialize.mockClear();
    render.mockClear();
    __setMermaidLoaderForTests(async () => ({ initialize, render }));
  });

  afterEach(() => {
    delete (window as unknown as { t?: (key: string) => string }).t;
    __setMermaidLoaderForTests(null);
  });

  it('renders mermaid placeholders into SVG once per source', async () => {

    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
    }));
    expect(render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.mermaid-rendered svg')).toBeInstanceOf(SVGElement);
    expect(container.querySelector('.mermaid-source')).toHaveAttribute('hidden');

    await renderMermaidDiagrams(container);

    expect(render).toHaveBeenCalledTimes(1);
  });

  it('adds source toolbar controls for rendered diagrams', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    const source = container.querySelector('.mermaid-source');
    const toggle = container.querySelector<HTMLButtonElement>('.mermaid-source-toggle');
    const copy = container.querySelector<HTMLButtonElement>('.mermaid-source-copy');

    expect(toggle).toHaveTextContent('</> 查看代码');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(source).toHaveAttribute('hidden');

    toggle?.click();
    expect(toggle).toHaveTextContent('</> 隐藏代码');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(source).not.toHaveAttribute('hidden');

    copy?.click();
    expect(writeText).toHaveBeenCalledWith('graph TD\nA-->B');
  });

  it('adds diagram zoom and SVG download controls for rendered diagrams', async () => {
    const createObjectURL = vi.fn(() => 'blob:mermaid-diagram');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    const rendered = container.querySelector<HTMLElement>('.mermaid-rendered');
    const zoomOut = container.querySelector<HTMLButtonElement>('.mermaid-zoom-out');
    const reset = container.querySelector<HTMLButtonElement>('.mermaid-zoom-reset');
    const zoomIn = container.querySelector<HTMLButtonElement>('.mermaid-zoom-in');
    const download = container.querySelector<HTMLButtonElement>('.mermaid-download-svg');

    expect(zoomOut).toBeInstanceOf(HTMLButtonElement);
    expect(reset).toHaveTextContent('⌖');
    expect(reset).toHaveAttribute('aria-label', '适配 100%');
    expect(zoomIn).toBeInstanceOf(HTMLButtonElement);
    expect(download).toHaveTextContent('↓');
    expect(Array.from(container.querySelectorAll('.mermaid-source-toolbar button:not([hidden])')).map((button) => button.textContent)).toEqual([
      '↓',
      '−',
      '+',
      '⌖',
      '⛶',
      '</> 查看代码',
    ]);
    expect(rendered?.dataset.mermaidDragPanBound).toBe('true');
    expect(rendered?.style.getPropertyValue('--mermaid-svg-scale')).toBe('1');
    expect(rendered?.style.getPropertyValue('--mermaid-svg-width')).toBe('640px');
    expect(container.querySelector<SVGElement>('.mermaid-rendered svg')?.style.maxWidth).toBe('none');

    const expand = container.querySelector<HTMLButtonElement>('.mermaid-expand-toggle');
    const diagram = container.querySelector<HTMLElement>('.mermaid-diagram');
    expand?.click();
    expect(diagram?.parentElement).toBe(document.body);
    rendered?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    expect(rendered?.style.getPropertyValue('--mermaid-svg-scale')).toBe('1.2');
    expand?.click();
    expect(diagram?.parentElement).toBe(container);
    reset?.click();
    expect(rendered?.style.getPropertyValue('--mermaid-svg-scale')).toBe('1');

    zoomIn?.click();
    expect(reset).toHaveTextContent('⌖');
    expect(reset).toHaveAttribute('aria-label', '适配 120%');
    expect(rendered?.style.getPropertyValue('--mermaid-svg-scale')).toBe('1.2');
    expect(rendered?.style.getPropertyValue('--mermaid-svg-width')).toBe('768px');

    reset?.click();
    expect(reset).toHaveTextContent('⌖');
    expect(reset).toHaveAttribute('aria-label', '适配 100%');
    expect(rendered?.style.getPropertyValue('--mermaid-svg-scale')).toBe('1');
    expect(rendered?.style.getPropertyValue('--mermaid-svg-width')).toBe('640px');

    download?.click();
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('adds zoom controls to restored rendered-only diagrams without a source block', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram" data-mermaid-status="rendered">',
      '<div class="mermaid-rendered"><svg viewBox="0 0 640 320"><text>restored</text></svg></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).not.toHaveBeenCalled();
    expect(container.querySelector('.mermaid-source')).toBeNull();
    expect(Array.from(container.querySelectorAll('.mermaid-source-toolbar button:not([hidden])')).map((button) => button.textContent)).toEqual([
      '↓',
      '−',
      '+',
      '⌖',
      '⛶',
    ]);
    expect(container.querySelector<HTMLButtonElement>('.mermaid-zoom-in')).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector<HTMLButtonElement>('.mermaid-zoom-out')).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector<HTMLButtonElement>('.mermaid-download-svg')).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector<HTMLButtonElement>('.mermaid-source-toggle')).toBeNull();
    expect(container.querySelector<HTMLElement>('.mermaid-rendered')?.dataset.mermaidDragPanBound).toBe('true');
  });

  it('wraps standalone markdown SVG diagrams with zoom controls', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<p>好了，我来重新生成 G-SAP 功能结构图。</p>',
      '<svg viewBox="0 0 640 320"><text>G-SAP 功能结构图</text></svg>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).not.toHaveBeenCalled();
    const diagram = container.querySelector<HTMLElement>('.markdown-svg-diagram');
    expect(diagram).toBeInstanceOf(HTMLElement);
    expect(diagram?.querySelector('.mermaid-rendered svg text')?.textContent).toBe('G-SAP 功能结构图');
    expect(Array.from(diagram?.querySelectorAll('.mermaid-source-toolbar button:not([hidden])') || []).map((button) => button.textContent)).toEqual([
      '↓',
      '−',
      '+',
      '⌖',
      '⛶',
    ]);
    expect(diagram?.querySelector<HTMLButtonElement>('.mermaid-zoom-in')).toBeInstanceOf(HTMLButtonElement);
    expect(diagram?.querySelector<HTMLButtonElement>('.mermaid-zoom-out')).toBeInstanceOf(HTMLButtonElement);
    expect(diagram?.querySelector<HTMLButtonElement>('.mermaid-source-toggle')).toBeNull();
  });

  it('keeps the source toolbar stable when rendering the same source again', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);
    const toolbar = container.querySelector('.mermaid-source-toolbar');
    await renderMermaidDiagrams(container);

    expect(container.querySelector('.mermaid-source-toolbar')).toBe(toolbar);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('keeps source visible and shows an error when mermaid rendering fails', async () => {
    render.mockRejectedValueOnce(new Error('bad diagram'));

    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph Nope</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(container.querySelector('.mermaid-source')).not.toHaveAttribute('hidden');
    expect(container.querySelector('.mermaid-rendered')?.textContent).toContain('bad diagram');
  });

  it('rerenders a restored diagram when the SVG is missing for the same source', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram" data-mermaid-status="rendered" data-mermaid-source="graph TD\nA-->B">',
      '<pre class="mermaid-source" hidden><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.mermaid-rendered svg')).toBeInstanceOf(SVGElement);
  });

  it('rerenders when the source changes even if a previous SVG exists', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram" data-mermaid-status="rendered" data-mermaid-source="graph TD\nA-->B">',
      '<pre class="mermaid-source" hidden><code>graph TD\nA-->C</code></pre>',
      '<div class="mermaid-rendered"><svg><text>old</text></svg></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.mermaid-rendered text')?.textContent).toContain('A-->C');
  });

  it('does not let an older async render overwrite a newer source', async () => {
    let resolveFirst!: (value: { svg: string }) => void;
    render
      .mockImplementationOnce((_id: string, _source: string) => new Promise<{ svg: string }>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockImplementationOnce(async (_id: string, source: string) => ({
        svg: `<svg><text>${source}</text></svg>`,
      }));
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    const first = renderMermaidDiagrams(container);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    container.querySelector('.mermaid-source code')!.textContent = 'graph TD\nA-->C';
    await renderMermaidDiagrams(container);
    resolveFirst({ svg: '<svg><text>graph TD\nA-->B</text></svg>' });
    await first;

    expect(render).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.mermaid-rendered text')?.textContent).toContain('A-->C');
  });

  it('does not retry an unchanged failed diagram on observer-triggered rerenders', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram" data-mermaid-status="error" data-mermaid-source="graph TD\nA-->B">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered">Mermaid diagram failed to render: bad diagram</div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).not.toHaveBeenCalled();
  });
});
