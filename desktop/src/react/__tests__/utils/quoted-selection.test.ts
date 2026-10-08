import { describe, expect, it } from 'vitest';
import { formatQuotedSelectionForPrompt } from '../../utils/quoted-selection';
import { parseUserAttachments } from '../../utils/message-parser';

describe('formatQuotedSelectionForPrompt', () => {
  it('includes source metadata and the selected original text in the model prompt', () => {
    const result = formatQuotedSelectionForPrompt({
      text: 'first line\nsecond line',
      sourceKind: 'preview',
      sourceTitle: 'note.md',
      sourceFilePath: '/notes/note.md',
      lineStart: 3,
      lineEnd: 4,
      charCount: 22,
    });

    expect(result).toBe([
      '[引用片段] note.md（第3-4行，共22字）路径: /notes/note.md',
      '[引用原文]',
      'first line\nsecond line',
      '[/引用原文]',
    ].join('\n'));
  });

  it('keeps the quoted original out of the visible restored user message', () => {
    const input = [
      'please explain this',
      '',
      '[引用片段] note.md（第3-4行，共22字）路径: /notes/note.md',
      '[引用原文]',
      'first line',
      'second line',
      '[/引用原文]',
    ].join('\n');

    const result = parseUserAttachments(input);

    expect(result.text).toBe('please explain this');
    expect(result.quotedText).toBe('first line\nsecond line');
  });
});
