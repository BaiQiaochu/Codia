/**
 * @vitest-environment jsdom
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markdownCoverField } from '../../editor/cover-field';
import { markdownImageContextFacet } from '../../editor/md-decorations';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  codiaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: mocks.codiaFetch,
}));

const originalPrompt = window.prompt;

afterEach(() => {
  document.body.innerHTML = '';
  mocks.codiaFetch.mockReset();
  window.prompt = originalPrompt;
  useStore.setState({ currentAgentId: null } as never);
});

describe('markdown cover editor field', () => {
  it('renders cover frontmatter as an editor widget without exposing raw YAML text', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          '---',
          'cover:',
          '  image: 文本附件/cover.png',
          '  displayWidth: 72',
          '  displayHeight: 280',
          '  positionY: 64',
          '---',
          '# Demo',
        ].join('\n'),
        extensions: [
          markdownImageContextFacet.of({
            filePath: '/vault/notes/day.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownCoverField,
        ],
      }),
    });

    const cover = parent.querySelector('.cm-markdown-cover') as HTMLElement | null;
    const img = parent.querySelector('.cm-markdown-cover img');

    expect(cover).toBeInstanceOf(HTMLElement);
    expect(cover?.classList.contains('cm-markdown-cover-top')).toBe(true);
    expect(view.dom.classList.contains('cm-markdown-has-top-cover')).toBe(true);
    expect(cover?.style.width).toBe('72%');
    expect(cover?.style.height).toBe('280px');
    expect(parent.textContent).not.toContain('cover:');
    expect(parent.textContent).toContain('Demo');
    expect(img?.getAttribute('src')).toBe('file:///vault/notes/文本附件/cover.png');
    expect((img as HTMLElement | null)?.style.objectPosition).toBe('50% 64%');

    view.destroy();
  });

  it('does not hide non-cover frontmatter fields in editor mode', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          '---',
          'title: Demo Note',
          'cover:',
          '  image: 文本附件/cover.png',
          'tags:',
          '  - writing',
          '---',
          '# Demo',
        ].join('\n'),
        extensions: [
          markdownImageContextFacet.of({
            filePath: '/vault/notes/day.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownCoverField,
        ],
      }),
    });

    expect(parent.querySelector('.cm-markdown-cover')).toBeInstanceOf(HTMLElement);
    expect(parent.querySelector('.cm-markdown-cover')?.classList.contains('cm-markdown-cover-top')).toBe(false);
    expect(view.dom.classList.contains('cm-markdown-has-top-cover')).toBe(false);
    expect(parent.textContent).toContain('title: Demo Note');
    expect(parent.textContent).toContain('tags:');
    expect(parent.textContent).not.toContain('cover:');

    view.destroy();
  });

  it('marks full-width covers as horizontal bleed blocks', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          '---',
          'cover:',
          '  image: 文本附件/cover.png',
          '---',
          '# Demo',
        ].join('\n'),
        extensions: [
          markdownImageContextFacet.of({
            filePath: '/vault/notes/day.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownCoverField,
        ],
      }),
    });

    const cover = parent.querySelector('.cm-markdown-cover') as HTMLElement | null;

    expect(cover?.classList.contains('cm-markdown-cover-top')).toBe(true);
    expect(cover?.classList.contains('cm-markdown-cover-bleed-x')).toBe(true);
    expect(cover?.style.width).toBe('');
    expect(cover?.style.marginLeft).toBe('');
    expect(cover?.style.marginRight).toBe('');

    view.destroy();
  });

  it('opens the same cover context menu in editor mode', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          '---',
          'cover:',
          '  image: 文本附件/cover.png',
          '---',
          '# Demo',
        ].join('\n'),
        extensions: [
          markdownImageContextFacet.of({
            filePath: '/vault/notes/day.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownCoverField,
        ],
      }),
    });

    const cover = parent.querySelector('.cm-markdown-cover') as HTMLElement | null;
    expect(cover).toBeInstanceOf(HTMLElement);

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 18,
      clientY: 24,
    });
    const notPrevented = cover!.dispatchEvent(event);

    expect(notPrevented).toBe(false);
    const menu = parent.querySelector('.markdown-cover-menu') as HTMLElement | null;
    expect(menu).toBeInstanceOf(HTMLElement);
    expect(menu?.style.left).toBe('18px');
    expect(menu?.style.top).toBe('24px');
    expect([...menu!.querySelectorAll('button')].map(button => button.textContent)).toEqual([
      '保存图片',
      '自定义提示词生成图片',
      '删除封面',
    ]);

    view.destroy();
  });

  it('removes the cover block from editor mode through the context menu', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          '---',
          'title: Demo',
          'cover:',
          '  image: 文本附件/cover.png',
          '---',
          '# Demo',
        ].join('\n'),
        extensions: [
          markdownImageContextFacet.of({
            filePath: '/vault/notes/day.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownCoverField,
        ],
      }),
    });

    const cover = parent.querySelector('.cm-markdown-cover') as HTMLElement | null;
    cover!.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 18,
      clientY: 24,
    }));
    const deleteButton = [...parent.querySelectorAll('.markdown-cover-menu button')]
      .find(button => button.textContent === '删除封面') as HTMLButtonElement | undefined;

    deleteButton?.click();

    expect(view.state.doc.toString()).toBe([
      '---',
      'title: Demo',
      '---',
      '# Demo',
    ].join('\n'));

    view.destroy();
  });

  it('opens an in-app prompt dialog for custom cover generation in editor mode', async () => {
    window.prompt = vi.fn(() => {
      throw new Error('prompt() is not supported');
    });
    mocks.codiaFetch.mockResolvedValueOnce(new Response(JSON.stringify({
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

    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          '---',
          'cover:',
          '  image: 文本附件/cover.png',
          '---',
          '# Demo',
        ].join('\n'),
        extensions: [
          markdownImageContextFacet.of({
            filePath: '/vault/notes/day.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownCoverField,
        ],
      }),
    });

    try {
      const cover = parent.querySelector('.cm-markdown-cover') as HTMLElement | null;
      cover!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 18,
        clientY: 24,
      }));
      const generateButton = [...parent.querySelectorAll('.markdown-cover-menu button')]
        .find(button => button.textContent === '自定义提示词生成图片') as HTMLButtonElement | undefined;

      generateButton?.click();

      expect(window.prompt).not.toHaveBeenCalled();
      const dialog = document.querySelector('.markdown-cover-prompt-dialog') as HTMLElement | null;
      expect(dialog).toBeInstanceOf(HTMLElement);

      const textarea = dialog!.querySelector('textarea') as HTMLTextAreaElement;
      textarea.value = '偏暖色、留白更多';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      (dialog!.querySelector('.markdown-cover-prompt-primary') as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(mocks.codiaFetch).toHaveBeenCalledWith('/api/desk/beautify/status');
        expect(mocks.codiaFetch).not.toHaveBeenCalledWith('/api/desk/beautify/status?executorAgentId=agent-1');
        expect(mocks.codiaFetch).toHaveBeenCalledWith('/api/desk/beautify/cover', expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            filePath: '/vault/notes/day.md',
            themeTone: 'light',
            executorAgentId: 'agent-1',
            userGuidance: '偏暖色、留白更多',
          }),
        }));
      });
    } finally {
      view.destroy();
    }
  });

  it('resolves Windows absolute cover image paths through the platform file URL helper', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          '---',
          'cover:',
          '  image: E:/docs/文本附件/preset-cover.png',
          '---',
          '# Demo',
        ].join('\n'),
        extensions: [
          markdownImageContextFacet.of({
            filePath: 'E:/docs/day.md',
            getFileUrl: (filePath) => `file:///${filePath.replace(/\\/g, '/')}`,
          }),
          markdownCoverField,
        ],
      }),
    });

    const img = parent.querySelector('.cm-markdown-cover img');

    expect(img?.getAttribute('src')).toBe('file:///E:/docs/文本附件/preset-cover.png');

    view.destroy();
  });
});
