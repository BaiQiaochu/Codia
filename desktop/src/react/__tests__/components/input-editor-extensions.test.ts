// @vitest-environment jsdom

import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { createInputEditorExtensions } from '../../components/input/input-editor-extensions';
import { serializeEditor } from '../../utils/editor-serializer';
import { createInputSlice, type InputSlice } from '../../stores/input-slice';

describe('input editor extensions', () => {
  it('restores selected skills and file/image references after editing a different session draft', () => {
    let input: InputSlice;
    input = createInputSlice(update => {
      input = { ...input, ...(typeof update === 'function' ? update(input) : update) };
    });
    const editor = new Editor({
      extensions: createInputEditorExtensions(''),
      content: { type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'text', text: '请参考 ' },
        { type: 'fileBadge', attrs: { path: '/work/mockup.png', name: 'mockup.png', mimeType: 'image/png' } },
        { type: 'fileBadge', attrs: { path: '/work/brief.md', name: 'brief.md', fileId: 'brief-1' } },
        { type: 'skillBadge', attrs: { name: 'user-guide' } },
      ] }] },
    });
    input.setDraft('/session/one', editor.getText(), editor.getJSON());
    editor.commands.setContent('<p>另一个草稿</p>');
    input.setDraft('/session/two', editor.getText(), editor.getJSON());
    editor.commands.setContent(input.editorDrafts['/session/one']);
    const restored = serializeEditor(editor.getJSON());
    expect(restored.skills).toEqual(['user-guide']);
    expect(restored.fileRefs.map(file => [file.path, file.fileId])).toEqual([
      ['/work/mockup.png', undefined], ['/work/brief.md', 'brief-1'],
    ]);
    expect(restored.text).toContain('@mockup.png');
    expect(input.drafts['/session/two']).toBe('另一个草稿');
    editor.destroy();
  });

  it('does not register TipTap link marks for the chat input', () => {
    const editor = new Editor({
      extensions: createInputEditorExtensions(''),
      content: '<p><a href="https://example.com/article">Example Article</a></p>',
    });

    expect(editor.schema.marks.link).toBeUndefined();
    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'Example Article' }],
      }],
    });
    expect(serializeEditor(editor.getJSON()).text).toBe('Example Article');

    editor.destroy();
  });

  it('serializes file badges as readable text and attachment references', () => {
    const editor = new Editor({
      extensions: createInputEditorExtensions(''),
      content: {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Read ' },
            {
              type: 'fileBadge',
              attrs: {
                fileId: 'sf_readme',
                path: '/workspace/README.md',
                name: 'README.md',
                isDirectory: false,
                mimeType: 'text/markdown',
              },
            },
            { type: 'text', text: ' before editing.' },
          ],
        }],
      },
    });

    const serialized = serializeEditor(editor.getJSON());

    expect(serialized.text).toBe('Read @README.md before editing.');
    expect(serialized.fileRefs).toEqual([{
      fileId: 'sf_readme',
      path: '/workspace/README.md',
      name: 'README.md',
      isDirectory: false,
      mimeType: 'text/markdown',
    }]);

    editor.destroy();
  });
});
