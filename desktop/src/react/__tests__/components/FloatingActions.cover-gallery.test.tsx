/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COVER_GALLERY_PRESETS } from '../../../../../shared/cover-gallery-presets.ts';
import { COVER_GALLERY_ITEMS } from '../../components/preview/cover-gallery-assets';
import { FloatingActions } from '../../components/preview/FloatingActions';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  gsapFetch: vi.fn(),
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: mocks.gsapFetch,
}));

describe('FloatingActions cover gallery', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      selectFiles: vi.fn(async () => ['/tmp/local-cover.png']),
      readFile: vi.fn(async () => null),
      readFileSnapshot: vi.fn(async () => null),
    } as never;
    mocks.gsapFetch.mockReset();
    mocks.gsapFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/desk/beautify/status')) {
        return new Response(JSON.stringify({
          systemCover: { available: true },
          agentGenerate: { available: true, enabled: true, executorAgentId: 'agent-1' },
          available: true,
          enabled: true,
          agentId: 'agent-1',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, cover: { image: '文本附件/demo-cover.jpg' } }), { status: 200 });
    });
    useStore.setState({ currentAgentId: 'agent-1' } as never);
  });

  afterEach(() => {
    cleanup();
    useStore.setState({ currentAgentId: null } as never);
  });

  it('keeps every shared preset mapped to a renderer asset', () => {
    expect(COVER_GALLERY_ITEMS).toHaveLength(COVER_GALLERY_PRESETS.length);
    expect(COVER_GALLERY_ITEMS.every(item => item.src && item.id)).toBe(true);
  });

  it('opens the system preset gallery and applies the selected preset', async () => {
    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText('制作 cover')).toBeInTheDocument());
    expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/desk/beautify/status');
    expect(mocks.gsapFetch).not.toHaveBeenCalledWith('/api/desk/beautify/status?executorAgentId=agent-1');
    fireEvent.click(screen.getByLabelText('制作 cover'));
    expect(screen.getByRole('button', { name: 'AI 生成' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '封面图库' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '自己上传' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '封面图库' }));

    expect(screen.getByRole('dialog', { name: '封面图库' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: COVER_GALLERY_PRESETS[0].title }));

    await waitFor(() => {
      expect(mocks.gsapFetch).toHaveBeenCalledWith(
        '/api/desk/beautify/cover/preset/apply',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            filePath: '/tmp/note.md',
            presetId: COVER_GALLERY_PRESETS[0].id,
          }),
        }),
      );
    });
  });

  it('removes a gallery preset when its thumbnail fails to load', async () => {
    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText('制作 cover')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('制作 cover'));
    fireEvent.click(screen.getByRole('button', { name: '封面图库' }));

    const firstItem = COVER_GALLERY_ITEMS[0];
    const itemButton = screen.getByRole('button', { name: firstItem.title });
    const image = itemButton.querySelector('img');
    expect(image).toBeTruthy();

    fireEvent.error(image as HTMLImageElement);

    expect(screen.queryByRole('button', { name: firstItem.title })).not.toBeInTheDocument();
  });

  it('keeps system cover actions visible when AI generation is disabled', async () => {
    mocks.gsapFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/desk/beautify/status')) {
        return new Response(JSON.stringify({
          systemCover: { available: true },
          agentGenerate: {
            available: true,
            enabled: false,
            executorAgentId: 'agent-1',
            disabledReason: 'default-image-model-missing',
          },
          available: true,
          enabled: false,
          agentId: 'agent-1',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, cover: { image: '文本附件/demo-cover.jpg' } }), { status: 200 });
    });

    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText(/cover/)).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/cover/));

    const generateButton = screen.getByRole('button', { name: /AI/ });
    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(generateButton).toBeDisabled());
    expect(generateButton).toHaveAttribute('title', '尚未配置默认图片模型。');
    expect(screen.getByRole('button', { name: '封面图库' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '自己上传' })).toBeEnabled();

    fireEvent.click(generateButton);
    expect(mocks.gsapFetch).not.toHaveBeenCalledWith(
      '/api/desk/beautify/cover',
      expect.anything(),
    );
  });

  it('refreshes stale disabled AI generation status when the cover menu opens', async () => {
    mocks.gsapFetch.mockReset();
    mocks.gsapFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        systemCover: { available: true },
        agentGenerate: {
          available: true,
          enabled: false,
          executorAgentId: 'agent-1',
          disabledReason: 'default-image-model-invalid',
          message: 'Media model "tu/gptimage2" not found',
        },
        available: true,
        enabled: false,
        agentId: 'agent-1',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        systemCover: { available: true },
        agentGenerate: {
          available: true,
          enabled: true,
          executorAgentId: 'agent-1',
          imageModel: { providerId: 'minimax', modelId: 'image-01' },
          imageModelFallbackFrom: { provider: 'tu', id: 'gptimage2' },
          imageModelFallbackReason: 'Media model "tu/gptimage2" not found',
        },
        available: true,
        enabled: true,
        agentId: 'agent-1',
      }), { status: 200 }));

    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText(/cover/));

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledTimes(2));
    const generateButton = screen.getByRole('button', { name: /AI/ });
    expect(generateButton).toBeEnabled();
    expect(generateButton.getAttribute('title')).not.toContain('tu/gptimage2');
  });

  it('applies an uploaded cover without sending agent scope', async () => {
    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText('制作 cover')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('制作 cover'));
    fireEvent.click(screen.getByRole('button', { name: '自己上传' }));

    await waitFor(() => {
      expect(mocks.gsapFetch).toHaveBeenCalledWith(
        '/api/desk/beautify/cover/apply',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            filePath: '/tmp/note.md',
            imageFilePath: '/tmp/local-cover.png',
          }),
        }),
      );
    });
  });

  it('keeps the upload cover action working through the browser file input fallback', async () => {
    window.platform = {
      readFile: vi.fn(async () => null),
      readFileSnapshot: vi.fn(async () => null),
    } as never;
    const { container } = render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText('制作 cover')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('制作 cover'));
    fireEvent.click(screen.getByRole('button', { name: '自己上传' }));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).toBeInTheDocument();
    fireEvent.change(input!, {
      target: {
        files: [new File(['cover-bytes'], 'local-cover.png', { type: 'image/png' })],
      },
    });

    await waitFor(() => {
      expect(mocks.gsapFetch).toHaveBeenCalledWith(
        '/api/desk/beautify/cover/apply',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"filename":"local-cover.png"'),
        }),
      );
    });
  });

  it('uses Chinese copy for the detach action', async () => {
    const onDetach = vi.fn();
    render(
      <FloatingActions
        content="# Demo\n"
        filePath="/tmp/note.md"
        contentType="markdown"
        editable
        onDetach={onDetach}
      />,
    );

    await waitFor(() => expect(screen.getByTitle('在独立窗口打开')).toBeInTheDocument());
    fireEvent.click(screen.getByTitle('在独立窗口打开'));
    expect(onDetach).toHaveBeenCalledTimes(1);
  });
});
