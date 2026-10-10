import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  loadSessions: vi.fn(),
  loadChannels: vi.fn(),
  openChannel: vi.fn(),
  appendChannelMessage: vi.fn(),
  upsertConversationAgentActivity: vi.fn(),
  streamHandle: vi.fn(),
  streamBeginUserTurn: vi.fn(),
  streamFinishTurn: vi.fn(),
  dispatchStreamKey: vi.fn(),
  getWebSocket: vi.fn(() => null),
  handleAppEvent: vi.fn(),
  getActiveStreamMessageId: vi.fn(() => null as string | null),
  loadDeskTreeFiles: vi.fn(),
}));

type MockChatItem = {
  type: 'message';
  data: {
    id: string;
    role?: string;
    blocks?: unknown[];
  };
};

type MockChatSession = {
  items: MockChatItem[];
  hasMore?: boolean;
  loadingMore?: boolean;
};

function chatItems(sessionPath: string): MockChatItem[] {
  return (mocks.state.chatSessions as Record<string, MockChatSession>)[sessionPath].items;
}

vi.mock('../../stores', () => {
  const useStore = Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) => selector ? selector(mocks.state) : mocks.state,
    {
      getState: () => mocks.state,
      setState: (partial: Record<string, unknown> | ((state: Record<string, unknown>) => Record<string, unknown>)) => {
        const patch = typeof partial === 'function' ? partial(mocks.state) : partial;
        mocks.state = { ...mocks.state, ...patch };
      },
    },
  );
  return { useStore };
});

vi.mock('../../hooks/use-stream-buffer', () => ({
  streamBufferManager: {
    handle: mocks.streamHandle,
    beginUserTurn: mocks.streamBeginUserTurn,
    finishTurn: mocks.streamFinishTurn,
    getActiveMessageId: mocks.getActiveStreamMessageId,
  },
}));

vi.mock('../../services/stream-key-dispatcher', () => ({
  dispatchStreamKey: mocks.dispatchStreamKey,
}));

vi.mock('../../stores/create-keyed-slice', () => ({
  updateKeyed: vi.fn(),
}));

vi.mock('../../stores/session-actions', () => ({
  loadSessions: mocks.loadSessions,
}));

vi.mock('../../stores/preview-actions', () => ({
  handleArtifact: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
  loadDeskTreeFiles: mocks.loadDeskTreeFiles,
}));

vi.mock('../../stores/channel-actions', () => ({
  loadChannels: mocks.loadChannels,
  openChannel: mocks.openChannel,
  appendChannelMessage: mocks.appendChannelMessage,
  upsertConversationAgentActivity: mocks.upsertConversationAgentActivity,
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: mocks.getWebSocket,
}));

vi.mock('../../services/app-event-actions', () => ({
  handleAppEvent: mocks.handleAppEvent,
}));

vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: vi.fn(() => null),
  isStreamScopedMessage: vi.fn(() => false),
  updateSessionStreamMeta: vi.fn(),
}));

vi.mock('../../utils/todo-constants', () => ({
  TODO_TOOL_NAMES: [],
}));

vi.mock('../../utils/todo-compat', () => ({
  migrateLegacyTodos: vi.fn(() => []),
}));

vi.mock('../../utils/markdown', () => ({
  renderMarkdown: (text: string) => text,
}));

vi.mock('../../stores/message-live-version', () => ({
  bumpMessageLiveVersion: vi.fn(),
}));

import { resetSessionRefreshSchedulerForTest } from '../../services/session-refresh-scheduler';

function resetState() {
  mocks.state = {
    currentSessionPath: '/s1',
    pendingNewSession: false,
    sessions: [{ path: '/s1' }],
    chatSessions: {},
    streamingSessions: ['/s1'],
    inlineErrors: {},
    currentAgentId: null,
    agentName: 'Codia',
    currentTab: 'chat',
    currentChannel: null,
    contextBySession: {},
    browserBySession: {},
    activities: [],
    upsertAgentActivity: vi.fn(),
    clearInlineError: vi.fn((path: string) => {
      mocks.state.inlineErrors = { ...(mocks.state.inlineErrors as Record<string, unknown>), [path]: null };
    }),
    setInlineError: vi.fn((path: string, text: string) => {
      mocks.state.inlineErrors = { ...(mocks.state.inlineErrors as Record<string, unknown>), [path]: text };
    }),
    removeCompactingSession: vi.fn(),
    addCompactingSession: vi.fn(),
    setSessionTodosForPath: vi.fn(),
    bumpTodosLiveVersion: vi.fn(),
    setThinkingLevel: vi.fn((level: string) => {
      mocks.state.thinkingLevel = level;
    }),
    patchBlockByTaskId: vi.fn(),
    pendingSessionConfirmationsByPath: {},
    setPendingSessionConfirmation: vi.fn((path: string, block: Record<string, unknown> | null) => {
      const current = mocks.state.pendingSessionConfirmationsByPath as Record<string, unknown>;
      if (block?.status === 'pending') {
        mocks.state.pendingSessionConfirmationsByPath = { ...current, [path]: block };
      } else {
        const next = { ...current };
        delete next[path];
        mocks.state.pendingSessionConfirmationsByPath = next;
      }
    }),
    resolvePendingSessionConfirmation: vi.fn((confirmId: string) => {
      const current = mocks.state.pendingSessionConfirmationsByPath as Record<string, any>;
      const next = { ...current };
      for (const [path, block] of Object.entries(current)) {
        if (block?.confirmId === confirmId) delete next[path];
      }
      mocks.state.pendingSessionConfirmationsByPath = next;
    }),
    sessionRegistryFilesByPath: {},
    upsertSessionRegistryFile: vi.fn((path: string, file: Record<string, unknown>) => {
      const current = (mocks.state.sessionRegistryFilesByPath as Record<string, unknown[]>)[path] || [];
      (mocks.state.sessionRegistryFilesByPath as Record<string, unknown[]>)[path] = [...current, file];
    }),
    addBridgeMessage: vi.fn(),
    appendItem: vi.fn((path: string, item: Record<string, unknown>) => {
      const sessions = mocks.state.chatSessions as Record<string, { items: unknown[]; hasMore: boolean; loadingMore: boolean }>;
      const session = sessions[path];
      if (!session) return;
      sessions[path] = { ...session, items: [...session.items, item] };
    }),
    initSession: vi.fn((path: string, items: unknown[], hasMore: boolean) => {
      const sessions = mocks.state.chatSessions as Record<string, { items: unknown[]; hasMore: boolean; loadingMore: boolean }>;
      sessions[path] = { items, hasMore, loadingMore: false };
    }),
    updateLastMessage: vi.fn(),
    truncateSessionFromMessage: vi.fn(() => true),
  };
}

describe('ws-message-handler streaming recovery', () => {
  afterEach(() => {
    resetSessionRefreshSchedulerForTest();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    resetState();
  });

  it('clears a session streaming lock when turn_end arrives without status:false', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({ type: 'turn_end', sessionPath: '/s1' });

    expect(mocks.streamHandle).toHaveBeenCalledWith({ type: 'turn_end', sessionPath: '/s1' });
    expect(mocks.state.streamingSessions).toEqual([]);
  });

  it('routes deferred media completion events to the stream buffer', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');
    const message = {
      type: 'deferred_result',
      sessionPath: '/s1',
      taskId: 'img-task-1',
      status: 'success',
      meta: { type: 'image-generation', mediaKind: 'image' },
      result: { sessionFiles: [{ filePath: 'E:/generated/out.png', label: 'out.png' }] },
    };

    handleServerMessage(message);

    expect(mocks.streamHandle).toHaveBeenCalledWith(message);
  });

  it('caches input session confirmations for inactive sessions before focus filtering', async () => {
    mocks.state.currentSessionPath = '/s1';
    mocks.state.sessions = [{ path: '/s1' }];
    const block = {
      type: 'session_confirmation',
      confirmId: 'confirm-background-1',
      kind: 'computer_app_approval',
      surface: 'input',
      status: 'pending',
    };
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({ type: 'content_block', sessionPath: '/s2', block });

    expect(mocks.state.setPendingSessionConfirmation).toHaveBeenCalledWith('/s2', block);
    expect(mocks.state.pendingSessionConfirmationsByPath).toEqual({ '/s2': block });
  });

  it('removes cached input session confirmations when the server resolves them', async () => {
    mocks.state.pendingSessionConfirmationsByPath = {
      '/s2': {
        type: 'session_confirmation',
        confirmId: 'confirm-background-1',
        kind: 'computer_app_approval',
        surface: 'input',
        status: 'pending',
      },
    };
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'confirmation_resolved',
      confirmId: 'confirm-background-1',
      action: 'confirmed',
    });

    expect(mocks.state.resolvePendingSessionConfirmation).toHaveBeenCalledWith('confirm-background-1');
    expect(mocks.state.pendingSessionConfirmationsByPath).toEqual({});
  });

  it('normalizes legacy object-map chat items before resolving confirmation blocks', async () => {
    mocks.state.chatSessions = {
      '/legacy': {
        items: {
          'item-1': {
            type: 'message',
            data: {
              id: 'item-1',
              role: 'assistant',
              blocks: {
                'block-1': {
                  type: 'session_confirmation',
                  confirmId: 'confirm-legacy-1',
                  status: 'pending',
                },
              },
            },
          },
        },
      },
    } as unknown as Record<string, MockChatSession>;
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    expect(() => handleServerMessage({
      type: 'confirmation_resolved',
      confirmId: 'confirm-legacy-1',
      action: 'confirmed',
    })).not.toThrow();

    const items = chatItems('/legacy');
    expect(Array.isArray(items)).toBe(true);
    expect(items[0].data.blocks).toEqual([
      {
        type: 'session_confirmation',
        confirmId: 'confirm-legacy-1',
        status: 'confirmed',
      },
    ]);
  });

  it('stores agent activity events for right workspace cards', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');
    const entry = {
      id: 'wf-1',
      kind: 'workflow',
      status: 'running',
      sessionPath: '/s1',
      agentId: 'a1',
    };

    handleServerMessage({ type: 'agent_activity', entry });

    expect(mocks.state.upsertAgentActivity).toHaveBeenCalledWith(entry);
  });

  it('clears an off-current session streaming lock before routing turn_end away', async () => {
    mocks.state.currentSessionPath = '/s2';
    mocks.state.sessions = [{ path: '/s1' }, { path: '/s2' }];
    mocks.state.streamingSessions = ['/s1'];

    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({ type: 'turn_end', sessionPath: '/s1' });

    expect(mocks.streamHandle).toHaveBeenCalledWith({ type: 'turn_end', sessionPath: '/s1' });
    expect(mocks.dispatchStreamKey).toHaveBeenCalledWith('/s1', { type: 'turn_end', sessionPath: '/s1' });
    expect(mocks.state.streamingSessions).toEqual([]);
  });

  it('clears the current session lock when legacy turn_end omits sessionPath', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({ type: 'turn_end' });

    expect(mocks.streamHandle).toHaveBeenCalledWith({ type: 'turn_end' });
    expect(mocks.state.streamingSessions).toEqual([]);
  });

  it('clears the current session lock when legacy status:false omits sessionPath', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({ type: 'status', isStreaming: false });

    expect(mocks.state.streamingSessions).toEqual([]);
    expect(mocks.streamFinishTurn).toHaveBeenCalledWith('/s1');
  });

  it('applies scoped session metadata updates without reloading all sessions', async () => {
    mocks.state.sessions = [
      { path: '/s1', pinnedAt: null, projectId: null },
      { path: '/s2', pinnedAt: null, projectId: 'old' },
    ];
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'session_metadata_updated',
      sessionPath: '/s1',
      metadata: {
        pinnedAt: '2026-06-05T00:00:00.000Z',
        projectId: ' project-a ',
        thinkingLevel: 'high',
      },
    });

    expect(mocks.loadSessions).not.toHaveBeenCalled();
    expect(mocks.state.sessions).toEqual([
      { path: '/s1', pinnedAt: '2026-06-05T00:00:00.000Z', projectId: 'project-a' },
      { path: '/s2', pinnedAt: null, projectId: 'old' },
    ]);
    expect(mocks.state.setThinkingLevel).toHaveBeenCalledWith('high');
    expect(mocks.state.thinkingLevel).toBe('high');
  });

  it('finishes a stale active assistant target when status:false is the terminal event', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({ type: 'status', isStreaming: false, sessionPath: '/s1' });

    expect(mocks.state.streamingSessions).toEqual([]);
    expect(mocks.streamFinishTurn).toHaveBeenCalledWith('/s1');
  });

  it('clears a session streaming lock on terminal errors so the next prompt can send', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({ type: 'error', sessionPath: '/s1', message: 'provider failed' });

    expect(mocks.state.streamingSessions).toEqual([]);
    expect(mocks.state.inlineErrors['/s1']).toBe('provider failed');
  });

  it('keeps the streaming lock for non-terminal busy errors', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({ type: 'error', sessionPath: '/s1', message: 'still streaming', terminal: false });

    expect(mocks.state.streamingSessions).toEqual(['/s1']);
    expect(mocks.state.inlineErrors['/s1']).toBe('still streaming');
  });

  it('routes app_event messages to handleAppEvent', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'app_event',
      event: {
        type: 'models-changed',
        payload: { reason: 'provider' },
      },
    });

    expect(mocks.handleAppEvent).toHaveBeenCalledWith('models-changed', { reason: 'provider' }, { source: 'server' });
  });

  it('passes explicit app_event source through to handleAppEvent', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'app_event',
      event: {
        type: 'network-proxy-changed',
        payload: { network_proxy: { mode: 'direct' } },
        source: 'server',
      },
    });

    expect(mocks.handleAppEvent).toHaveBeenCalledWith(
      'network-proxy-changed',
      { network_proxy: { mode: 'direct' } },
      { source: 'server' },
    );
  });

  it('refreshes the session list when the server reports session changes', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({ type: 'sessions_changed', sessionPath: '/s1' });

    expect(mocks.loadSessions).toHaveBeenCalled();
  });

  it('turn_end requests context usage through the configured callback', async () => {
    const requestContextUsage = vi.fn();
    const { configureWsMessageHandler, handleServerMessage } = await import('../../services/ws-message-handler');

    configureWsMessageHandler({ requestContextUsage });
    handleServerMessage({ type: 'turn_end', sessionPath: '/s1' });

    expect(requestContextUsage).toHaveBeenCalledWith('/s1');
  });

  it('coalesces rapid turn_end session refreshes into one delayed list request', async () => {
    vi.useFakeTimers();
    const requestContextUsage = vi.fn();
    const { configureWsMessageHandler, handleServerMessage } = await import('../../services/ws-message-handler');

    configureWsMessageHandler({ requestContextUsage });
    handleServerMessage({ type: 'turn_end', sessionPath: '/s1' });

    expect(mocks.loadSessions).not.toHaveBeenCalled();
    expect(requestContextUsage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);

    expect(mocks.loadSessions).toHaveBeenCalledTimes(1);
  });

  it('upserts session_created before the delayed full session list refresh', async () => {
    vi.useFakeTimers();
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'session_created',
      sessionPath: '/sessions/new.jsonl',
      session: {
        path: '/sessions/new.jsonl',
        title: 'Mobile session',
        firstMessage: 'from mobile',
        modified: '2026-05-16T12:00:00.000Z',
        messageCount: 1,
        agentId: 'agent-a',
        agentName: 'Codia',
        cwd: '/workspace',
      },
    });

    expect((mocks.state.sessions as Array<Record<string, unknown>>)[0]).toMatchObject({
      path: '/sessions/new.jsonl',
      title: 'Mobile session',
      firstMessage: 'from mobile',
      messageCount: 1,
      cwd: '/workspace',
      _optimistic: false,
    });
    expect(mocks.loadSessions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    expect(mocks.loadSessions).toHaveBeenCalledTimes(1);
  });

  it('updates the sidebar preview when the first live user message arrives', async () => {
    mocks.state.sessions = [{
      path: '/s-new',
      title: null,
      firstMessage: '',
      modified: '2026-06-04T07:47:00.000Z',
      messageCount: 0,
      _optimistic: true,
    }];
    mocks.state.currentSessionPath = '/s-new';
    mocks.state.chatSessions = {};
    mocks.state.streamingSessions = [];
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/s-new',
      message: {
        id: 'user-1',
        text: '检查模型是否在线',
        timestamp: '2026-06-04T07:48:05.000Z',
      },
    });

    expect((mocks.state.sessions as Array<Record<string, unknown>>)[0]).toMatchObject({
      path: '/s-new',
      firstMessage: '检查模型是否在线',
      modified: '2026-06-04T07:48:05.000Z',
      messageCount: 1,
      _optimistic: false,
    });
  });

  it('updates review status on the matching USER bubble, preserving unrelated turns', async () => {
    mocks.state.chatSessions = { '/s1': { items: [
      { type: 'message', data: { id: 'request', role: 'user', agentReview: { requestId: 'r1', status: 'running' } } },
      { type: 'message', data: { id: 'other', role: 'user', agentReview: { requestId: 'r2', status: 'running' } } },
    ] } };
    const { handleServerMessage } = await import('../../services/ws-message-handler');
    handleServerMessage({ type: 'agent_review_status', sessionPath: '/s1', review: { requestId: 'r1', status: 'failed', error: 'mock failure' } });
    expect(chatItems('/s1')[0].data).toMatchObject({ role: 'user', agentReview: { status: 'failed', error: 'mock failure' } });
    expect(chatItems('/s1')[1].data).toMatchObject({ agentReview: { status: 'running' } });
  });

  it('updates the session registry file list when tool_end includes a sessionFile', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'tool_end',
      sessionPath: '/s1',
      name: 'write',
      success: true,
      details: {
        sessionFile: {
          fileId: 'sf_write',
          filePath: '/workspace/draft.md',
          label: 'draft.md',
          operations: ['created'],
        },
      },
    });

    expect(mocks.state.upsertSessionRegistryFile).toHaveBeenCalledWith('/s1', expect.objectContaining({
      fileId: 'sf_write',
      filePath: '/workspace/draft.md',
      operations: ['created'],
    }));
  });

  it('session_branch_reset truncates the target session from the replayed user message', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'session_branch_reset',
      sessionPath: '/s1',
      messageId: 'entry-u2',
      clientMessageId: 'client-u2',
    });

    expect(mocks.state.truncateSessionFromMessage).toHaveBeenCalledWith('/s1', 'client-u2');
  });

  it('appends current channel WebSocket messages without reloading the whole channel', async () => {
    mocks.state.currentTab = 'channels';
    mocks.state.currentChannel = 'ch_live';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'channel_new_message',
      channelName: 'ch_live',
      message: { sender: 'codia', timestamp: '2026-05-13 10:01', body: 'hello' },
    });

    expect(mocks.appendChannelMessage).toHaveBeenCalledWith('ch_live', {
      sender: 'codia',
      timestamp: '2026-05-13 10:01',
      body: 'hello',
    });
    expect(mocks.openChannel).not.toHaveBeenCalled();
    expect(mocks.loadChannels).not.toHaveBeenCalled();
  });

  it('updates background channel previews from WebSocket messages without a full reload when payload is present', async () => {
    mocks.state.currentTab = 'chat';
    mocks.state.currentChannel = 'ch_current';

    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'channel_new_message',
      channelName: 'ch_other',
      message: { sender: 'codia', timestamp: '2026-05-13 10:02', body: 'background' },
    });

    expect(mocks.appendChannelMessage).toHaveBeenCalledWith('ch_other', {
      sender: 'codia',
      timestamp: '2026-05-13 10:02',
      body: 'background',
    });
    expect(mocks.loadChannels).not.toHaveBeenCalled();
  });

  it('routes DM events to the peer when the current agent is the sender of the DM', async () => {
    mocks.state.currentTab = 'channels';
    mocks.state.currentAgentId = 'alice';
    mocks.state.currentChannel = 'dm:bob';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'dm_new_message',
      from: 'alice',
      to: 'bob',
    });

    expect(mocks.openChannel).toHaveBeenCalledWith('dm:bob', true);
    expect(mocks.loadChannels).not.toHaveBeenCalled();
  });

  it('routes conversation agent activity events into the channel store', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    const activity = {
      conversationId: 'ch_live',
      conversationType: 'channel',
      agentId: 'worker-1',
      state: 'replying',
      summary: 'preparing reply',
      timestamp: '2026-05-13T10:00:00.000Z',
    };

    handleServerMessage({
      type: 'conversation_agent_activity',
      activity,
    });

    expect(mocks.upsertConversationAgentActivity).toHaveBeenCalledWith(activity);
  });

  it('starts a fresh stream target when a new user message is appended to a session', async () => {
    mocks.state.chatSessions = { '/s1': { items: [], hasMore: false, loadingMore: false } };
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/s1',
      message: {
        id: 'user-next',
        text: '继续处理',
        timestamp: '2026-05-29T10:00:00.000Z',
      },
    });

    expect(mocks.streamBeginUserTurn).toHaveBeenCalledWith('/s1');
    expect(mocks.state.appendItem).toHaveBeenCalledWith('/s1', expect.objectContaining({
      type: 'message',
      data: expect.objectContaining({ id: 'user-next', role: 'user' }),
    }));
  });

  it('preserves selected workspace tool metadata on live user messages', async () => {
    mocks.state.chatSessions = { '/s1': { items: [], hasMore: false, loadingMore: false } };
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/s1',
      message: {
        id: 'user-tool',
        text: '这个工具是干嘛用的',
        timestamp: '2026-06-27T01:50:00.000Z',
        workspaceTool: {
          id: 'research',
          title: '研究模式',
          description: '引用溯源、可信度、可导出报告',
        },
      },
    });

    expect(mocks.state.appendItem).toHaveBeenCalledWith('/s1', expect.objectContaining({
      type: 'message',
      data: expect.objectContaining({
        id: 'user-tool',
        workspaceTool: {
          id: 'research',
          title: '研究模式',
          description: '引用溯源、可信度、可导出报告',
        },
      }),
    }));
  });

  it('appends a new user message after a stale assistant target when the session is not streaming', async () => {
    mocks.state.streamingSessions = [];
    mocks.state.chatSessions = {
      '/s1': {
        items: [
          { type: 'message', data: { id: 'user-prev', role: 'user', text: 'old prompt' } },
          { type: 'message', data: { id: 'assistant-prev', role: 'assistant', blocks: [{ type: 'text', source: 'old answer' }] } },
        ],
        hasMore: false,
        loadingMore: false,
      },
    };
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/s1',
      message: {
        id: 'user-next',
        text: '继续处理',
        timestamp: '2026-05-29T10:01:00.000Z',
      },
    });

    expect(chatItems('/s1').map((item) => item.data.id)).toEqual([
      'user-prev',
      'assistant-prev',
      'user-next',
    ]);
    expect(mocks.streamBeginUserTurn).toHaveBeenCalledWith('/s1');
  });

  it('inserts a late user echo before the already-started assistant stream', async () => {
    mocks.state.streamingSessions = ['/s1'];
    mocks.state.chatSessions = {
      '/s1': {
        items: [
          { type: 'message', data: { id: 'assistant-prev', role: 'assistant', blocks: [] } },
          { type: 'message', data: { id: 'stream-current', role: 'assistant', blocks: [{ type: 'text', source: 'partial' }] } },
        ],
        hasMore: false,
        loadingMore: false,
      },
    };
    mocks.getActiveStreamMessageId.mockReturnValueOnce('stream-current');
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/s1',
      message: {
        id: 'user-late',
        text: '新的问题',
        timestamp: '2026-05-29T10:00:00.000Z',
      },
    });

    expect(chatItems('/s1').map((item) => item.data.id)).toEqual([
      'assistant-prev',
      'user-late',
      'stream-current',
    ]);
    expect(mocks.streamBeginUserTurn).not.toHaveBeenCalled();
  });
});

describe('ws-message-handler resource events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    mocks.state = {
      ...mocks.state,
      deskBasePath: '/workspace',
      deskWorkspaceMountId: null,
      deskWorkspaceNativeRoot: null,
      previewByOwner: {},
      markDeskTreeDirty: vi.fn(),
    };
  });

  it('marks the affected desk tree directory dirty for ResourceIO changes', async () => {
    const { handleServerMessage } = await import('../../services/ws-message-handler');

    handleServerMessage({
      type: 'resource.changed',
      resource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/workspace/notes/a.md',
      },
    });

    expect(mocks.state.markDeskTreeDirty).toHaveBeenCalledWith('notes');
    expect(mocks.loadDeskTreeFiles).not.toHaveBeenCalled();
  });
});
