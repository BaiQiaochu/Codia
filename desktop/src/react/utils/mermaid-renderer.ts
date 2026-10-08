import type { MermaidConfig } from 'mermaid';
import { toggleFullscreenHosted } from './fullscreen-host';

interface MermaidRenderResult {
  svg: string;
  bindFunctions?: (element: Element) => void;
}

interface MermaidApi {
  initialize(config: MermaidConfig): void;
  render(id: string, source: string): Promise<MermaidRenderResult>;
}

type MermaidLoader = () => Promise<MermaidApi>;

const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
};

let mermaidPromise: Promise<MermaidApi> | null = null;
let testLoader: MermaidLoader | null = null;
let idSeq = 0;
let renderSeq = 0;

const MERMAID_TOOLBAR_VERSION = '2';
const MERMAID_ZOOM_MIN = 0.5;
const MERMAID_ZOOM_MAX = 4;
const MERMAID_ZOOM_STEP = 1.2;
const MERMAID_FALLBACK_WIDTH = 720;
const DEFAULT_DOWNLOAD_FILENAME = 'mermaid-diagram.svg';
const MERMAID_FIT_SCALE = 1;

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      const mermaid = testLoader
        ? await testLoader()
        : (await import('mermaid')).default;
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    })();
  }
  return mermaidPromise;
}

function nextMermaidId(): string {
  idSeq += 1;
  return `gsap-mermaid-${idSeq}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readSource(diagram: Element): string {
  return diagram.querySelector<HTMLElement>('.mermaid-source code')?.textContent || '';
}

function t(key: string): string {
  return (typeof window !== 'undefined' && typeof window.t === 'function')
    ? window.t(key)
    : key;
}

function tt(key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MERMAID_ZOOM_MAX, Math.max(MERMAID_ZOOM_MIN, value));
}

function readDiagramZoom(diagram: HTMLElement): number {
  const scale = Number(diagram.dataset.mermaidScale);
  return clampZoom(scale || 1);
}

function zoomLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

function parseSvgLength(value: string | null): number | null {
  if (!value) return null;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)(?:px)?\s*$/i.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readSvgViewBoxSize(svg: SVGElement): { width: number; height: number } | null {
  const viewBox = svg.getAttribute('viewBox');
  if (!viewBox) return null;
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  const width = parts[2];
  const height = parts[3];
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width, height }
    : null;
}

function readSvgViewBoxWidth(svg: SVGElement): number | null {
  return readSvgViewBoxSize(svg)?.width || null;
}

function readSvgNaturalWidth(svg: SVGElement, rendered: HTMLElement): number {
  const hostWidth = rendered.clientWidth;
  const candidates = [
    readSvgViewBoxWidth(svg),
    parseSvgLength(svg.getAttribute('width')),
    Number.isFinite(hostWidth) && hostWidth > 0 ? hostWidth : null,
    MERMAID_FALLBACK_WIDTH,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return candidates[0] || MERMAID_FALLBACK_WIDTH;
}

function applyDiagramZoom(diagram: HTMLElement, scale: number): void {
  const nextScale = clampZoom(scale);
  const rendered = ensureRenderedElement(diagram);
  const label = zoomLabel(nextScale);
  diagram.dataset.mermaidScale = String(nextScale);
  rendered.style.setProperty('--mermaid-svg-scale', String(nextScale));
  rendered.dataset.mermaidScaleLabel = label;

  const svg = rendered.querySelector<SVGElement>('svg');
  if (svg) {
    const width = Math.round(readSvgNaturalWidth(svg, rendered) * nextScale);
    rendered.style.setProperty('--mermaid-svg-width', `${width}px`);
    svg.style.width = 'var(--mermaid-svg-width, 100%)';
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
    svg.style.minWidth = '100%';
  }

  const reset = diagram.querySelector<HTMLButtonElement>('.mermaid-zoom-reset');
  if (reset) {
    reset.textContent = '⌖';
    reset.title = `${tt('mermaid.resetZoom', '适配')} ${label}`;
    reset.setAttribute('aria-label', `${tt('mermaid.resetZoom', '适配')} ${label}`);
  }
  const zoomOut = diagram.querySelector<HTMLButtonElement>('.mermaid-zoom-out');
  const zoomIn = diagram.querySelector<HTMLButtonElement>('.mermaid-zoom-in');
  if (zoomOut) zoomOut.disabled = nextScale <= MERMAID_ZOOM_MIN;
  if (zoomIn) zoomIn.disabled = nextScale >= MERMAID_ZOOM_MAX;
}

function bindWheelZoom(diagram: HTMLElement): void {
  const rendered = ensureRenderedElement(diagram);
  if (rendered.dataset.mermaidWheelZoomBound === 'true') return;
  rendered.dataset.mermaidWheelZoomBound = 'true';
  rendered.addEventListener('wheel', (event) => {
    if (!diagram.classList.contains('is-expanded') && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? MERMAID_ZOOM_STEP : 1 / MERMAID_ZOOM_STEP;
    applyDiagramZoom(diagram, readDiagramZoom(diagram) * direction);
  }, { passive: false });
}

function bindDragPan(diagram: HTMLElement): void {
  const rendered = ensureRenderedElement(diagram);
  if (rendered.dataset.mermaidDragPanBound === 'true') return;
  rendered.dataset.mermaidDragPanBound = 'true';

  let drag: null | {
    pointerId: number;
    clientX: number;
    clientY: number;
    scrollLeft: number;
    scrollTop: number;
  } = null;

  rendered.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, pre, code')) return;
    drag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: rendered.scrollLeft,
      scrollTop: rendered.scrollTop,
    };
    rendered.classList.add('is-panning');
    rendered.setPointerCapture?.(event.pointerId);
  });

  rendered.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    rendered.scrollLeft = drag.scrollLeft - (event.clientX - drag.clientX);
    rendered.scrollTop = drag.scrollTop - (event.clientY - drag.clientY);
  });

  const endDrag = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    rendered.classList.remove('is-panning');
    rendered.releasePointerCapture?.(event.pointerId);
  };

  rendered.addEventListener('pointerup', endDrag);
  rendered.addEventListener('pointercancel', endDrag);
}

function svgForDownload(diagram: HTMLElement): string | null {
  const svg = diagram.querySelector<SVGElement>('.mermaid-rendered svg');
  if (!svg) return null;
  const outer = svg.outerHTML;
  return outer.includes('xmlns=')
    ? outer
    : outer.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
}

function downloadRenderedSvg(diagram: HTMLElement): void {
  const svg = svgForDownload(diagram);
  if (!svg) return;
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(blob)
    : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = DEFAULT_DOWNLOAD_FILENAME;
  link.rel = 'noopener';
  link.click();
  if (objectUrl.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

function toggleDiagramExpanded(diagram: HTMLElement): void {
  const expanded = toggleFullscreenHosted(diagram);
  diagram.classList.toggle('is-expanded', expanded);
  const button = diagram.querySelector<HTMLButtonElement>('.mermaid-expand-toggle');
  if (button) {
    const label = expanded
      ? tt('mermaid.exitExpanded', 'Exit expanded view')
      : tt('mermaid.expand', 'Expand');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', expanded ? 'true' : 'false');
  }
}

function makeToolbarButton(
  className: string,
  labelKey: string,
  fallback: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  const label = tt(labelKey, fallback);
  button.type = 'button';
  button.className = `mermaid-toolbar-icon ${className}`;
  button.textContent = label;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

function ensureSourceToolbar(diagram: HTMLElement, sourceBlock: HTMLElement | null, source: string): void {
  const rendered = ensureRenderedElement(diagram);
  const existing = diagram.querySelector<HTMLElement>('.mermaid-source-toolbar');
  if (existing?.dataset.source === source && existing.dataset.version === MERMAID_TOOLBAR_VERSION) {
    applyDiagramZoom(diagram, readDiagramZoom(diagram));
    bindWheelZoom(diagram);
    bindDragPan(diagram);
    return;
  }
  existing?.remove();
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-source-toolbar';
  toolbar.dataset.source = source;
  toolbar.dataset.version = MERMAID_TOOLBAR_VERSION;

  const toggle = sourceBlock ? document.createElement('button') : null;
  if (toggle && sourceBlock) {
    toggle.type = 'button';
    toggle.className = 'mermaid-source-toggle mermaid-toolbar-text-button';
    toggle.textContent = `</> ${tt('mermaid.viewSource', '查看代码')}`;
    toggle.title = tt('mermaid.viewSource', '查看代码');
    toggle.setAttribute('aria-label', tt('mermaid.viewSource', '查看代码'));
    toggle.setAttribute('aria-expanded', sourceBlock.hasAttribute('hidden') ? 'false' : 'true');
    toggle.addEventListener('click', () => {
      const hidden = sourceBlock.hasAttribute('hidden');
      if (hidden) {
        sourceBlock.removeAttribute('hidden');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = `</> ${tt('mermaid.hideSource', '隐藏代码')}`;
        toggle.title = tt('mermaid.hideSource', '隐藏代码');
        toggle.setAttribute('aria-label', tt('mermaid.hideSource', '隐藏代码'));
      } else {
        sourceBlock.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = `</> ${tt('mermaid.viewSource', '查看代码')}`;
        toggle.title = tt('mermaid.viewSource', '查看代码');
        toggle.setAttribute('aria-label', tt('mermaid.viewSource', '查看代码'));
      }
    });
  }

  const download = makeToolbarButton('mermaid-download-svg', 'mermaid.downloadSvg', '下载 SVG', () => {
    downloadRenderedSvg(diagram);
  });
  download.textContent = '↓';
  const zoomOut = makeToolbarButton('mermaid-zoom-out', 'mermaid.zoomOut', '缩小', () => {
    applyDiagramZoom(diagram, readDiagramZoom(diagram) / MERMAID_ZOOM_STEP);
  });
  zoomOut.textContent = '−';
  const zoomIn = makeToolbarButton('mermaid-zoom-in', 'mermaid.zoomIn', '放大', () => {
    applyDiagramZoom(diagram, readDiagramZoom(diagram) * MERMAID_ZOOM_STEP);
  });
  zoomIn.textContent = '+';
  const zoomReset = makeToolbarButton('mermaid-zoom-reset', 'mermaid.resetZoom', '适配', () => {
    applyDiagramZoom(diagram, MERMAID_FIT_SCALE);
  });
  zoomReset.textContent = '⌖';
  const expand = makeToolbarButton('mermaid-expand-toggle', 'mermaid.expand', '展开', () => {
    toggleDiagramExpanded(diagram);
  });
  expand.textContent = '⛶';
  const copy = makeToolbarButton('mermaid-source-copy', 'mermaid.copySource', '复制源码', () => {
    void navigator.clipboard?.writeText?.(source);
  });
  copy.textContent = '⧉';
  copy.hidden = true;
  toolbar.append(download, zoomOut, zoomIn, zoomReset, expand);
  if (toggle) toolbar.append(toggle);
  if (source) toolbar.append(copy);
  diagram.insertBefore(toolbar, sourceBlock || rendered);
  applyDiagramZoom(diagram, readDiagramZoom(diagram));
  bindWheelZoom(diagram);
  bindDragPan(diagram);
}

function ensureRenderedElement(diagram: Element): HTMLElement {
  const existing = diagram.querySelector<HTMLElement>('.mermaid-rendered');
  if (existing) return existing;

  const rendered = document.createElement('div');
  rendered.className = 'mermaid-rendered';
  diagram.appendChild(rendered);
  return rendered;
}

function hasRenderedSvg(rendered: HTMLElement): boolean {
  return !!rendered.querySelector('svg');
}

function isStandaloneSvgCandidate(svg: SVGElement): boolean {
  if (svg.closest('.mermaid-diagram, .mermaid-source-toolbar, button, a, .katex, .katex-display')) return false;
  const viewBox = readSvgViewBoxSize(svg);
  const width = viewBox?.width || parseSvgLength(svg.getAttribute('width')) || 0;
  const height = viewBox?.height || parseSvgLength(svg.getAttribute('height')) || 0;
  return width >= 220 || height >= 160;
}

function ensureStandaloneSvgDiagram(svg: SVGElement): void {
  if (!isStandaloneSvgCandidate(svg)) return;

  const parent = svg.parentElement;
  if (!parent) return;
  const canReuseParent = parent.children.length === 1
    && !parent.matches('.md-content, .messageContent, article, section, main');
  const diagram = canReuseParent
    ? parent
    : document.createElement('div');

  if (!canReuseParent) {
    parent.insertBefore(diagram, svg);
  }
  diagram.classList.add('mermaid-diagram', 'markdown-svg-diagram');

  let rendered = diagram.querySelector<HTMLElement>(':scope > .mermaid-rendered');
  if (!rendered) {
    rendered = document.createElement('div');
    rendered.className = 'mermaid-rendered';
    diagram.appendChild(rendered);
  }
  if (svg.parentElement !== rendered) {
    rendered.appendChild(svg);
  }

  diagram.dataset.mermaidStatus = 'rendered';
  ensureSourceToolbar(diagram, null, '');
  applyDiagramZoom(diagram, readDiagramZoom(diagram));
}

async function renderMermaidDiagram(diagram: HTMLElement): Promise<void> {
  const source = readSource(diagram);
  const rendered = ensureRenderedElement(diagram);
  const sourceBlock = diagram.querySelector<HTMLElement>('.mermaid-source');
  const status = diagram.dataset.mermaidStatus;

  if (!source.trim()) {
    if (hasRenderedSvg(rendered)) {
      ensureSourceToolbar(diagram, sourceBlock, source);
      applyDiagramZoom(diagram, readDiagramZoom(diagram));
    }
    return;
  }
  if (status === 'loading' && diagram.dataset.mermaidSource === source) {
    return;
  }
  if (status === 'rendered'
      && diagram.dataset.mermaidSource === source
      && hasRenderedSvg(rendered)) {
    ensureSourceToolbar(diagram, sourceBlock, source);
    applyDiagramZoom(diagram, readDiagramZoom(diagram));
    return;
  }
  if (status === 'error' && diagram.dataset.mermaidSource === source && rendered.textContent) {
    return;
  }

  diagram.dataset.mermaidStatus = 'loading';
  diagram.dataset.mermaidSource = source;
  const currentRenderSeq = String(++renderSeq);
  diagram.dataset.mermaidRenderSeq = currentRenderSeq;
  diagram.classList.remove('is-rendered', 'is-error');
  rendered.textContent = '';

  try {
    const mermaid = await loadMermaid();
    const { svg, bindFunctions } = await mermaid.render(nextMermaidId(), source);
    if (diagram.dataset.mermaidRenderSeq !== currentRenderSeq || readSource(diagram) !== source) return;
    rendered.innerHTML = svg;
    bindFunctions?.(rendered);
    sourceBlock?.setAttribute('hidden', '');
    ensureSourceToolbar(diagram, sourceBlock, source);
    applyDiagramZoom(diagram, readDiagramZoom(diagram));
    diagram.dataset.mermaidStatus = 'rendered';
    diagram.classList.add('is-rendered');
  } catch (err) {
    if (diagram.dataset.mermaidRenderSeq !== currentRenderSeq || readSource(diagram) !== source) return;
    sourceBlock?.removeAttribute('hidden');
    rendered.textContent = `Mermaid diagram failed to render: ${errorMessage(err)}`;
    diagram.dataset.mermaidStatus = 'error';
    diagram.classList.add('is-error');
  }
}

export async function renderMermaidDiagrams(root: ParentNode | null): Promise<void> {
  if (!root) return;
  const diagrams = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-diagram'));
  await Promise.all(diagrams.map(renderMermaidDiagram));
  const standaloneSvgs = Array.from(root.querySelectorAll<SVGElement>('svg'));
  for (const svg of standaloneSvgs) {
    ensureStandaloneSvgDiagram(svg);
  }
}

export function __setMermaidLoaderForTests(loader: MermaidLoader | null): void {
  testLoader = loader;
  mermaidPromise = null;
  idSeq = 0;
}
