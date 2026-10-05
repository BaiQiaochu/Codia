import { describe, it, expect, beforeEach } from 'vitest';
import { createInputSlice, type InputSlice, type QuotedSelection } from '../../stores/input-slice';

function makeSlice(extras: Record<string, unknown> = {}): InputSlice {
  let state: InputSlice & Record<string, unknown>;
  const set = (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = { ...createInputSlice(set), ...extras };
  return new Proxy({} as InputSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
    set: (_, key: string, value: unknown) => {
      state = { ...state, [key]: value };
      return true;
    },
  });
}

function quote(text: string, sourceTitle = 'source'): QuotedSelection {
  return {
    text,
    sourceTitle,
    sourceKind: 'preview',
    sourceFilePath: '/path/to/file.md',
    charCount: text.length,
  };
}

describe('input-slice quoted selections', () => {
  let slice: InputSlice;
  beforeEach(() => { slice = makeSlice(); });

  it('initializes candidate and committed quotes separately', () => {
    expect(slice.quoteCandidate).toBeNull();
    expect(slice.quotedSelections).toEqual([]);
    expect(slice.quotedSelection).toBeNull();
  });

  it('stores a transient quote candidate without committing it to composer chips', () => {
    const sel = quote('candidate');
    slice.setQuoteCandidate(sel);

    expect(slice.quoteCandidate).toEqual(sel);
    expect(slice.quotedSelections).toEqual([]);
  });

  it('adds and removes committed quote chips while keeping the legacy field compatible', () => {
    slice.addQuotedSelection(quote('first', 'A'));
    slice.addQuotedSelection(quote('second', 'B'));

    expect(slice.quotedSelections.map(sel => sel.text)).toEqual(['first', 'second']);
    expect(slice.quotedSelection?.text).toBe('first');

    slice.removeQuotedSelection(0);

    expect(slice.quotedSelections.map(sel => sel.text)).toEqual(['second']);
    expect(slice.quotedSelection?.text).toBe('second');
  });

  it('legacy setters map to the new committed quote list', () => {
    slice.setQuotedSelection(quote('legacy'));
    expect(slice.quotedSelections.map(sel => sel.text)).toEqual(['legacy']);
    expect(slice.quotedSelection?.text).toBe('legacy');

    slice.clearQuotedSelection();
    expect(slice.quoteCandidate).toBeNull();
    expect(slice.quotedSelections).toEqual([]);
    expect(slice.quotedSelection).toBeNull();
  });
});

describe('input-slice workspace tool selection', () => {
  it('stores the selected workspace tool as global composer state', () => {
    const slice = makeSlice();

    slice.setWorkspaceTool({
      id: 'research',
      title: '研究模式',
      description: '引用溯源',
    });

    expect(slice.workspaceTool).toEqual({
      id: 'research',
      title: '研究模式',
      description: '引用溯源、可信度、可导出报告',
    });

    slice.clearWorkspaceTool();
    expect(slice.workspaceTool).toBeNull();
  });

  it('canonicalizes incomplete workspace tool selections by id', () => {
    const slice = makeSlice();

    slice.setWorkspaceTool({ id: 'research', title: '   ', description: 'x' });

    expect(slice.workspaceTool).toEqual({
      id: 'research',
      title: '研究模式',
      description: '引用溯源、可信度、可导出报告',
    });
  });
});

describe('input-slice session attachments', () => {
  it('keeps rich drafts under stable session keys and clears them when a plain draft replaces them', () => {
    const slice = makeSlice({
      sessions: [{ path: '/sessions/a.jsonl', sessionId: 'sess-a' }],
      sessionLocatorsById: { 'sess-a': { path: '/sessions/a.jsonl' } },
    });
    const document = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'fileBadge', attrs: { path: '/work/photo.png', name: 'photo.png' } },
      { type: 'skillBadge', attrs: { name: 'user-guide' } },
    ] }] };
    slice.setDraft('/sessions/a.jsonl', '', document);
    slice.setDraft('/sessions/b.jsonl', 'another chat');
    expect(slice.editorDrafts['sess-a']).toEqual(document);
    expect(slice.editorDrafts['/sessions/a.jsonl']).toBeUndefined();
    slice.setDraft('/sessions/a.jsonl', 'replaced');
    expect(slice.editorDrafts['sess-a']).toBeUndefined();
    slice.setDraft('/sessions/a.jsonl', '', document);
    slice.clearDraft('/sessions/a.jsonl');
    expect(slice.editorDrafts['sess-a']).toBeUndefined();
    expect(slice.drafts['/sessions/b.jsonl']).toBe('another chat');
  });

  it('mirrors attachment mutations to the current session bucket and keeps fileId', () => {
    const slice = makeSlice() as InputSlice & { currentSessionPath?: string | null };
    slice.currentSessionPath = '/sessions/a.jsonl';

    slice.addAttachedFile({ fileId: 'file-1', path: '/tmp/a.png', name: 'a.png' });

    expect(slice.attachedFiles).toEqual([{ fileId: 'file-1', path: '/tmp/a.png', name: 'a.png' }]);
    expect(slice.attachedFilesBySession['/sessions/a.jsonl']).toEqual(slice.attachedFiles);

    slice.removeAttachedFile(0);

    expect(slice.attachedFiles).toEqual([]);
    expect(slice.attachedFilesBySession['/sessions/a.jsonl']).toEqual([]);
  });

  it('does not create a keyed attachment bucket without a current session path', () => {
    const slice = makeSlice();

    slice.addAttachedFile({ fileId: 'file-1', path: '/tmp/a.png', name: 'a.png' });

    expect(slice.attachedFiles).toHaveLength(1);
    expect(slice.attachedFilesBySession).toEqual({});
  });

  it('recovers when persisted attachment state is not an array', () => {
    const slice = makeSlice() as InputSlice & { currentSessionPath?: string | null; attachedFiles: unknown; attachedFilesBySession: unknown };
    slice.currentSessionPath = '/sessions/a.jsonl';
    slice.attachedFiles = undefined;
    slice.attachedFilesBySession = undefined;

    expect(() => slice.addAttachedFile({ fileId: 'file-1', path: '/tmp/a.png', name: 'a.png' })).not.toThrow();
    expect(slice.attachedFiles).toEqual([{ fileId: 'file-1', path: '/tmp/a.png', name: 'a.png' }]);
    expect((slice.attachedFilesBySession as Record<string, unknown>)['/sessions/a.jsonl']).toEqual(slice.attachedFiles);

    slice.attachedFiles = undefined;
    expect(() => slice.removeAttachedFile(0)).not.toThrow();
    expect(slice.attachedFiles).toEqual([]);
  });

  it('stores attachments and drafts under stable session id when a locator is known', () => {
    const slice = makeSlice({
      currentSessionPath: '/sessions/a.jsonl',
      sessions: [{ path: '/sessions/a.jsonl', sessionId: 'sess-input' }],
      sessionLocatorsById: {
        'sess-input': { path: '/sessions/a.jsonl' },
      },
      attachedFilesBySession: {
        '/sessions/a.jsonl': [{ fileId: 'old', path: '/tmp/old.png', name: 'old.png' }],
      },
      drafts: {
        '/sessions/a.jsonl': 'old draft',
      },
    }) as InputSlice & {
      currentSessionPath?: string | null;
      sessions?: Array<{ path?: string; sessionId?: string }>;
      sessionLocatorsById?: Record<string, { path?: string }>;
    };

    slice.addAttachedFile({ fileId: 'file-1', path: '/tmp/a.png', name: 'a.png' });
    slice.setDraft('/sessions/a.jsonl', 'new draft');

    expect(slice.attachedFilesBySession['sess-input']).toEqual(slice.attachedFiles);
    expect(slice.attachedFilesBySession['/sessions/a.jsonl']).toBeUndefined();
    expect(slice.drafts['sess-input']).toBe('new draft');
    expect(slice.drafts['/sessions/a.jsonl']).toBeUndefined();

    slice.clearDraft('/sessions/a.jsonl');

    expect(slice.drafts['sess-input']).toBeUndefined();
    expect(slice.drafts['/sessions/a.jsonl']).toBeUndefined();
  });
});
