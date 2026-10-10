// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { JSONContent } from '@tiptap/core';
import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../components/InputArea';
import { useStore } from '../../stores';
import type { DeskSearchResult } from '../../types';

const mocks = vi.hoisted(() => ({
  editorObject: undefined as any,
  insertContent: vi.fn(),
  editorOptions: undefined as undefined | Record<string, unknown>,
  editorText: '',
  editorJson: undefined as undefined | JSONContent,
  editorState: undefined as undefined | EditorState,
  updateHandler: undefined as undefined | (() => void),
  searchDeskFiles: vi.fn(async (_query: string): Promise<DeskSearchResult[]> => []),
  mentionMenuProps: undefined as undefined | {
    items: Array<{ source?: string; name: string }>;
    busy: boolean;
  },
}));

const mentionSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    fileBadge: { group: 'inline', inline: true, atom: true, attrs: {
      path: { default: '' }, name: { default: '' }, mimeType: { default: null },
    } },
    skillBadge: { group: 'inline', inline: true, atom: true, attrs: { name: { default: '' } } },
  },
});

function editorJsonForText(text: string) {
  return {
    type: 'doc',
    content: text
      ? [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      : [],
  };
}

function setMockEditorDocument(doc: ProseMirrorNode, cursor: number): void {
  mocks.editorText = doc.textBetween(0, doc.content.size, '\n', '');
  mocks.editorJson = doc.toJSON();
  mocks.editorState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, cursor),
  });
}

vi.mock('@tiptap/react', () => ({
  useEditor: (options: Record<string, unknown>) => {
    mocks.editorOptions = options;
    if (mocks.editorObject) return mocks.editorObject;
    const chain = {
      deleteRange: vi.fn(() => chain),
      insertContent: vi.fn((content: unknown) => { mocks.insertContent(content); return chain; }),
      focus: vi.fn(() => chain),
      run: vi.fn(),
    };
    return mocks.editorObject = {
      commands: {
        focus: vi.fn(),
        clearContent: vi.fn(),
        scrollIntoView: vi.fn(),
        setContent: vi.fn(),
        insertContent: vi.fn(),
        splitListItem: vi.fn(),
      },
      chain: () => chain,
      getText: () => mocks.editorText,
      getJSON: () => mocks.editorJson ?? editorJsonForText(mocks.editorText),
      isActive: vi.fn(() => false),
      isDestroyed: false,
      isEditable: true,
      setEditable: vi.fn(),
      get state() {
        return mocks.editorState ?? { tr: { setMeta: vi.fn(() => ({})) } };
      },
      view: { dispatch: vi.fn() },
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'update') mocks.updateHandler = handler;
      }),
      off: vi.fn(),
    };
  },
  EditorContent: () => React.createElement('div', { 'data-testid': 'editor' }),
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: () => ({}) },
}));

vi.mock('@tiptap/extension-bold', () => ({
  Bold: { extend: () => ({}) },
}));

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: () => ({ name: 'placeholder' }) },
}));

vi.mock('../../components/input/extensions/skill-badge', () => ({
  SkillBadge: { name: 'skillBadge' },
}));

vi.mock('../../components/input/extensions/file-badge', () => ({
  FileBadge: { name: 'fileBadge' },
}));

vi.mock('../../components/input/extensions/agent-badge', () => ({
  AgentBadge: { name: 'agentBadge' },
}));

vi.mock('../../components/input/extensions/session-badge', () => ({
  SessionBadge: { name: 'sessionBadge' },
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'zh-CN' }),
}));

vi.mock('../../hooks/use-config', () => ({
  fetchConfig: vi.fn(async () => ({})),
}));

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  codiaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../stores/session-actions', () => ({
  ensureSession: vi.fn(async () => ({
    sessionId: 'sess_input',
    sessionPath: '/session/input.jsonl',
    agentId: 'codia',
  })),
  loadSessions: vi.fn(),
  upsertOptimisticSessionFirstMessage: vi.fn(),
  continueDeletedAgentSession: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
  searchDeskFiles: (query: string) => mocks.searchDeskFiles(query),
  toggleJianSidebar: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: vi.fn(() => ({ readyState: WebSocket.OPEN, send: vi.fn() })),
}));

vi.mock('../../MainContent', () => ({
  attachFilesFromPaths: vi.fn(),
}));

vi.mock('../../components/input/SlashCommandMenu', () => ({
  SlashCommandMenu: () => null,
}));

vi.mock('../../components/input/MentionMenu', () => ({
  MentionMenu: (props: {
    items: Array<{ source?: string; name: string }>;
    busy: boolean;
  }) => {
    mocks.mentionMenuProps = props;
    return React.createElement(
      'div',
      {
        'data-testid': 'mention-menu',
        'data-busy': String(props.busy),
        'data-item-count': String(props.items.length),
      },
      props.items.map(item => React.createElement(
        'div',
        { key: item.name, 'data-source': item.source ?? 'unknown' },
        item.name,
      )),
    );
  },
}));

vi.mock('../../components/input/InputStatusBars', () => ({
  InputStatusBars: () => null,
}));

vi.mock('../../components/input/InputContextRow', () => ({
  InputContextRow: () => null,
}));

vi.mock('../../components/input/InputControlBar', () => ({
  InputControlBar: () => null,
}));

vi.mock('../../components/input/SessionConfirmationPrompt', () => ({
  SessionConfirmationPrompt: () => null,
}));

vi.mock('../../hooks/use-slash-items', () => ({
  useSkillSlashItems: () => [],
  useServerSlashCommandItems: () => [],
}));

vi.mock('../../utils/paste-upload-feedback', () => ({
  notifyPasteUploadFailure: vi.fn(),
}));

vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));

function seedInputState() {
  useStore.setState({
    currentSessionPath: '/session/input.jsonl',
    currentSessionId: 'sess_input',
    currentAgentId: 'codia',
    pendingDraftId: 'draft-input',
    sessions: [],
    sessionLocatorsById: { sess_input: { path: '/session/input.jsonl' } },
    connected: true,
    pendingNewSession: false,
    streamingSessions: [],
    compactingSessions: [],
    inlineErrors: {},
    attachedFiles: [],
    drafts: {},
    editorDrafts: {},
    attachedFilesBySession: {},
    docContextAttached: false,
    quoteCandidate: null,
    quotedSelections: [],
    quotedSelection: null,
    models: [{
      id: 'deepseek-chat',
      provider: 'deepseek',
      name: 'DeepSeek Chat',
      input: ['text'],
      isCurrent: true,
    }],
    sessionModelsByPath: {},
    previewItems: [],
    previewOpen: false,
    activeTabId: null,
    chatSessions: {},
    serverPort: 3210,
    serverToken: null,
    modelSwitching: false,
    welcomeVisible: false,
    agentYuan: 'codia',
    deskFiles: [{ name: 'README.md', isDir: false }],
    deskBasePath: '/workspace',
    agents: [],
  } as never);
}

describe('InputArea mention interactions', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.editorObject = undefined;
    mocks.editorOptions = undefined;
    mocks.editorText = '';
    mocks.editorJson = undefined;
    mocks.editorState = undefined;
    mocks.updateHandler = undefined;
    mocks.mentionMenuProps = undefined;
    mocks.searchDeskFiles.mockResolvedValue([{
      name: 'reader.ts',
      relativePath: 'src/reader.ts',
      parentSubdir: 'src',
      isDir: false,
    }]);
    seedInputState();
    window.platform = {} as typeof window.platform;
  });

  it('lets the IME commit Chinese text without selecting a mention or sending the message', async () => {
    const doc = mentionSchema.node('doc', null, [
      mentionSchema.node('paragraph', null, [mentionSchema.text('@read')]),
    ]);
    setMockEditorDocument(doc, doc.content.size - 1);
    render(React.createElement(InputArea));
    act(() => { mocks.updateHandler?.(); });
    await waitFor(() => expect(screen.getByTestId('mention-menu')).toBeTruthy());
    const keyDown = (mocks.editorOptions?.editorProps as {
      handleKeyDown: (view: unknown, event: unknown) => boolean;
    }).handleKeyDown;
    const preventDefault = vi.fn();
    expect(keyDown(null, { key: 'Enter', isComposing: true, preventDefault })).toBe(false);
    expect(keyDown(null, { key: 'Enter', keyCode: 229, preventDefault })).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(mocks.insertContent).not.toHaveBeenCalled();
  });

  it('selects a file reference with Enter after composition has finished', async () => {
    const doc = mentionSchema.node('doc', null, [
      mentionSchema.node('paragraph', null, [mentionSchema.text('@read')]),
    ]);
    setMockEditorDocument(doc, doc.content.size - 1);
    render(React.createElement(InputArea));
    act(() => { mocks.updateHandler?.(); });
    await waitFor(() => expect(mocks.mentionMenuProps?.items.some(item => item.name === 'reader.ts')).toBe(true));
    const keyDown = (mocks.editorOptions?.editorProps as {
      handleKeyDown: (view: unknown, event: unknown) => boolean;
    }).handleKeyDown;
    const preventDefault = vi.fn();
    act(() => { expect(keyDown(null, { key: 'Enter', isComposing: false, preventDefault })).toBe(true); });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.insertContent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fileBadge', attrs: expect.objectContaining({ path: '/workspace/src/reader.ts' }),
    }));
  });

  it('searches desk files when @ mention menu opens with a query and shows workspace results', async () => {
    const doc = mentionSchema.node('doc', null, [
      mentionSchema.node('paragraph', null, [mentionSchema.text('@read')]),
    ]);
    setMockEditorDocument(doc, doc.content.size - 1);

    render(React.createElement(InputArea));

    await waitFor(() => {
      expect(mocks.updateHandler).toBeTypeOf('function');
    });

    act(() => {
      mocks.updateHandler?.();
    });

    expect(screen.getByTestId('mention-menu')).toBeTruthy();

    await waitFor(() => {
      expect(mocks.searchDeskFiles).toHaveBeenCalledWith('read');
    }, { timeout: 500 });

    await waitFor(() => {
      expect(mocks.mentionMenuProps?.items.some(item => (
        item.source === 'workspace' && item.name === 'reader.ts'
      ))).toBe(true);
    }, { timeout: 500 });

    expect(screen.getByTestId('mention-menu').getAttribute('data-busy')).toBe('false');
  });

  it('restores the original badge document after switching between chats with identical plain text', async () => {
    const richDocument: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: '请查看 ' },
      { type: 'fileBadge', attrs: { path: '/work/mockup.png', name: 'mockup.png', mimeType: 'image/png' } },
      { type: 'skillBadge', attrs: { name: 'user-guide' } },
    ] }] };
    const richNode = mentionSchema.nodeFromJSON(richDocument);
    setMockEditorDocument(richNode, richNode.content.size - 1);
    useStore.getState().setDraft('/session/input.jsonl', mocks.editorText, richDocument);
    useStore.getState().setDraft('/session/other.jsonl', mocks.editorText);
    render(React.createElement(InputArea));
    const setContent = mocks.editorObject.commands.setContent;
    setContent.mockClear();
    act(() => useStore.setState({ currentSessionPath: '/session/other.jsonl', currentSessionId: null }));
    expect(setContent).toHaveBeenCalledWith(expect.objectContaining({ type: 'doc' }), { emitUpdate: false });
    expect(setContent.mock.calls[0][0]).not.toEqual(richDocument);
    const plainNode = mentionSchema.nodeFromJSON(editorJsonForText(mocks.editorText));
    setMockEditorDocument(plainNode, plainNode.content.size - 1);
    setContent.mockClear();
    act(() => useStore.setState({ currentSessionPath: '/session/input.jsonl', currentSessionId: 'sess_input' }));
    expect(setContent).toHaveBeenCalledWith(richDocument, { emitUpdate: false });
  });
});
