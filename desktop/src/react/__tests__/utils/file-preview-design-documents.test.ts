// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openPreviewMock = vi.fn();
const openMediaViewerFromContextMock = vi.fn();

vi.mock('../../stores/preview-actions', () => ({
  openPreview: (...args: unknown[]) => openPreviewMock(...args),
}));

vi.mock('../../utils/open-media-viewer', () => ({
  openMediaViewerFromContext: (...args: unknown[]) => openMediaViewerFromContextMock(...args),
}));

describe('file preview design document support', () => {
  const originalPlatform = window.platform;

  beforeEach(() => {
    openPreviewMock.mockReset();
    openMediaViewerFromContextMock.mockReset();
    window.platform = {
      readDesignDocumentPreview: vi.fn(async () => ({
        kind: 'mindmap',
        format: 'XMind',
        title: 'plan.xmind',
        fileName: 'plan.xmind',
        filePath: 'C:/work/plan.xmind',
        ext: 'xmind',
        fileSize: 1234,
        canRenderNatively: true,
        summary: 'XMind mind map with 3 topics.',
        sections: [{ title: 'Topics', items: ['Plan', '  Phase 1'] }],
        warnings: [],
      })),
    } as unknown as typeof window.platform;
  });

  afterEach(() => {
    window.platform = originalPlatform;
    document.body.innerHTML = '';
  });

  it('opens XMind files through the built-in design document reader', async () => {
    const { openFilePreview } = await import('../../utils/file-preview');

    await openFilePreview('C:/work/plan.xmind', 'plan.xmind', 'xmind', { origin: 'desk' });

    expect(window.platform.readDesignDocumentPreview).toHaveBeenCalledWith('C:/work/plan.xmind');
    expect(openPreviewMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'file-C:/work/plan.xmind',
      type: 'design-document',
      title: 'plan.xmind',
      filePath: 'C:/work/plan.xmind',
      ext: 'xmind',
      content: expect.stringContaining('"format":"XMind"'),
    }));
  });

  it('falls back to file info when the design reader cannot parse the file', async () => {
    window.platform.readDesignDocumentPreview = vi.fn(async () => null) as typeof window.platform.readDesignDocumentPreview;
    const { openFilePreview } = await import('../../utils/file-preview');

    await openFilePreview('C:/work/model.max', 'model.max', 'max', { origin: 'desk' });

    expect(openPreviewMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'file-info',
      title: 'model.max',
      ext: 'max',
    }));
  });

  it('normalizes dotted uppercase extensions before reading preview content', async () => {
    window.platform = {
      readFileBase64: vi.fn(async () => 'pdf-base64'),
      getFileUrl: vi.fn(() => ''),
    } as unknown as typeof window.platform;
    const { readFileForPreviewWithVersion } = await import('../../utils/file-preview');

    await expect(readFileForPreviewWithVersion('C:/work/report.PDF', '.PDF')).resolves.toEqual({
      content: 'pdf-base64',
    });
    expect(window.platform.readFileBase64).toHaveBeenCalledWith('C:/work/report.PDF');
  });

  it('opens SVG files as diagram previews instead of the media viewer', async () => {
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file:///${filePath.replace(/\\/g, '/')}`),
    } as unknown as typeof window.platform;
    const { openFilePreview } = await import('../../utils/file-preview');

    await openFilePreview('C:/work/gsap-structure.svg', 'gsap-structure.svg', 'svg', { origin: 'desk' });

    expect(openMediaViewerFromContextMock).not.toHaveBeenCalled();
    expect(openPreviewMock).not.toHaveBeenCalled();
    const viewer = document.body.querySelector<HTMLElement>('.markdown-visual-diagram.is-expanded[data-fullscreen-hosted="true"]');
    expect(viewer).toBeTruthy();
    expect(viewer?.querySelector('img')?.getAttribute('src')).toContain('file:///C:/work/gsap-structure.svg');
    expect(Number(viewer?.dataset.markdownVisualScale)).toBeGreaterThan(1);
  });
});
