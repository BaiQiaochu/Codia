/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactRenderer } from '../../components/preview/PreviewRenderer';
import { useStore } from '../../stores';
import type { PlatformApi } from '../../types';

const mocks = vi.hoisted(() => ({
  gsapFetch: vi.fn(),
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: mocks.gsapFetch,
}));

vi.mock('../../utils/file-preview', () => ({
  openFilePreview: vi.fn(),
}));

vi.mock('../../utils/preview-file-refresh', () => ({
  refreshPreviewItemsFromFile: vi.fn(async () => undefined),
}));

describe('markdown cover prompt in preview mode', () => {
  const originalPlatform = window.platform;
  const originalPrompt = window.prompt;
  const originalT = window.t;

  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    window.prompt = vi.fn(() => {
      throw new Error('prompt() is not supported');
    });
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
    } as unknown as PlatformApi;
    mocks.gsapFetch.mockReset();
    mocks.gsapFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      systemCover: { available: true },
      agentGenerate: { available: true, enabled: true, executorAgentId: 'agent-1' },
      available: true,
      enabled: true,
      agentId: 'agent-1',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    useStore.setState({ currentAgentId: 'agent-1' } as never);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    window.platform = originalPlatform;
    window.prompt = originalPrompt;
    window.t = originalT;
    useStore.setState({ currentAgentId: null } as never);
  });

  it('opens an in-app prompt dialog instead of native prompt for custom cover generation', async () => {
    const { container } = render(<ArtifactRenderer artifact={{
      id: 'md-cover-regenerate',
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
    fireEvent.contextMenu(cover!);
    fireEvent.click(screen.getByRole('button', { name: '自定义提示词生成图片' }));

    expect(window.prompt).not.toHaveBeenCalled();
    const dialog = document.querySelector('.markdown-cover-prompt-dialog') as HTMLElement | null;
    expect(dialog).toBeInstanceOf(HTMLElement);

    const textarea = dialog!.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '做成更清爽的科技蓝风格';
    fireEvent.input(textarea);
    fireEvent.click(dialog!.querySelector('.markdown-cover-prompt-primary') as HTMLButtonElement);

    await waitFor(() => {
      expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/desk/beautify/status');
      expect(mocks.gsapFetch).not.toHaveBeenCalledWith('/api/desk/beautify/status?executorAgentId=agent-1');
      expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/desk/beautify/cover', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          filePath: '/tmp/workspace/demo.md',
          themeTone: 'light',
          executorAgentId: 'agent-1',
          userGuidance: '做成更清爽的科技蓝风格',
        }),
      }));
    });
  });

  it('does not post cover generation from preview mode when beautify is disabled for the agent', async () => {
    const notices: Array<{ text: string; type: string }> = [];
    window.addEventListener('gsap-inline-notice', ((event: CustomEvent) => {
      notices.push(event.detail);
    }) as EventListener);
    mocks.gsapFetch.mockReset();
    mocks.gsapFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      systemCover: { available: true },
      agentGenerate: {
        available: true,
        enabled: false,
        executorAgentId: 'agent-1',
        disabledReason: 'beautify-disabled',
        message: 'beautify tool is disabled for this agent',
      },
      available: true,
      enabled: false,
      agentId: 'agent-1',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { container } = render(<ArtifactRenderer artifact={{
      id: 'md-cover-regenerate-disabled',
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
    fireEvent.contextMenu(cover!);
    fireEvent.click(screen.getByRole('button', { name: '自定义提示词生成图片' }));

    const dialog = document.querySelector('.markdown-cover-prompt-dialog') as HTMLElement;
    const textarea = dialog.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '做成更清爽的科技蓝风格';
    fireEvent.input(textarea);
    fireEvent.click(dialog.querySelector('.markdown-cover-prompt-primary') as HTMLButtonElement);

    await waitFor(() => {
      expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/desk/beautify/status');
      expect(mocks.gsapFetch).not.toHaveBeenCalledWith('/api/desk/beautify/status?executorAgentId=agent-1');
      expect(notices).toContainEqual({
        text: 'Cover 生成失败：beautify tool is disabled for this agent',
        type: 'error',
      });
    });
    expect(mocks.gsapFetch).not.toHaveBeenCalledWith('/api/desk/beautify/cover', expect.anything());
  });
});
