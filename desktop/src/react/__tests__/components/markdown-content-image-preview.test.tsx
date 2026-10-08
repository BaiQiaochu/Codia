// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const openMediaViewerForRefMock = vi.fn();

vi.mock('../../utils/open-media-viewer', () => ({
  openMediaViewerForRef: (...args: unknown[]) => openMediaViewerForRefMock(...args),
}));

describe('MarkdownContent image preview', () => {
  beforeEach(() => {
    openMediaViewerForRefMock.mockReset();
    delete (window as unknown as { platform?: unknown }).platform;
    useStore.getState().setRightWorkspaceTab('workspace');
    useStore.getState().setJianDrawerOpen(false);
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('opens markdown images in the media viewer on click', async () => {
    const { MarkdownContent } = await import('../../components/chat/MarkdownContent');

    const { container } = render(
      <MarkdownContent html={'<p><img src="https://example.com/assets/chart.png?size=2" alt="图表" /></p>'} />,
    );

    const image = container.querySelector('img') as HTMLImageElement;
    fireEvent.click(image);

    expect(openMediaViewerForRefMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'markdown-image:https://example.com/assets/chart.png?size=2',
        kind: 'image',
        source: 'desk',
        name: '图表',
        path: 'https://example.com/assets/chart.png?size=2',
      }),
      { origin: 'desk' },
    );
  });

  it('adds zoom and download controls to large markdown images', async () => {
    const { MarkdownContent } = await import('../../components/chat/MarkdownContent');

    const { container } = render(
      <MarkdownContent html={'<p><img src="https://example.com/assets/chart.png" alt="功能结构图" width="640" height="320" /></p>'} />,
    );

    const toolbar = container.querySelector('.markdown-visual-toolbar');
    expect(toolbar).toBeTruthy();
    expect(Array.from(toolbar?.querySelectorAll('button') || []).map(button => button.textContent)).toEqual([
      '↓',
      '−',
      '+',
      '⌖',
      '⛶',
    ]);

    const wrapper = container.querySelector<HTMLElement>('.markdown-visual-diagram');
    fireEvent.click(screen.getByLabelText('放大'));
    expect(wrapper?.dataset.markdownVisualScale).toBe('1.2');

    fireEvent.click(screen.getByLabelText('展开查看'));
    expect(wrapper?.parentElement).toBe(document.body);
    const stage = wrapper?.querySelector<HTMLElement>('.markdown-visual-stage');
    fireEvent.wheel(stage as HTMLElement, { deltaY: -100 });
    expect(wrapper?.dataset.markdownVisualScale).toBe('1.44');
  });

  it('does not route inline svg images through the media viewer', async () => {
    const { MarkdownContent } = await import('../../components/chat/MarkdownContent');

    const { container } = render(
      <MarkdownContent html={'<p><img src="data:image/svg+xml;base64,PHN2Zy8+" width="640" height="320" /></p>'} />,
    );

    const image = container.querySelector('img') as HTMLImageElement;
    fireEvent.keyDown(image, { key: 'Enter' });

    expect(openMediaViewerForRefMock).not.toHaveBeenCalled();
    expect(container.querySelector('.markdown-visual-toolbar')).toBeTruthy();
  });

  it('opens local skill links through the skill viewer without showing the hidden link preview tab', async () => {
    const openSkillViewer = vi.fn();
    const openExternal = vi.fn();
    const openFile = vi.fn();
    (window as unknown as { platform?: unknown }).platform = {
      openSkillViewer,
      openExternal,
      openFile,
    };
    const { MarkdownContent } = await import('../../components/chat/MarkdownContent');

    const { container } = render(
      <MarkdownContent html={'<p><a href="C:%5CUsers%5Croce%5C.gsap%5Cagents%5Cgsap%5Clearned-skills%5Cskill-a%5CSKILL.md">$skill-link</a></p>'} />,
    );

    const link = container.querySelector('a') as HTMLAnchorElement;
    fireEvent.click(link);

    const state = useStore.getState();
    expect(state.rightWorkspaceTab).toBe('workspace');
    expect(state.jianDrawerOpen).toBe(false);
    expect(openSkillViewer).toHaveBeenCalledWith({
      skillPath: 'C:\\Users\\roce\\.gsap\\agents\\gsap\\learned-skills\\skill-a\\SKILL.md',
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });

  it('opens external markdown links without showing the hidden link preview tab', async () => {
    const openExternal = vi.fn();
    (window as unknown as { platform?: unknown }).platform = {
      openExternal,
    };
    const { MarkdownContent } = await import('../../components/chat/MarkdownContent');

    const { container } = render(
      <MarkdownContent html={'<p><a href="https://example.com/docs">docs</a></p>'} />,
    );

    const link = container.querySelector('a') as HTMLAnchorElement;
    fireEvent.click(link);

    const state = useStore.getState();
    expect(state.rightWorkspaceTab).toBe('workspace');
    expect(state.jianDrawerOpen).toBe(false);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('shows a Chinese right-click menu for markdown links without opening a preview tab', async () => {
    (window as typeof window & { t?: unknown }).t = (key: string) => key;
    const { MarkdownContent } = await import('../../components/chat/MarkdownContent');

    const { container } = render(
      <MarkdownContent html={'<p><a href="https://example.com/docs">docs</a></p>'} />,
    );

    const link = container.querySelector('a') as HTMLAnchorElement;
    fireEvent.contextMenu(link, { clientX: 12, clientY: 18 });

    expect(screen.getByText('用系统浏览器打开')).toBeTruthy();
    expect(screen.getByText('复制链接')).toBeTruthy();
    const state = useStore.getState();
    expect(state.rightWorkspaceTab).toBe('workspace');
    expect(state.jianDrawerOpen).toBe(false);
    delete (window as typeof window & { t?: unknown }).t;
  });
});
