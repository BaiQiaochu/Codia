import { EditorSelection, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

function wrapSelection(view: EditorView, marker: string): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);

  if (selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: EditorSelection.single(from, from + inner.length),
      annotations: Transaction.userEvent.of('input'),
    });
    view.focus();
    return;
  }

  const before = state.sliceDoc(Math.max(0, from - marker.length), from);
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + marker.length));
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: from - marker.length, to: from, insert: '' },
        { from: to, to: to + marker.length, insert: '' },
      ],
      selection: EditorSelection.single(from - marker.length, to - marker.length),
      annotations: Transaction.userEvent.of('input'),
    });
    view.focus();
    return;
  }

  view.dispatch({
    changes: { from, to, insert: `${marker}${selected}${marker}` },
    selection: selected
      ? EditorSelection.single(from + marker.length, from + marker.length + selected.length)
      : EditorSelection.cursor(from + marker.length),
    annotations: Transaction.userEvent.of('input'),
  });
  view.focus();
}

function toggleLinePrefix(view: EditorView, prefix: string, exclusive: string[] = []): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let firstLineShift = 0;

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const text = line.text;
    if (text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
      if (lineNumber === startLine.number) firstLineShift = -prefix.length;
      continue;
    }

    const exclusivePrefix = exclusive.find(item => text.startsWith(item));
    if (exclusivePrefix) {
      changes.push({ from: line.from, to: line.from + exclusivePrefix.length, insert: prefix });
      if (lineNumber === startLine.number) firstLineShift = prefix.length - exclusivePrefix.length;
    } else {
      changes.push({ from: line.from, to: line.from, insert: prefix });
      if (lineNumber === startLine.number) firstLineShift = prefix.length;
    }
  }

  view.dispatch({
    changes,
    selection: EditorSelection.cursor(Math.max(0, from + firstLineShift)),
    annotations: Transaction.userEvent.of('input'),
  });
  view.focus();
}

function insertBlockAtCursor(view: EditorView, block: string): void {
  const { state } = view;
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const insertFrom = line.text.trim() ? line.to : line.from;
  const insert = line.text.trim() ? `\n${block}\n` : `${block}\n`;
  view.dispatch({
    changes: { from: insertFrom, to: insertFrom, insert },
    selection: EditorSelection.cursor(insertFrom + insert.length),
    annotations: Transaction.userEvent.of('input'),
  });
  view.focus();
}

export function toggleBold(view: EditorView): void {
  wrapSelection(view, '**');
}

export function toggleItalic(view: EditorView): void {
  wrapSelection(view, '*');
}

export function toggleStrikethrough(view: EditorView): void {
  wrapSelection(view, '~~');
}

export function toggleInlineCode(view: EditorView): void {
  wrapSelection(view, '`');
}

export function setHeading(view: EditorView, level: 1 | 2 | 3): void {
  toggleLinePrefix(view, `${'#'.repeat(level)} `, ['# ', '## ', '### ']);
}

export function toggleBlockquote(view: EditorView): void {
  toggleLinePrefix(view, '> ');
}

export function insertCodeBlock(view: EditorView): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);
  if (selected) {
    const wrapped = `\`\`\`\n${selected}\n\`\`\``;
    view.dispatch({
      changes: { from, to, insert: wrapped },
      selection: EditorSelection.cursor(from + wrapped.length),
      annotations: Transaction.userEvent.of('input'),
    });
    view.focus();
    return;
  }
  insertBlockAtCursor(view, '```\n\n```');
  const cursor = view.state.selection.main.from;
  view.dispatch({ selection: EditorSelection.cursor(Math.max(0, cursor - 4)) });
  view.focus();
}

export function insertHorizontalRule(view: EditorView): void {
  insertBlockAtCursor(view, '---');
}

export function toggleList(view: EditorView): void {
  toggleLinePrefix(view, '- ');
}
