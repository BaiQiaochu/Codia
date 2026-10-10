/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const openFilePreviewMock = vi.fn();

vi.mock('../../utils/file-preview', () => ({
  openFilePreview: (...args: unknown[]) => openFilePreviewMock(...args),
}));

describe('link-open', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-platform');
    delete (window as Partial<Window>).platform;
    openFilePreviewMock.mockReset();
  });

  it('resolves relative markdown links against the source file path', async () => {
    const { openInternalLink, resolveLinkTarget } = await import('../../utils/link-open');

    expect(resolveLinkTarget('./assets/Cover%20Image.png#fig-1', {
      baseFilePath: '/vault/notes/chapter.md',
    })).toEqual({
      kind: 'file',
      filePath: '/vault/notes/assets/Cover Image.png',
      ext: 'png',
      label: 'Cover Image.png',
    });

    await openInternalLink('./assets/Cover%20Image.png#fig-1', {
      baseFilePath: '/vault/notes/chapter.md',
      origin: 'session',
      sessionPath: '/sessions/a.jsonl',
      fileId: 'file_123',
    });

    expect(openFilePreviewMock).toHaveBeenCalledWith(
      '/vault/notes/assets/Cover Image.png',
      'Cover Image.png',
      'png',
      expect.objectContaining({ origin: 'session', sessionPath: '/sessions/a.jsonl', fileId: 'file_123' }),
    );
  });

  it('opens local skill links through the skill viewer', async () => {
    const openSkillViewer = vi.fn();
    const openExternal = vi.fn();
    const openFile = vi.fn();
    window.platform = {
      openSkillViewer,
      openExternal,
      openFile,
    } as unknown as typeof window.platform;

    const { openInternalLink } = await import('../../utils/link-open');

    await openInternalLink('C:%5CUsers%5Croce%5C.codia%5Cagents%5Ccodia%5Clearned-skills%5Cskill-a%5CSKILL.md');

    expect(openSkillViewer).toHaveBeenCalledWith({
      skillPath: 'C:\\Users\\roce\\.codia\\agents\\codia\\learned-skills\\skill-a\\SKILL.md',
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });

  it('opens web links in the desktop browser viewer when available', async () => {
    const openBrowserViewer = vi.fn();
    const openExternal = vi.fn();
    window.platform = {
      openBrowserViewer,
      openExternal,
    } as unknown as typeof window.platform;

    const { openInternalLink } = await import('../../utils/link-open');
    await openInternalLink('https://example.com/a?b=1#top');

    expect(openBrowserViewer).toHaveBeenCalledWith('https://example.com/a?b=1#top');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('blocks unsafe protocols instead of navigating the renderer', async () => {
    const openExternal = vi.fn();
    window.platform = { openExternal } as unknown as typeof window.platform;

    const { openInternalLink } = await import('../../utils/link-open');

    await expect(openInternalLink('javascript:alert(1)')).resolves.toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
