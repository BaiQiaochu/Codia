import { setFullscreenHosted, toggleFullscreenHosted } from './fullscreen-host';

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const SCALE_STEP = 1.2;
const DEFAULT_IMAGE_WIDTH = 720;

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function parseSize(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveImageSource(img: HTMLImageElement): string {
  return (img.currentSrc || img.src || img.getAttribute('src') || '').trim();
}

function extensionFromSource(src: string): string {
  if (/^data:image\/svg\+xml/i.test(src)) return '.svg';
  if (/^data:image\/png/i.test(src)) return '.png';
  if (/^data:image\/jpe?g/i.test(src)) return '.jpg';
  if (/^data:image\/webp/i.test(src)) return '.webp';
  try {
    const pathname = new URL(src, window.location.href).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,6})$/i);
    return match ? `.${match[1].toLowerCase()}` : '.png';
  } catch {
    const match = src.split(/[?#]/)[0].match(/\.([a-z0-9]{2,6})$/i);
    return match ? `.${match[1].toLowerCase()}` : '.png';
  }
}

function safeFilename(value: string): string {
  const trimmed = value.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ');
  return trimmed || 'diagram';
}

function downloadNameForImage(img: HTMLImageElement, src: string): string {
  const alt = img.getAttribute('alt')?.trim();
  const ext = extensionFromSource(src);
  if (alt) return `${safeFilename(alt)}${alt.toLowerCase().endsWith(ext) ? '' : ext}`;
  try {
    const url = new URL(src, window.location.href);
    const base = decodeURIComponent(url.pathname.split('/').pop() || '');
    if (base) return safeFilename(base);
  } catch {
    const base = src.split(/[\\/]/).pop()?.split(/[?#]/)[0] || '';
    if (base) return safeFilename(base);
  }
  return `diagram${ext}`;
}

function imageBaseWidth(img: HTMLImageElement): number {
  return (
    parseSize(img.getAttribute('width'))
    || img.naturalWidth
    || img.clientWidth
    || parseSize(img.style.width)
    || DEFAULT_IMAGE_WIDTH
  );
}

function imageBaseHeight(img: HTMLImageElement): number {
  const explicitHeight = parseSize(img.getAttribute('height'));
  if (explicitHeight) return explicitHeight;

  const explicitWidth = parseSize(img.getAttribute('width'));
  if (explicitWidth && img.naturalWidth > 0 && img.naturalHeight > 0) {
    return Math.round(explicitWidth * (img.naturalHeight / img.naturalWidth));
  }

  return (
    img.naturalHeight
    || img.clientHeight
    || parseSize(img.style.height)
    || Math.round(imageBaseWidth(img) * 0.75)
  );
}

function viewportSize(axis: 'width' | 'height'): number {
  if (typeof window === 'undefined') return axis === 'width' ? DEFAULT_IMAGE_WIDTH : 540;
  const value = axis === 'width' ? window.innerWidth : window.innerHeight;
  return Number.isFinite(value) && value > 0 ? value : (axis === 'width' ? DEFAULT_IMAGE_WIDTH : 540);
}

function stageAvailableSize(stage: HTMLElement, axis: 'width' | 'height'): number {
  const rect = stage.getBoundingClientRect();
  const measured = axis === 'width'
    ? (stage.clientWidth || rect.width)
    : (stage.clientHeight || rect.height);
  if (Number.isFinite(measured) && measured > 0) return measured;
  return Math.max(1, viewportSize(axis) - (axis === 'width' ? 96 : 150));
}

function shouldSkipImage(img: HTMLImageElement): boolean {
  if (!resolveImageSource(img)) return true;
  if (img.closest('.markdown-visual-diagram, .mermaid-diagram, .mermaid-source-toolbar, button, a, .katex, .katex-display')) return true;
  const explicitWidth = parseSize(img.getAttribute('width'));
  const explicitHeight = parseSize(img.getAttribute('height'));
  if (explicitWidth !== null && explicitHeight !== null && explicitWidth <= 96 && explicitHeight <= 96) return true;
  return false;
}

function makeButton(label: string, title: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'markdown-visual-toolbar-button';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', onClick);
  return button;
}

function setImageScale(wrapper: HTMLElement, stage: HTMLElement, img: HTMLImageElement, nextScale: number): void {
  const scale = clampScale(nextScale);
  const width = Math.round(imageBaseWidth(img) * scale);
  wrapper.dataset.markdownVisualScale = String(scale);
  stage.style.setProperty('--markdown-visual-width', `${width}px`);
  img.style.width = 'var(--markdown-visual-width)';
  img.style.maxWidth = 'none';
  img.style.height = 'auto';
}

function fitImageToStage(wrapper: HTMLElement, stage: HTMLElement, img: HTMLImageElement): void {
  const baseWidth = imageBaseWidth(img);
  const baseHeight = imageBaseHeight(img);
  const availableWidth = Math.max(1, stageAvailableSize(stage, 'width') - 24);
  const availableHeight = Math.max(1, stageAvailableSize(stage, 'height') - 24);
  const nextScale = Math.min(availableWidth / baseWidth, availableHeight / baseHeight);

  setImageScale(wrapper, stage, img, nextScale);
  stage.scrollLeft = 0;
  stage.scrollTop = 0;
}

function currentScale(wrapper: HTMLElement): number {
  const value = Number.parseFloat(wrapper.dataset.markdownVisualScale || '1');
  return Number.isFinite(value) ? value : 1;
}

function downloadImage(img: HTMLImageElement): void {
  const src = resolveImageSource(img);
  if (!src) return;
  const anchor = document.createElement('a');
  anchor.href = src;
  anchor.download = downloadNameForImage(img, src);
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function bindDragPan(stage: HTMLElement): () => void {
  let active = false;
  let startX = 0;
  let startY = 0;
  let startScrollLeft = 0;
  let startScrollTop = 0;

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    active = true;
    startX = event.clientX;
    startY = event.clientY;
    startScrollLeft = stage.scrollLeft;
    startScrollTop = stage.scrollTop;
    stage.classList.add('is-panning');
    stage.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!active) return;
    event.preventDefault();
    stage.scrollLeft = startScrollLeft - (event.clientX - startX);
    stage.scrollTop = startScrollTop - (event.clientY - startY);
  };

  const stop = (event: PointerEvent) => {
    if (!active) return;
    active = false;
    stage.classList.remove('is-panning');
    stage.releasePointerCapture?.(event.pointerId);
  };

  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);

  return () => {
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerup', stop);
    stage.removeEventListener('pointercancel', stop);
  };
}

function bindWheelZoom(wrapper: HTMLElement, stage: HTMLElement, img: HTMLImageElement): () => void {
  const onWheel = (event: WheelEvent) => {
    if (!wrapper.classList.contains('is-expanded') && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP;
    setImageScale(wrapper, stage, img, currentScale(wrapper) * direction);
  };
  stage.addEventListener('wheel', onWheel, { passive: false });
  return () => stage.removeEventListener('wheel', onWheel);
}

function enhanceImage(img: HTMLImageElement, cleanups: Array<() => void>): void {
  if (shouldSkipImage(img)) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'markdown-visual-diagram';
  wrapper.dataset.markdownVisualScale = '1';

  const toolbar = document.createElement('div');
  toolbar.className = 'markdown-visual-toolbar';
  toolbar.setAttribute('aria-label', '图表预览工具');

  const stage = document.createElement('div');
  stage.className = 'markdown-visual-stage';

  const download = makeButton('↓', '下载图片', (event) => {
    event.preventDefault();
    event.stopPropagation();
    downloadImage(img);
  });
  const zoomOut = makeButton('−', '缩小', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setImageScale(wrapper, stage, img, currentScale(wrapper) / SCALE_STEP);
  });
  const zoomIn = makeButton('+', '放大', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setImageScale(wrapper, stage, img, currentScale(wrapper) * SCALE_STEP);
  });
  const fit = makeButton('⌖', '适配宽度', (event) => {
    event.preventDefault();
    event.stopPropagation();
    fitImageToStage(wrapper, stage, img);
  });
  const expand = makeButton('⛶', '展开查看', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const expanded = toggleFullscreenHosted(wrapper);
    wrapper.classList.toggle('is-expanded', expanded);
  });

  toolbar.append(download, zoomOut, zoomIn, fit, expand);

  const originalParent = img.parentElement;
  const replaceWholeParagraph = originalParent?.tagName === 'P'
    && originalParent.textContent?.trim() === ''
    && originalParent.querySelectorAll('img').length === 1;
  const insertionTarget = replaceWholeParagraph ? originalParent : img;
  insertionTarget.parentNode?.insertBefore(wrapper, insertionTarget);
  wrapper.append(toolbar, stage);
  stage.appendChild(img);
  if (replaceWholeParagraph) originalParent?.remove();

  setImageScale(wrapper, stage, img, 1);
  const onLoad = () => setImageScale(wrapper, stage, img, currentScale(wrapper));
  img.addEventListener('load', onLoad);
  cleanups.push(() => img.removeEventListener('load', onLoad));
  cleanups.push(() => setFullscreenHosted(wrapper, false));
  cleanups.push(bindWheelZoom(wrapper, stage, img));
  cleanups.push(bindDragPan(stage));
}

export function bindMarkdownVisualControls(container: HTMLElement): () => void {
  const cleanups: Array<() => void> = [];
  const images = Array.from(container.querySelectorAll<HTMLImageElement>('img'));
  for (const img of images) enhanceImage(img, cleanups);
  return () => {
    for (const dispose of cleanups) dispose();
  };
}

export function openMarkdownVisualFullscreen({
  src,
  title = 'diagram.svg',
}: {
  src: string;
  title?: string;
}): () => void {
  if (typeof document === 'undefined') return () => {};

  const host = document.createElement('div');
  host.hidden = true;
  host.className = 'markdown-visual-standalone-host';

  const img = document.createElement('img');
  img.src = src;
  img.alt = title;

  host.appendChild(img);
  document.body.appendChild(host);

  const disposeControls = bindMarkdownVisualControls(host);
  const wrapper = host.querySelector<HTMLElement>('.markdown-visual-diagram');
  if (!wrapper) {
    disposeControls();
    host.remove();
    return () => {};
  }

  const closeButton = wrapper.querySelector<HTMLButtonElement>('.markdown-visual-toolbar button:last-child');
  const stage = wrapper.querySelector<HTMLElement>('.markdown-visual-stage');
  let fitFrame: number | null = null;
  let closed = false;

  const fitStandaloneImage = () => {
    fitFrame = null;
    if (closed || !stage) return;
    fitImageToStage(wrapper, stage, img);
  };

  const scheduleStandaloneFit = () => {
    if (fitFrame !== null) return;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      fitFrame = window.requestAnimationFrame(fitStandaloneImage);
      return;
    }
    fitStandaloneImage();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (fitFrame !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(fitFrame);
    }
    document.removeEventListener('keydown', handleKeydown, true);
    img.removeEventListener('load', scheduleStandaloneFit);
    closeButton?.removeEventListener('click', handleCloseClick, true);
    disposeControls();
    wrapper.remove();
    host.remove();
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const handleCloseClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  };

  if (closeButton) {
    closeButton.textContent = '×';
    closeButton.title = '关闭';
    closeButton.setAttribute('aria-label', '关闭');
    closeButton.addEventListener('click', handleCloseClick, true);
  }

  document.addEventListener('keydown', handleKeydown, true);
  setFullscreenHosted(wrapper, true);
  wrapper.classList.add('is-expanded', 'is-standalone');
  fitStandaloneImage();
  if (!img.complete) img.addEventListener('load', scheduleStandaloneFit);
  scheduleStandaloneFit();
  return close;
}
