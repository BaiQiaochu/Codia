// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactRenderer } from '../../components/preview/PreviewRenderer';
import { useStore } from '../../stores';
import type { Artifact } from '../../types';

const mocks = vi.hoisted(() => ({
  gsapFetch: vi.fn(),
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: mocks.gsapFetch,
}));

const htmlArtifact: Artifact = {
  id: 'html-demo',
  type: 'html',
  title: 'demo.html',
  content: '<div>Hello</div>',
  filePath: '/tmp/demo.html',
  ext: 'html',
};

describe('ArtifactRenderer HTML isolation', () => {
  const originalPlatform = window.platform;
  const originalT = window.t;
  let legacyNativePreviewApi: {
    showHtmlPreview: ReturnType<typeof vi.fn>;
    updateHtmlPreviewBounds: ReturnType<typeof vi.fn>;
    closeHtmlPreview: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      settingsModal: { open: false, activeTab: 'agent' },
      deskBasePath: '/tmp',
      selectedFolder: null,
      homeFolder: null,
      workspaceFolders: [],
    } as never);
    legacyNativePreviewApi = {
      showHtmlPreview: vi.fn(async () => true),
      updateHtmlPreviewBounds: vi.fn(async () => true),
      closeHtmlPreview: vi.fn(async () => true),
    };
    window.platform = legacyNativePreviewApi as unknown as typeof window.platform;
    mocks.gsapFetch.mockReset();
    mocks.gsapFetch.mockResolvedValue(new Response(JSON.stringify({
      previewUrl: 'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    window.platform = originalPlatform;
    window.t = originalT;
  });

  it('registers HTML and renders the local preview document in a sandboxed iframe', async () => {
    const { container } = render(<ArtifactRenderer artifact={htmlArtifact} />);

    expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/preview/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'demo.html',
        content: '<div>Hello</div>',
        sourceFilePath: '/tmp/demo.html',
        sandboxRoot: '/tmp',
      }),
    });

    const iframe = container.querySelector<HTMLIFrameElement>('[data-html-preview-frame]');
    expect(iframe).toBeTruthy();
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(iframe).not.toHaveAttribute('srcdoc');

    await waitFor(() => {
      expect(iframe).toHaveAttribute(
        'src',
        'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token',
      );
    });

    expect(legacyNativePreviewApi.showHtmlPreview).not.toHaveBeenCalled();
    expect(legacyNativePreviewApi.updateHtmlPreviewBounds).not.toHaveBeenCalled();
    expect(legacyNativePreviewApi.closeHtmlPreview).not.toHaveBeenCalled();
  });

  it('keeps the iframe preview visible while the in-window settings modal is open', async () => {
    useStore.setState({
      settingsModal: { open: true, activeTab: 'skills' },
    } as never);

    const { container } = render(<ArtifactRenderer artifact={htmlArtifact} />);

    const iframe = container.querySelector<HTMLIFrameElement>('[data-html-preview-frame]');
    expect(iframe).toBeTruthy();

    await waitFor(() => {
      expect(iframe).toHaveAttribute(
        'src',
        'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token',
      );
    });

    expect(legacyNativePreviewApi.showHtmlPreview).not.toHaveBeenCalled();
    expect(legacyNativePreviewApi.closeHtmlPreview).not.toHaveBeenCalled();
  });

  it('uses a containing workspace folder as the HTML asset sandbox root', async () => {
    useStore.setState({
      deskBasePath: '',
      selectedFolder: null,
      homeFolder: null,
      workspaceFolders: ['/workspace/project'],
    } as never);

    render(<ArtifactRenderer artifact={{
      ...htmlArtifact,
      filePath: '/workspace/project/pages/demo.html',
    }} />);

    expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/preview/html', expect.objectContaining({
      body: JSON.stringify({
        title: 'demo.html',
        content: '<div>Hello</div>',
        sourceFilePath: '/workspace/project/pages/demo.html',
        sandboxRoot: '/workspace/project',
      }),
    }));
  });

  it('does not close the iframe preview when the in-window settings modal toggles', async () => {
    const { container, rerender } = render(<ArtifactRenderer artifact={htmlArtifact} />);

    const iframe = container.querySelector<HTMLIFrameElement>('[data-html-preview-frame]');
    expect(iframe).toBeTruthy();

    await waitFor(() => {
      expect(iframe).toHaveAttribute(
        'src',
        'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token',
      );
    });

    useStore.setState({
      settingsModal: { open: true, activeTab: 'skills' },
    } as never);
    rerender(<ArtifactRenderer artifact={htmlArtifact} />);

    expect(container.querySelector('[data-html-preview-frame]')).toBeTruthy();
    expect(legacyNativePreviewApi.showHtmlPreview).not.toHaveBeenCalled();
    expect(legacyNativePreviewApi.closeHtmlPreview).not.toHaveBeenCalled();

    useStore.setState({
      settingsModal: { open: false, activeTab: 'skills' },
    } as never);
    rerender(<ArtifactRenderer artifact={htmlArtifact} />);

    expect(container.querySelector('[data-html-preview-frame]')).toBeTruthy();
    expect(legacyNativePreviewApi.showHtmlPreview).not.toHaveBeenCalled();
    expect(legacyNativePreviewApi.closeHtmlPreview).not.toHaveBeenCalled();
  });
});
