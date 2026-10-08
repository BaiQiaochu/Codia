// @vitest-environment jsdom

import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureChatSelection, captureSelection, clearSelection, initQuotedSelectionLifecycle } from '../../stores/selection-actions';
import { useStore } from '../../stores';
import type { Artifact } from '../../types';

const artifact: Artifact = {
  id: 'artifact-1',
  title: 'note.md',
  type: 'markdown',
  content: '',
  filePath: '/notes/note.md',
};

describe('captureSelection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
    useStore.getState().clearQuoteCandidate();
    useStore.getState().clearQuotedSelections();
    useStore.setState({ chatSessions: {} } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the trimmed text range for lineEnd when a CodeMirror selection includes trailing whitespace', () => {
    const state = EditorState.create({
      doc: 'alpha\nbeta\ngamma',
      selection: { anchor: 6, head: 11 },
    });

    captureSelection(artifact, { state } as EditorView);

    expect(useStore.getState().quoteCandidate).toMatchObject({
      text: 'beta',
      sourceTitle: 'note.md',
      sourceKind: 'preview',
      sourceFilePath: '/notes/note.md',
      lineStart: 2,
      lineEnd: 2,
      selectionAnchorKind: 'codemirror',
      charCount: 4,
      updatedAt: expect.any(Number),
    });
    expect(useStore.getState().quotedSelections).toEqual([]);
  });

  it('stores a CodeMirror focus anchor rect when coordinates are available', () => {
    const state = EditorState.create({
      doc: 'alpha beta',
      selection: { anchor: 0, head: 5 },
    });
    const coordsAtPos = vi.fn((pos: number) => ({
      left: pos === 0 ? 10 : 48,
      right: pos === 0 ? 12 : 50,
      top: 20,
      bottom: 38,
      width: 2,
      height: 18,
    } as DOMRect));

    captureSelection(artifact, { state, coordsAtPos } as unknown as EditorView);

    expect(useStore.getState().quoteCandidate?.anchorRect).toEqual({
      left: 50,
      right: 51,
      top: 20,
      bottom: 21,
      width: 1,
      height: 1,
    });
  });

  it('captures selected assistant chat text as a quote candidate with explicit message ownership', () => {
    useStore.setState({
      chatSessions: {
        '/session/a.jsonl': {
          items: [
            {
              type: 'message',
              data: {
                id: 'assistant-1',
                role: 'assistant',
                blocks: [{ type: 'text', html: '<p>quoted text</p>', source: 'quoted text' }],
              },
            },
          ],
          hasMore: false,
          loadingMore: false,
        },
      },
    } as never);
    document.body.innerHTML = `
      <article data-message-id="assistant-1">
        <p><span id="selected-text">quoted text</span></p>
      </article>
    `;
    selectElementText(document.getElementById('selected-text')!);

    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate).toMatchObject({
      text: 'quoted text',
      sourceKind: 'chat',
      sourceSessionPath: '/session/a.jsonl',
      sourceMessageId: 'assistant-1',
      sourceRole: 'assistant',
      selectionAnchorKind: 'native',
      charCount: 11,
    });
    expect(useStore.getState().quotedSelections).toEqual([]);
  });

  it('keeps CodeMirror preview capture independent from an empty native selection', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      useStore.getState().setQuoteCandidate({
        text: 'editor quote',
        sourceTitle: 'note.md',
        sourceKind: 'preview',
        sourceFilePath: '/notes/note.md',
        selectionAnchorKind: 'codemirror',
        charCount: 12,
      } as never);

      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));

      expect(useStore.getState().quoteCandidate).toMatchObject({
        text: 'editor quote',
        sourceKind: 'preview',
        selectionAnchorKind: 'codemirror',
      });
    } finally {
      dispose();
    }
  });

  it('captures chat text from the document-level mouseup lifecycle when release happens outside the chat panel', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      seedChatFixture();
      document.body.innerHTML = `
        <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
          <article data-message-id="assistant-1">
            <p><span id="selected-text">document mouseup quote</span></p>
          </article>
        </section>
        <aside id="outside-chat">outside</aside>
      `;
      selectElementText(document.getElementById('selected-text')!);

      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(useStore.getState().quoteCandidate).toMatchObject({
        text: 'document mouseup quote',
        sourceKind: 'chat',
        sourceSessionPath: '/session/a.jsonl',
        sourceMessageId: 'assistant-1',
      });
    } finally {
      dispose();
    }
  });

  it('falls back to the message element bounds when the native selection range has no usable rects', () => {
    seedChatFixture();
    document.body.innerHTML = `
      <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
        <article id="message" data-message-id="assistant-1">
          <p><span id="selected-text">fallback bounds quote</span></p>
        </article>
      </section>
    `;
    const message = document.getElementById('message')!;
    Object.defineProperty(message, 'getBoundingClientRect', {
      value: () => domRect({ left: 24, right: 224, top: 80, bottom: 128, width: 200, height: 48 }),
    });
    const range = selectElementText(document.getElementById('selected-text')!);
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => [] as unknown as DOMRectList,
    });
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => domRect({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
    });

    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate?.anchorRect).toEqual({
      left: 24,
      right: 224,
      top: 80,
      bottom: 128,
      width: 200,
      height: 48,
    });
  });

  it('keeps committed quotes when composer focus cancels the native selection candidate', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      useStore.getState().addQuotedSelection({
        text: 'old quote',
        sourceTitle: 'Assistant message',
        sourceKind: 'chat',
        sourceSessionPath: '/session/a.jsonl',
        sourceMessageId: 'assistant-1',
        sourceRole: 'assistant',
        charCount: 9,
      });
      document.body.innerHTML = '<textarea id="composer"></textarea>';
      document.getElementById('composer')?.focus();

      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));

      expect(useStore.getState().quotedSelections[0]).toMatchObject({
        text: 'old quote',
        sourceKind: 'chat',
      });
    } finally {
      dispose();
    }
  });

  it('clears an existing candidate when the collapsed native selection remains in the same chat session', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      useStore.setState({
        chatSessions: {
          '/session/a.jsonl': {
            items: [
              {
                type: 'message',
                data: {
                  id: 'assistant-1',
                  role: 'assistant',
                  blocks: [{ type: 'text', html: '<p>inside chat</p>', source: 'inside chat' }],
                },
              },
            ],
            hasMore: false,
            loadingMore: false,
          },
        },
      } as never);
      document.body.innerHTML = `
        <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
          <article data-message-id="assistant-1">
            <span id="selected-text">inside chat</span>
            <span id="caret-host">cancel here</span>
          </article>
        </section>
      `;
      selectElementText(document.getElementById('selected-text')!);
      captureChatSelection('/session/a.jsonl');
      expect(useStore.getState().quoteCandidate).toMatchObject({ text: 'inside chat' });

      placeCollapsedSelection(document.getElementById('caret-host')!);

      document.dispatchEvent(new Event('selectionchange'));

      expect(useStore.getState().quoteCandidate).toBeNull();
    } finally {
      dispose();
    }
  });

  it('clears an existing candidate when chat capture sees an empty selection', () => {
    useStore.getState().setQuoteCandidate({
      text: 'old quote',
      sourceTitle: 'Assistant message',
      sourceKind: 'chat',
      sourceSessionPath: '/session/a.jsonl',
      sourceMessageId: 'assistant-1',
      sourceRole: 'assistant',
      charCount: 9,
    });

    window.getSelection()?.removeAllRanges();
    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate).toBeNull();
  });

  it('clears only candidates matching the requested source scope', () => {
    useStore.getState().setQuoteCandidate({
      text: 'chat quote',
      sourceTitle: 'Assistant message',
      sourceKind: 'chat',
      sourceSessionPath: '/session/a.jsonl',
      sourceMessageId: 'assistant-1',
      sourceRole: 'assistant',
      charCount: 10,
    });

    clearSelection({ sourceKind: 'preview' });

    expect(useStore.getState().quoteCandidate).toMatchObject({
      text: 'chat quote',
      sourceKind: 'chat',
    });

    clearSelection({ sourceKind: 'chat', sourceSessionPath: '/session/a.jsonl' });

    expect(useStore.getState().quoteCandidate).toBeNull();
  });

  it('ignores cross-message chat selections instead of stealing ambiguous ownership', () => {
    useStore.setState({
      chatSessions: {
        '/session/a.jsonl': {
          items: [
            { type: 'message', data: { id: 'user-1', role: 'user', text: 'first' } },
            { type: 'message', data: { id: 'assistant-1', role: 'assistant', blocks: [] } },
          ],
          hasMore: false,
          loadingMore: false,
        },
      },
    } as never);
    document.body.innerHTML = `
      <article data-message-id="user-1"><span id="start-text">first</span></article>
      <article data-message-id="assistant-1"><span id="end-text">second</span></article>
    `;
    selectAcrossElements(
      document.getElementById('start-text')!,
      document.getElementById('end-text')!,
    );

    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate).toBeNull();
  });

  it('ignores selections inside chat action buttons', () => {
    useStore.setState({
      chatSessions: {
        '/session/a.jsonl': {
          items: [
            { type: 'message', data: { id: 'assistant-1', role: 'assistant', blocks: [] } },
          ],
          hasMore: false,
          loadingMore: false,
        },
      },
    } as never);
    document.body.innerHTML = `
      <article data-message-id="assistant-1">
        <button type="button"><span id="button-text">copy</span></button>
      </article>
    `;
    selectElementText(document.getElementById('button-text')!);

    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate).toBeNull();
  });
});

describe('message selection store helpers', () => {
  beforeEach(() => {
    useStore.setState({ selectedIdsBySession: {} } as never);
  });

  it('sets and extends message selection with stable de-duplication', () => {
    useStore.getState().setMessageSelection('/session/a.jsonl', ['m1', 'm2', 'm1']);
    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toEqual(['m1', 'm2']);

    useStore.getState().addMessagesToSelection('/session/a.jsonl', ['m2', 'm3']);
    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toEqual(['m1', 'm2', 'm3']);
  });

  it('removes the session key when bulk selection is empty', () => {
    useStore.getState().setMessageSelection('/session/a.jsonl', ['m1']);
    useStore.getState().setMessageSelection('/session/a.jsonl', []);
    expect(useStore.getState().selectedIdsBySession).not.toHaveProperty('/session/a.jsonl');
  });
});

function seedChatFixture(): void {
  useStore.setState({
    chatSessions: {
      '/session/a.jsonl': {
        items: [
          {
            type: 'message',
            data: {
              id: 'assistant-1',
              role: 'assistant',
              blocks: [{ type: 'text', html: '<p>document mouseup quote</p>', source: 'document mouseup quote' }],
            },
          },
        ],
        hasMore: false,
        loadingMore: false,
      },
    },
  } as never);
}

function domRect(rect: { left: number; right: number; top: number; bottom: number; width: number; height: number }): DOMRect {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  } as DOMRect;
}

function selectElementText(element: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

function selectAcrossElements(startElement: HTMLElement, endElement: HTMLElement): void {
  const startNode = startElement.firstChild;
  const endNode = endElement.firstChild;
  if (!startNode || !endNode) throw new Error('test fixture must contain text nodes');
  const range = document.createRange();
  range.setStart(startNode, 0);
  range.setEnd(endNode, endNode.textContent?.length || 0);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCollapsedSelection(element: HTMLElement): void {
  const textNode = element.firstChild;
  if (!textNode) throw new Error('test fixture must contain a text node');
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
