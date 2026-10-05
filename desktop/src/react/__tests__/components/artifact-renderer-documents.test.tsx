// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAppFileDragPayload, writeAppFileDragPayload } from '../../utils/app-file-drag';
import { ArtifactRenderer } from '../../components/preview/PreviewRenderer';
import type { Artifact, PlatformApi } from '../../types';

const mocks = vi.hoisted(() => ({
  gsapFetch: vi.fn(),
  openFilePreview: vi.fn(),
  refreshPreviewItemsFromFile: vi.fn(async () => undefined),
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: mocks.gsapFetch,
}));

vi.mock('../../utils/file-preview', () => ({
  openFilePreview: (...args: unknown[]) => mocks.openFilePreview(...args),
}));

vi.mock('../../utils/preview-file-refresh', () => ({
  refreshPreviewItemsFromFile: mocks.refreshPreviewItemsFromFile,
}));

function makePdfArtifact(content: string): Artifact {
  return {
    id: 'pdf-1',
    type: 'pdf',
    title: 'report.pdf',
    content,
    filePath: 'C:/docs/report.pdf',
    ext: 'pdf',
  };
}

function dataTransferStub() {
  const data = new Map<string, string>();
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) || '',
  } as unknown as DataTransfer;
}

function putWorkspaceImageOnDrag(dataTransfer: DataTransfer) {
  writeAppFileDragPayload(dataTransfer, {
    source: 'workspace',
    files: [{
      id: 'cover-source',
      name: 'cover-source.png',
      path: '/tmp/workspace/cover-source.png',
      mimeType: 'image/png',
    }],
  });
}

describe('ArtifactRenderer document previews', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalPlatform = window.platform;
  const originalT = window.t;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:pdf-preview');
    URL.revokeObjectURL = vi.fn();
    window.t = (key: string) => key;
    window.platform = {
      openFile: vi.fn(),
    } as unknown as PlatformApi;
    mocks.gsapFetch.mockReset();
    mocks.openFilePreview.mockReset();
    mocks.refreshPreviewItemsFromFile.mockClear();
  });

  afterEach(() => {
    cleanup();
    clearAppFileDragPayload();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    window.platform = originalPlatform;
    window.t = originalT;
  });

  it('shows a local fallback for invalid PDF content instead of throwing', () => {
    expect(() => render(<ArtifactRenderer artifact={makePdfArtifact('not valid base64')} />)).not.toThrow();

    expect(screen.getByRole('alert').textContent).toContain('Document preview unavailable');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('adds visual controls to SVG diagram previews rendered as markdown images', async () => {
    const { container } = render(<ArtifactRenderer artifact={{
      id: 'svg-diagram-test',
      type: 'markdown',
      title: 'diagram.svg',
      content: '![diagram.svg|640x320](<file:///C:/work/diagram.svg>)',
      ext: 'svg',
      kind: 'svg',
    }} />);

    await waitFor(() => {
      expect(container.querySelector('.markdown-visual-toolbar')).toBeTruthy();
    });
    expect(Array.from(container.querySelectorAll('.markdown-visual-toolbar button')).map(button => button.textContent)).toEqual([
      '↓',
      '−',
      '+',
      '⌖',
      '⛶',
    ]);
  });

  it('can open the invalid document with the default app from the fallback', () => {
    render(<ArtifactRenderer artifact={makePdfArtifact('')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open with default app' }));

    expect(window.platform.openFile).toHaveBeenCalledWith('C:/docs/report.pdf');
  });

  it('accepts PDF data URLs with whitespace and renders an iframe', () => {
    const payload = 'data:application/pdf;base64, JVBERi0xLjQK ';
    const { container } = render(<ArtifactRenderer artifact={makePdfArtifact(payload)} />);

    const iframe = container.querySelector('iframe.preview-pdf') as HTMLIFrameElement | null;
    expect(iframe?.getAttribute('src')).toBe('blob:pdf-preview#toolbar=0&navpanes=0');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('renders design document summaries without opening external applications', () => {
    const preview = {
      kind: 'cad',
      format: 'DXF',
      title: 'floor-plan.dxf',
      fileName: 'floor-plan.dxf',
      filePath: 'C:/plans/floor-plan.dxf',
      ext: 'dxf',
      fileSize: 2048,
      canRenderNatively: true,
      summary: 'DXF CAD drawing with 2 entities.',
      sections: [
        { title: 'Layers', items: ['Walls', 'Doors'] },
        { title: 'Entities', items: ['LINE: 1', 'CIRCLE: 1'] },
      ],
      warnings: [],
    };

    const { container } = render(<ArtifactRenderer artifact={{
      id: 'design-1',
      type: 'design-document',
      title: 'floor-plan.dxf',
      content: JSON.stringify(preview),
      filePath: 'C:/plans/floor-plan.dxf',
      ext: 'dxf',
    }} />);

    expect(container.querySelector('.preview-design-document')?.textContent).toContain('DXF');
    expect(container.querySelector('.preview-design-document')?.textContent).toContain('Walls');
    expect(container.querySelector('.preview-design-document')?.textContent).toContain('LINE: 1');
    expect(screen.queryByRole('button', { name: 'Open with default app' })).toBeNull();
  });

  it('renders XMind design documents as a visual mind map canvas', () => {
    const preview = {
      kind: 'mindmap',
      format: 'XMind',
      title: 'plan.xmind',
      fileName: 'plan.xmind',
      filePath: 'C:/plans/plan.xmind',
      ext: 'xmind',
      fileSize: 1024,
      canRenderNatively: true,
      summary: 'XMind mind map with 4 visible topics.',
      sections: [{
        title: 'Topics',
        items: [
          'Product Plan',
          '  Research',
          '    Users',
          '  Release',
        ],
      }],
      warnings: [],
    };

    const { container } = render(<ArtifactRenderer artifact={{
      id: 'xmind-1',
      type: 'design-document',
      title: 'plan.xmind',
      content: JSON.stringify(preview),
      filePath: 'C:/plans/plan.xmind',
      ext: 'xmind',
    }} />);

    expect(container.querySelector('.preview-mindmap-canvas')).toBeTruthy();
    expect(container.querySelector('.preview-mindmap-root')?.textContent).toContain('Product Plan');
    expect(Array.from(container.querySelectorAll('.preview-mindmap-node')).map(node => node.textContent)).toContain('Research');
    expect(container.querySelector('.preview-design-document-section')).toBeNull();
  });

  it('renders XMind empty states in Chinese and uses theme branch tokens', () => {
    const preview = {
      kind: 'mindmap',
      format: 'XMind',
      filePath: 'C:/plans/blank.xmind',
      ext: 'xmind',
      fileSize: 512,
      canRenderNatively: true,
      summary: '',
      sections: [],
      warnings: [],
    };

    const { container } = render(<ArtifactRenderer artifact={{
      id: 'xmind-empty',
      type: 'design-document',
      title: 'blank.xmind',
      content: JSON.stringify(preview),
      filePath: 'C:/plans/blank.xmind',
      ext: 'xmind',
    }} />);

    expect(container.querySelector('.preview-mindmap-root')?.textContent).toContain('思维导图');
    expect(container.querySelector('.preview-mindmap-empty')?.textContent).toContain('未提取到子主题。');
  });

  it('renders XMind branches with theme-aware color variables', () => {
    const preview = {
      kind: 'mindmap',
      format: 'XMind',
      title: 'theme-map.xmind',
      fileName: 'theme-map.xmind',
      ext: 'xmind',
      canRenderNatively: true,
      summary: 'XMind mind map with visible topics.',
      sections: [{
        title: 'Topics',
        items: ['主题', '  分支'],
      }],
      warnings: [],
    };

    const { container } = render(<ArtifactRenderer artifact={{
      id: 'xmind-theme',
      type: 'design-document',
      title: 'theme-map.xmind',
      content: JSON.stringify(preview),
      ext: 'xmind',
    }} />);

    const branch = container.querySelector('.preview-mindmap-branch') as HTMLElement | null;
    expect(branch?.style.getPropertyValue('--branch-color')).toBe('var(--preview-mindmap-branch-2)');
  });

  it('shows proprietary design document limits without failing the preview', () => {
    render(<ArtifactRenderer artifact={{
      id: 'design-2',
      type: 'design-document',
      title: 'scene.max',
      content: JSON.stringify({
        kind: 'three-d',
        format: '3ds Max',
        fileName: 'scene.max',
        ext: 'max',
        fileSize: 4096,
        canRenderNatively: false,
        summary: '3ds Max binary scene summary.',
        sections: [{ title: 'Readable strings', items: ['Camera_Main'] }],
        warnings: ['Native 3ds Max binary rendering is not available in the built-in reader.'],
      }),
      filePath: 'C:/models/scene.max',
      ext: 'max',
    }} />);

    expect(screen.getByText('3ds Max')).toBeTruthy();
    expect(screen.getByText('Camera_Main')).toBeTruthy();
    expect(screen.getByText(/Native 3ds Max binary rendering/)).toBeTruthy();
  });

  it('renders line numbers for read-only code previews', () => {
    const { container } = render(<ArtifactRenderer artifact={{
      id: 'code-1',
      type: 'code',
      title: 'chat.js',
      content: 'import x from "x";\n\nconsole.log(x);',
      language: 'js',
      ext: 'js',
    }} />);

    expect(container.querySelector('.preview-code-with-lines')).toBeTruthy();
    expect(Array.from(container.querySelectorAll('.preview-code-line-number')).map(el => el.textContent)).toEqual(['1', '2', '3']);
    expect(container.querySelector('.preview-code-line-content')?.textContent).toContain('import x');
  });

  it('registers HTML artifacts through the isolated preview route instead of srcDoc', async () => {
    const htmlContent = '<script src="https://cdn.tailwindcss.com"></script><div class="text-red-500">Hello</div>';
    mocks.gsapFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      previewUrl: 'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { container } = render(<ArtifactRenderer artifact={{
      id: 'html-demo',
      type: 'html',
      title: 'demo.html',
      content: htmlContent,
      filePath: '/tmp/demo.html',
      ext: 'html',
    }} />);

    expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/preview/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'demo.html',
        content: htmlContent,
        sourceFilePath: '/tmp/demo.html',
      }),
    });

    const iframe = container.querySelector('iframe') as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe?.hasAttribute('srcdoc')).toBe(false);
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');

    await waitFor(() => {
      expect(iframe?.getAttribute('src')).toBe('http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token');
    });
  });

  it.each(['docx', 'xlsx'] as const)('registers %s document HTML through the isolated preview route', async (type) => {
    const htmlContent = '<img src=x onerror="window.__owned = true"><table><tr><td>Cell</td></tr></table>';
    mocks.gsapFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      previewUrl: 'http://127.0.0.1:14500/preview/html/pv_doc?previewToken=preview_only_token',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { container } = render(<ArtifactRenderer artifact={{
      id: `${type}-demo`,
      type,
      title: `demo.${type}`,
      content: htmlContent,
      filePath: `/tmp/demo.${type}`,
      ext: type,
    }} />);

    expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/preview/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `demo.${type}`,
        content: htmlContent,
        sourceFilePath: `/tmp/demo.${type}`,
      }),
    });
    expect(container.querySelector('.preview-docx')).toBeNull();
    expect(container.querySelector('.preview-csv')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();

    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src'))
        .toBe('http://127.0.0.1:14500/preview/html/pv_doc?previewToken=preview_only_token');
    });
  });

  it('renders markdown cover frontmatter as a local image cover and removes raw YAML from the body', () => {
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
    } as unknown as PlatformApi;

    const { container } = render(<ArtifactRenderer artifact={{
      id: 'md-cover',
      type: 'markdown',
      title: '方案.md',
      content: [
        '---',
        'title: 方案',
        'cover:',
        '  image: 文本附件/demo-cover.jpg',
        '  displayHeight: 260',
        '  positionY: 41',
        '---',
        '# 矿山智能综合信息化管控平台开发方案',
      ].join('\n'),
      filePath: 'E:/workspace/方案.md',
      ext: 'md',
    }} />);

    const cover = container.querySelector('.markdown-cover') as HTMLElement | null;
    const image = container.querySelector('.markdown-cover img') as HTMLImageElement | null;
    const body = container.querySelector('.preview-markdown') as HTMLElement | null;

    expect(cover).toBeTruthy();
    expect(cover?.style.height).toBe('260px');
    expect(image?.getAttribute('src')).toBe('file://E:/workspace/文本附件/demo-cover.jpg');
    expect(image?.style.objectPosition).toBe('50% 41%');
    expect(body?.textContent).toContain('矿山智能综合信息化管控平台开发方案');
    expect(body?.textContent).not.toContain('cover:');
    expect(body?.textContent).not.toContain('文本附件/demo-cover.jpg');
  });

  it('marks markdown body rendered after a cover for cover-specific typography', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/preview/PreviewRenderer.tsx'),
      'utf8',
    );

    expect(source).toContain('preview-markdown md-content markdown-has-cover');
  });

  it('opens relative markdown links from artifact previews against the source file path', async () => {
    const { container } = render(<ArtifactRenderer artifact={{
      id: 'md-link',
      type: 'markdown',
      title: 'chapter.md',
      content: '[Cover](./assets/Cover%20Image.png#fig-1)',
      filePath: '/vault/notes/chapter.md',
      ext: 'md',
    }} />);

    const link = container.querySelector('a') as HTMLAnchorElement;
    fireEvent.click(link);

    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith(
        '/vault/notes/assets/Cover Image.png',
        'Cover',
        'png',
        expect.objectContaining({ origin: 'desk' }),
      );
    });
  });

  it('applies a workspace image dropped on an existing markdown cover', async () => {
    const dataTransfer = dataTransferStub();
    putWorkspaceImageOnDrag(dataTransfer);
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
    } as unknown as PlatformApi;
    mocks.gsapFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      cover: { image: '文本附件/demo-cover.png' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { container } = render(<ArtifactRenderer artifact={{
      id: 'md-cover-drop',
      type: 'markdown',
      title: 'demo.md',
      content: [
        '---',
        'cover:',
        '  image: cover.png',
        '---',
        '# Demo',
      ].join('\n'),
      filePath: '/tmp/workspace/demo.md',
      ext: 'md',
    }} />);

    const cover = container.querySelector('.markdown-cover') as HTMLElement | null;
    expect(cover).toBeTruthy();

    fireEvent.dragOver(cover!, { dataTransfer });
    expect(cover?.classList.contains('markdown-cover-drop-active')).toBe(true);
    fireEvent.drop(cover!, { dataTransfer });

    await waitFor(() => {
      expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/desk/beautify/cover/apply', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          filePath: '/tmp/workspace/demo.md',
          imageFilePath: '/tmp/workspace/cover-source.png',
          agentId: undefined,
        }),
      }));
    });
    await waitFor(() => {
      expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith('/tmp/workspace/demo.md');
    });
  });

  it('applies a workspace image dropped on the no-cover markdown top rail', async () => {
    const dataTransfer = dataTransferStub();
    putWorkspaceImageOnDrag(dataTransfer);
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
    } as unknown as PlatformApi;
    mocks.gsapFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      cover: { image: '文本附件/demo-cover.png' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { container } = render(<ArtifactRenderer artifact={{
      id: 'md-no-cover-drop',
      type: 'markdown',
      title: 'demo.md',
      content: '# Demo',
      filePath: '/tmp/workspace/demo.md',
      ext: 'md',
    }} />);

    const host = container.querySelector('.markdown-cover-drop-host') as HTMLElement | null;
    const rail = container.querySelector('.markdown-cover-drop-rail') as HTMLElement | null;
    expect(host).toBeTruthy();
    expect(rail).toBeTruthy();

    fireEvent.dragOver(host!, { dataTransfer, clientY: 12 });
    expect(rail?.classList.contains('markdown-cover-drop-rail-active')).toBe(true);
    fireEvent.drop(host!, { dataTransfer, clientY: 12 });

    await waitFor(() => {
      expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/desk/beautify/cover/apply', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          filePath: '/tmp/workspace/demo.md',
          imageFilePath: '/tmp/workspace/cover-source.png',
          agentId: undefined,
        }),
      }));
    });
    await waitFor(() => {
      expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith('/tmp/workspace/demo.md');
    });
  });

  it('localizes markdown cover actions and deletes cover frontmatter', async () => {
    window.t = (key: string) => ({
      'preview.cover.saveImage': 'Save image',
      'preview.cover.regenerateWithPrompt': 'Generate image with custom prompt',
      'preview.cover.deleteCover': 'Delete cover',
    }[key] || key);
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
      writeFileIfUnchanged: vi.fn(async () => ({ ok: true, version: 'v2' })),
    } as unknown as PlatformApi;

    const content = [
      '---',
      'cover:',
      '  image: cover.png',
      '  displayHeight: 260',
      '---',
      '# Demo',
    ].join('\n');
    const { container } = render(<ArtifactRenderer artifact={{
      id: 'md-cover-delete',
      type: 'markdown',
      title: 'demo.md',
      content,
      filePath: '/tmp/workspace/demo.md',
      ext: 'md',
      fileVersion: { mtimeMs: 1, size: content.length, sha256: 'v1' },
    }} />);

    const cover = container.querySelector('.markdown-cover') as HTMLElement | null;
    expect(cover).toBeTruthy();
    fireEvent.contextMenu(cover!);

    expect(screen.getByRole('button', { name: 'Save image' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate image with custom prompt' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete cover' }));

    await waitFor(() => {
      expect(window.platform?.writeFileIfUnchanged).toHaveBeenCalledWith(
        '/tmp/workspace/demo.md',
        expect.not.stringContaining('cover:'),
        expect.objectContaining({ mtimeMs: 1, size: content.length, sha256: 'v1' }),
      );
    });
    const [, nextContent] = (window.platform?.writeFileIfUnchanged as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(nextContent).toContain('# Demo');
  });
});
