// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import chatStyles from '../../components/chat/Chat.module.css';
import { openFilePreview } from '../../utils/file-preview';

type MockStoreState = {
  agents: Array<{ id: string; name: string; yuan?: string; hasAvatar?: boolean }>;
  agentName: string;
  agentYuan: string;
  voiceSpeakingMessageId: string | null;
  chatSessions: Record<string, { items: Array<{ type: 'message'; data: ChatMessage }> }>;
  sessionRegistryFilesByPath: Record<string, unknown[]>;
  hiddenSessionResourceIdsByPath: Record<string, string[]>;
  activeServerConnection: unknown | null;
  activeServerConnectionId: string | null;
  serverConnections: Record<string, unknown>;
  serverPort: string | null;
  serverToken: string | null;
  setVoiceSpeakingMessageId: ReturnType<typeof vi.fn>;
};

type TestPlatform = {
  getFileUrl: ReturnType<typeof vi.fn>;
  saveFileAs: ReturnType<typeof vi.fn>;
  showInFinder: ReturnType<typeof vi.fn>;
  openFile: ReturnType<typeof vi.fn>;
};

let storeState: MockStoreState;
const pluginCardMockState = vi.hoisted(() => ({ shouldThrow: false }));
const mediaViewerMockState = vi.hoisted(() => ({ open: vi.fn() }));

const useStoreMock = Object.assign(
  <T,>(selector: (state: MockStoreState) => T): T => selector(storeState),
  {
    getState: () => storeState,
  },
);

vi.mock('../../stores', () => ({
  useStore: useStoreMock,
}));

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: vi.fn(),
  codiaUrl: (path: string) => path,
}));

vi.mock('../../stores/session-selectors', () => ({
  selectIsStreamingSession: () => false,
  selectSelectedIdsBySession: () => [],
}));

vi.mock('../../utils/file-preview', () => ({
  openFilePreview: vi.fn(),
  openSkillPreview: vi.fn(),
}));

vi.mock('../../utils/open-media-viewer', () => ({
  openMediaViewerForRef: mediaViewerMockState.open,
}));

vi.mock('../../stores/preview-actions', () => ({
  openPreview: vi.fn(),
}));

vi.mock('../../utils/chat-copy', () => ({
  serializeChatMessageForCopy: vi.fn(() => ''),
}));

vi.mock('../../utils/voice', () => ({
  getVoiceSettings: () => ({
    recognitionLang: 'zh-CN',
    synthesisVoiceUri: '',
    synthesisRate: 1,
    synthesisPitch: 1,
    synthesisVolume: 1,
  }),
}));

vi.mock('../../utils/yuan', () => ({
  normalizeYuanKey: (value: string) => value,
}));

vi.mock('../../components/chat/MoodBlock', () => ({
  MoodBlock: () => null,
}));

vi.mock('../../components/chat/ThinkingBlock', () => ({
  ThinkingBlock: () => null,
}));

vi.mock('../../components/chat/ToolGroupBlock', () => ({
  ToolGroupBlock: () => null,
}));

vi.mock('../../components/chat/PluginCardBlock', () => ({
  PluginCardBlock: () => {
    if (pluginCardMockState.shouldThrow) throw new Error('plugin card render failed');
    return <div>Plugin card rendered</div>;
  },
}));

vi.mock('../../components/chat/SubagentCard', () => ({
  SubagentCard: () => null,
}));

vi.mock('../../components/chat/SettingsConfirmCard', () => ({
  SettingsConfirmCard: () => null,
}));

vi.mock('../../components/chat/MessageActions', () => ({
  MessageActions: () => null,
  useMessageFooterActions: () => [],
}));

vi.mock('../../components/chat/block-renderers', () => ({
  BLOCK_RENDERERS: {},
}));

describe('AssistantMessage long reply rendering', () => {
  beforeEach(() => {
    pluginCardMockState.shouldThrow = false;
    storeState = {
      agents: [],
      agentName: 'Codia',
      agentYuan: 'codia',
      voiceSpeakingMessageId: null,
      chatSessions: {},
      sessionRegistryFilesByPath: {},
      hiddenSessionResourceIdsByPath: {},
      activeServerConnection: null,
      activeServerConnectionId: null,
      serverConnections: {},
      serverPort: null,
      serverToken: null,
      setVoiceSpeakingMessageId: vi.fn(),
    };

    Object.assign(window, {
      t: (key: string) => ({
        'chat.fileExpired': 'File expired',
        'chat.fileActions.preview': 'Preview',
        'chat.fileActions.save': 'Save',
        'chat.fileActions.more': 'More file actions',
        'chat.fileActions.revealInFinder': 'Reveal in file manager',
        'chat.fileActions.copyPath': 'Copy file path',
        'desk.openWithDefault': 'Open with default app',
        'chat.blockUnavailable': '内容块暂时不可用',
      } as Record<string, string>)[key] || key,
      i18n: { locale: 'zh-CN' },
      platform: {
        getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
        saveFileAs: vi.fn(),
        showInFinder: vi.fn(),
        openFile: vi.fn(),
      } satisfies TestPlatform,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders long markdown replies inside the assistant bubble without dropping content', async () => {
    const longToken = 'LONGTOKEN_'.repeat(80);
    const html = `
      <p>${longToken}</p>
      <p>Second long paragraph content should remain intact.</p>
      <table>
        <thead><tr><th>Column A</th><th>Column B</th></tr></thead>
        <tbody><tr><td>${longToken}</td><td>long table cell</td></tr></tbody>
      </table>
    `;

    const message: ChatMessage = {
      id: 'msg-long-reply',
      role: 'assistant',
      blocks: [{ type: 'text', html }],
    };

    const { AssistantMessage } = await import('../../components/chat/AssistantMessage');

    const { container } = render(
      <AssistantMessage
        message={message}
        showAvatar={false}
        sessionPath="session://long-reply"
        readOnly
      />,
    );

    const messageGroup = container.querySelector('[data-message-id="msg-long-reply"]');
    expect(messageGroup).toBeTruthy();

    const assistantBubble = messageGroup?.querySelector(`.${chatStyles.messageAssistant}`);
    expect(assistantBubble).toBeTruthy();

    const markdownRoot = assistantBubble?.querySelector('.md-content') as HTMLDivElement | null;
    expect(markdownRoot).toBeTruthy();
    expect(markdownRoot?.textContent).toContain(longToken);
    expect(markdownRoot?.textContent).toContain('Second long paragraph content should remain intact.');
    expect(markdownRoot?.querySelectorAll('p')).toHaveLength(2);

    const table = markdownRoot?.querySelector('table');
    expect(table).toBeTruthy();
    expect(table?.textContent).toContain('long table cell');
  });

  it('renders generated video files with preview and save actions', async () => {
    const message: ChatMessage = {
      id: 'msg-video-file',
      role: 'assistant',
      blocks: [{
        type: 'file',
        filePath: 'E:/generated/demo.mp4',
        label: 'demo.mp4',
        ext: 'mp4',
      }],
    };

    const { AssistantMessage } = await import('../../components/chat/AssistantMessage');

    const { container } = render(
      <AssistantMessage
        message={message}
        showAvatar={false}
        sessionPath="session://video-file"
        readOnly
      />,
    );

    const video = container.querySelector('video') as HTMLVideoElement | null;
    expect(video).toBeTruthy();
    expect(video?.hasAttribute('controls')).toBe(false);
    expect(container.querySelector(`.${chatStyles.videoOutputPlayBadge}`)).toBeTruthy();
    expect((window.platform as unknown as TestPlatform).getFileUrl).toHaveBeenCalledWith('E:/generated/demo.mp4');

    fireEvent.click(video as HTMLVideoElement);
    expect(openFilePreview).toHaveBeenCalledWith(
      'E:/generated/demo.mp4',
      'demo.mp4',
      'mp4',
      expect.objectContaining({ origin: 'session', sessionPath: 'session://video-file', blockIdx: 0 }),
    );
  });

  it('uses session resource URLs for generated video cards when the file belongs to a remote session', async () => {
    const sessionPath = 'session://remote-video-file';
    storeState.activeServerConnection = {
      connectionId: 'remote-1',
      kind: 'lan',
      serverId: 'remote',
      studioId: 'studio-1',
      label: 'Remote',
      baseUrl: 'https://remote.example.test/',
      wsUrl: 'wss://remote.example.test/',
      token: 'secret-token',
      authState: 'paired',
      trustState: 'lan',
      credentialKind: 'device_credential',
      platformAccountId: null,
      officialServiceKind: null,
      capabilities: ['resources'],
    };
    storeState.sessionRegistryFilesByPath[sessionPath] = [{
      id: 'registry-video',
      fileId: 'file-video-1',
      filePath: '/server/output/demo.mp4',
      label: 'demo.mp4',
      ext: 'mp4',
      resource: {
        schemaVersion: 1,
        resourceId: 'res-video-1',
        name: 'demo.mp4',
        studioId: 'studio-1',
        type: 'file',
        source: 'session_file',
        fileId: 'file-video-1',
        lifecycle: { status: 'available', missingAt: null },
        storage: { provider: 'session_file' },
        links: {
          self: '/api/resources/res-video-1',
          content: '/api/resources/res-video-1/content',
        },
      },
    }];

    const message: ChatMessage = {
      id: 'msg-remote-video-file',
      role: 'assistant',
      blocks: [{
        type: 'file',
        fileId: 'file-video-1',
        filePath: '/server/output/demo.mp4',
        label: 'demo.mp4',
        ext: 'mp4',
      }],
    };
    storeState.chatSessions[sessionPath] = {
      items: [{ type: 'message', data: message }],
    };

    const { AssistantMessage } = await import('../../components/chat/AssistantMessage');

    const { container } = render(
      <AssistantMessage
        message={message}
        showAvatar={false}
        sessionPath={sessionPath}
        readOnly
      />,
    );

    const video = container.querySelector('video') as HTMLVideoElement | null;
    expect(video).toBeTruthy();
    expect(video?.getAttribute('src')).toBe('https://remote.example.test/api/resources/res-video-1/content');
    expect((window.platform as unknown as TestPlatform).getFileUrl).not.toHaveBeenCalledWith('/server/output/demo.mp4');

    const download = screen.getByRole('link', { name: 'Download to device demo.mp4' });
    expect(download.getAttribute('href')).toBe('https://remote.example.test/api/resources/res-video-1/content');
  });

  it('renders zoom, fit, expand, and download controls for generated image cards', async () => {
    const message: ChatMessage = {
      id: 'msg-generated-diagram-file',
      role: 'assistant',
      blocks: [{
        type: 'file',
        fileId: 'file-diagram-1',
        filePath: 'C:/workspace/output/diagram.png',
        label: '功能结构图.png',
        ext: 'png',
      }],
    };

    const { AssistantMessage } = await import('../../components/chat/AssistantMessage');

    const { container } = render(
      <AssistantMessage
        message={message}
        showAvatar={false}
        sessionPath="session://generated-diagram"
        readOnly
      />,
    );

    const image = container.querySelector('img') as HTMLImageElement | null;
    expect(image).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download to device 功能结构图.png' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '缩小' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '放大' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '适配宽度' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '展开查看' })).toBeTruthy();

    fireEvent.click(image as HTMLImageElement);
    expect(mediaViewerMockState.open).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-diagram-1',
        path: 'C:/workspace/output/diagram.png',
        previewUrl: 'file://C:/workspace/output/diagram.png',
      }),
      expect.objectContaining({ origin: 'session', sessionPath: 'session://generated-diagram' }),
    );

    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(image?.style.width).toBe('120%');
    expect(openFilePreview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '展开查看' }));
    const expandedCard = document.body.querySelector(`.${chatStyles.imageOutputExpanded}`);
    expect(expandedCard).toBeTruthy();
    const expandedStage = expandedCard?.querySelector(`.${chatStyles.imageOutputPreviewWrap}`) as HTMLElement | null;
    const expandedImage = expandedCard?.querySelector('img') as HTMLImageElement | null;
    fireEvent.wheel(expandedStage as HTMLElement, { deltaY: -100 });
    expect(expandedImage?.style.width).toBe('144%');
  });

  it('renders media generation placeholders with the animated visual treatment', async () => {
    const message: ChatMessage = {
      id: 'msg-media-placeholder',
      role: 'assistant',
      blocks: [{
        type: 'media_generation',
        taskId: 'task-img-1',
        kind: 'image',
        status: 'pending',
        prompt: 'Generate a clean product mockup',
      } satisfies ContentBlock],
    };

    const { AssistantMessage } = await import('../../components/chat/AssistantMessage');

    const { container } = render(
      <AssistantMessage
        message={message}
        showAvatar={false}
        sessionPath="session://media-placeholder"
        readOnly
      />,
    );

    expect(screen.getByLabelText('Image generation...')).toBeTruthy();
    expect(container.querySelector('[class*="mediaGenerationIconShell"]')).toBeTruthy();
    expect(container.querySelector('[class*="mediaGenerationProgress"]')).toBeTruthy();
    expect(screen.getByText('Generate a clean product mockup')).toBeTruthy();
  });

  it('isolates a crashing rich content block instead of dropping the assistant message', async () => {
    pluginCardMockState.shouldThrow = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const message: ChatMessage = {
      id: 'msg-block-crash',
      role: 'assistant',
      blocks: [
        { type: 'text', html: '<p>前面的模型正文仍然可见</p>' },
        {
          type: 'plugin_card',
          card: { pluginId: 'broken-plugin', type: 'iframe', route: '/broken', description: 'Broken plugin' },
        } satisfies ContentBlock,
        { type: 'text', html: '<p>后续内容也不能被吞掉</p>' },
      ],
    };

    const { AssistantMessage } = await import('../../components/chat/AssistantMessage');

    render(
      <AssistantMessage
        message={message}
        showAvatar={false}
        sessionPath="session://block-crash"
        readOnly
      />,
    );

    expect(screen.getByText('前面的模型正文仍然可见')).toBeTruthy();
    expect(screen.getByText('后续内容也不能被吞掉')).toBeTruthy();
    expect(screen.getByText('内容块暂时不可用')).toBeTruthy();
    errorSpy.mockRestore();
  });

  it('renders normal file output actions for open, reveal, and copy path', async () => {
    const message: ChatMessage = {
      id: 'msg-file-actions',
      role: 'assistant',
      blocks: [{
        type: 'file',
        filePath: 'E:/generated/report.pdf',
        label: 'report.pdf',
        ext: 'pdf',
      }],
    };

    const { AssistantMessage } = await import('../../components/chat/AssistantMessage');

    render(
      <AssistantMessage
        message={message}
        showAvatar={false}
        sessionPath="session://file-actions"
        readOnly
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open with default app report.pdf' }));
    expect((window.platform as unknown as TestPlatform).openFile).toHaveBeenCalledWith('E:/generated/report.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'More file actions report.pdf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in file manager' }));
    expect((window.platform as unknown as TestPlatform).showInFinder).toHaveBeenCalledWith('E:/generated/report.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'More file actions report.pdf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy file path' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('E:/generated/report.pdf');
  });

  it('renders bash invoke blocks collapsed until the summary is clicked', async () => {
    const message: ChatMessage = {
      id: 'msg-bash-invoke',
      role: 'assistant',
      blocks: [{
        type: 'invoke',
        name: 'bash',
        content: 'npm run typecheck',
      } satisfies ContentBlock],
    };

    const { AssistantMessage } = await import('../../components/chat/AssistantMessage');

    render(
      <AssistantMessage
        message={message}
        showAvatar={false}
        sessionPath="session://bash-invoke"
        readOnly
      />,
    );

    const summary = screen.getByText(/bash/i);
    expect(screen.queryByText('npm run typecheck')).toBeNull();

    fireEvent.click(summary);

    expect(screen.getByText('npm run typecheck')).toBeTruthy();
  });

  it('ignores malformed content blocks without crashing the assistant message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const message: ChatMessage = {
      id: 'msg-malformed-blocks',
      role: 'assistant',
      blocks: [
        null,
        {},
        { type: 'text', html: '<p>valid block survives</p>' },
      ] as unknown as ContentBlock[],
    };

    const { AssistantMessage } = await import('../../components/chat/AssistantMessage');

    expect(() => render(
      <AssistantMessage
        message={message}
        showAvatar={false}
        sessionPath="session://malformed-blocks"
        readOnly
      />,
    )).not.toThrow();

    expect(screen.getByText('valid block survives')).toBeTruthy();
    errorSpy.mockRestore();
  });
});
