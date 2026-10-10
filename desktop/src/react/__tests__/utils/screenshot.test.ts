/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeMock = vi.hoisted(() => ({
  state: {} as {
    homeFolder: string;
    chatSessions: Record<string, unknown>;
    selectedIdsBySession: Record<string, string[]>;
    currentAgentId: string | null;
    agentName: string;
    userName: string;
    beginScreenshotTask: ReturnType<typeof vi.fn>;
    updateScreenshotProgress: ReturnType<typeof vi.fn>;
    endScreenshotTask: ReturnType<typeof vi.fn>;
  },
}));

const apiMock = vi.hoisted(() => ({
  desktopApi: {
    screenshotRender: vi.fn(),
    getServerPort: vi.fn(),
    getServerToken: vi.fn(),
  },
}));

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => storeMock.state,
  },
}));

vi.mock('../../utils/desktop-api', () => ({
  getDesktopApi: () => apiMock.desktopApi,
}));

import { takeArticleScreenshot, takeMarkdownFileScreenshot, takeScreenshot } from '../../utils/screenshot';

describe('screenshot utils', () => {
  const notices: Array<{ text: string; type: string; deskDir?: string; filePath?: string }> = [];
  const noticeHandler = (event: Event) => {
    notices.push((event as CustomEvent).detail);
  };

  beforeEach(() => {
    notices.length = 0;
    apiMock.desktopApi.screenshotRender.mockReset();
    apiMock.desktopApi.getServerPort.mockReset().mockResolvedValue(null);
    apiMock.desktopApi.getServerToken.mockReset().mockResolvedValue(null);
    storeMock.state = {
      homeFolder: '/tmp/codia-home',
      chatSessions: {},
      selectedIdsBySession: {},
      currentAgentId: null,
      agentName: 'Codia',
      userName: 'User',
      beginScreenshotTask: vi.fn(),
      updateScreenshotProgress: vi.fn(),
      endScreenshotTask: vi.fn(),
    };
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    window.addEventListener('codia-inline-notice', noticeHandler);
    window.t = (key: string, params?: Record<string, unknown>) => {
      if (key === 'common.screenshotFailed') return 'screenshot failed';
      if (key === 'common.screenshotSaved') return 'screenshot saved';
      if (key === 'common.screenshotSavedMultiple') return `saved ${params?.count} screenshot segments`;
      return key;
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.removeEventListener('codia-inline-notice', noticeHandler);
    delete window.t;
  });

  it('shows a clear notice when screenshot rendering rejects', async () => {
    apiMock.desktopApi.screenshotRender.mockRejectedValue(new Error('disk full'));

    await expect(takeArticleScreenshot('# hello')).resolves.toBeUndefined();

    expect(apiMock.desktopApi.screenshotRender).toHaveBeenCalledOnce();
    expect(notices).toEqual([
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('disk full'),
      }),
    ]);
  });

  it('renders selected long messages as ordered screenshot segments', async () => {
    const sessionPath = '/session/a.jsonl';
    storeMock.state = {
      ...storeMock.state,
      selectedIdsBySession: {
        [sessionPath]: ['u1', 'a1', 'u2', 'a2'],
      },
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [
            { type: 'message', data: { id: 'u1', role: 'user', text: 'q'.repeat(6000) } },
            { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [{ type: 'text', html: `<p>${'a'.repeat(6000)}</p>` }] } },
            { type: 'message', data: { id: 'u2', role: 'user', text: 'next'.repeat(3000) } },
            { type: 'message', data: { id: 'a2', role: 'assistant', blocks: [{ type: 'text', html: `<p>${'reply'.repeat(3000)}</p>` }] } },
          ],
        },
      },
    };
    apiMock.desktopApi.screenshotRender.mockResolvedValue({ success: true, dir: '/tmp/codia-home/screenshots' });

    await expect(takeScreenshot('u1', sessionPath)).resolves.toBeUndefined();

    expect(storeMock.state.beginScreenshotTask).toHaveBeenCalledWith({
      completedBlocks: 0,
      totalBlocks: 4,
      currentPage: 1,
      totalPages: 2,
    });
    expect(storeMock.state.updateScreenshotProgress).toHaveBeenCalledWith({ currentPage: 1 });
    expect(storeMock.state.updateScreenshotProgress).toHaveBeenCalledWith({ completedBlocks: 2 });
    expect(storeMock.state.updateScreenshotProgress).toHaveBeenCalledWith({ currentPage: 2 });
    expect(storeMock.state.updateScreenshotProgress).toHaveBeenCalledWith({ completedBlocks: 4 });
    expect(storeMock.state.endScreenshotTask).toHaveBeenCalledOnce();
    expect(apiMock.desktopApi.screenshotRender).toHaveBeenCalledTimes(2);
    expect(apiMock.desktopApi.screenshotRender).toHaveBeenNthCalledWith(1, expect.objectContaining({
      segmentIndex: 1,
      segmentTotal: 2,
      saveDir: '/tmp/codia-home',
    }));
    expect(apiMock.desktopApi.screenshotRender).toHaveBeenNthCalledWith(2, expect.objectContaining({
      segmentIndex: 2,
      segmentTotal: 2,
      saveDir: '/tmp/codia-home',
    }));
    expect(notices).toEqual([
      expect.objectContaining({
        type: 'success',
        text: 'saved 2 screenshot segments',
        deskDir: '/tmp/codia-home/screenshots',
      }),
    ]);
  });

  it('uses the Codia brand theme even when an old color preference is stored', async () => {
    const sessionPath = '/session/a.jsonl';
    storeMock.state = {
      ...storeMock.state,
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [
            { type: 'message', data: { id: 'u1', role: 'user', text: 'hello' } },
          ],
        },
      },
    };
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
      if (key === 'codia-screenshot-color') return 'dark';
      if (key === 'codia-screenshot-width') return 'desktop';
      return null;
    });
    apiMock.desktopApi.screenshotRender.mockResolvedValue({ success: true, dir: '/tmp/codia-home/screenshots' });

    await takeScreenshot('u1', sessionPath);

    expect(apiMock.desktopApi.screenshotRender).toHaveBeenCalledWith(expect.objectContaining({
      theme: 'codia-brand-desktop',
    }));
  });

  it('renders markdown file screenshots from file snapshots into the requested workspace', async () => {
    window.platform = {
      readFileSnapshot: vi.fn(async () => ({ content: '# Report\n\nMigration done.', version: 'v1' })),
    } as any;
    apiMock.desktopApi.screenshotRender.mockResolvedValue({
      success: true,
      dir: '/workspace/CODIA-Works/截图',
      filePath: '/workspace/CODIA-Works/截图/report.png',
    });

    await expect(takeMarkdownFileScreenshot('/workspace/report.md', { saveDir: '/workspace' })).resolves.toBeUndefined();

    expect(window.platform.readFileSnapshot).toHaveBeenCalledWith('/workspace/report.md');
    expect(apiMock.desktopApi.screenshotRender).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'article',
      markdown: '# Report\n\nMigration done.',
      filePath: '/workspace/report.md',
      articleType: 'markdown',
      language: 'markdown',
      saveDir: '/workspace',
    }));
    expect(notices).toEqual([
      expect.objectContaining({
        type: 'success',
        deskDir: '/workspace/CODIA-Works/截图',
        filePath: '/workspace/CODIA-Works/截图/report.png',
      }),
    ]);
  });

  it('uses a supplied markdown display name for staged extensionless files', async () => {
    window.platform = {
      readFileSnapshot: vi.fn(async () => ({ content: 'staged markdown' })),
    } as any;
    apiMock.desktopApi.screenshotRender.mockResolvedValue({
      success: true,
      dir: '/tmp/codia-home/CODIA-Works/截图',
      filePath: '/tmp/codia-home/CODIA-Works/截图/staged.png',
    });

    await expect(takeMarkdownFileScreenshot('/tmp/session-files/a1b2c3', { fileName: 'report.md' })).resolves.toBeUndefined();

    expect(apiMock.desktopApi.screenshotRender).toHaveBeenCalledWith(expect.objectContaining({
      markdown: 'staged markdown',
      filePath: '/tmp/session-files/a1b2c3',
      fileName: 'report.md',
      articleType: 'markdown',
      saveDir: '/tmp/codia-home',
    }));
  });

  it('converts fetched image blobs without relying on FileReader', async () => {
    const sessionPath = '/session/with-image.jsonl';
    storeMock.state = {
      ...storeMock.state,
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [
            {
              type: 'message',
              data: {
                id: 'u1',
                role: 'user',
                text: 'image',
                attachments: [{
                  name: 'picture.png',
                  path: '/tmp/picture.png',
                  mimeType: 'image/png',
                }],
              },
            },
          ],
        },
      },
    };
    vi.stubGlobal('FileReader', undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      { status: 200 },
    )));
    window.platform = {
      getFileUrl: vi.fn(() => 'https://assets.test/picture.png'),
    } as any;
    apiMock.desktopApi.screenshotRender.mockResolvedValue({ success: true, dir: '/tmp/codia-home/screenshots' });

    await takeScreenshot('u1', sessionPath);

    const payload = apiMock.desktopApi.screenshotRender.mock.calls[0][0];
    expect(payload.messages[0].blocks[1]).toEqual(expect.objectContaining({
      type: 'image',
      content: expect.stringMatching(/^data:image\/png;base64,/),
    }));
  });
});
