import {
  EditorView, ViewPlugin, Decoration, WidgetType,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { EditorState, Facet, RangeSetBuilder, StateField, type Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import katex from 'katex';
import { hrDecoration } from './widgets/hr';
import { handleCheckbox } from './widgets/checkbox';
import { handleBlockquote } from './widgets/blockquote';
import { handleCodeBlock } from './widgets/code-block';
import { addImageDecoration, addStandardMarkdownImageDecoration, handleImage } from './widgets/image';
import { handleLink } from './widgets/link';
import type { DecoRange } from './widgets/types';
import {
  parseObsidianImageEmbed,
  resolveMarkdownImageSrc,
  type MarkdownImageContext,
} from '../utils/markdown';

export type { DecoRange } from './widgets/types';
export type LivePreviewRange =
  | { kind: 'hide'; from: number; to: number }
  | { kind: 'mark'; from: number; to: number; text: string; color?: string }
  | { kind: 'inlineMath' | 'blockMath'; from: number; to: number; source: string };

interface LivePreviewOptions {
  includeBlockMath?: boolean;
}

export const markdownImageContextFacet = Facet.define<MarkdownImageContext, MarkdownImageContext>({
  combine(values) {
    return values[0] ?? {};
  },
});

export const hideMark = Decoration.replace({});
const centerLineDeco = Decoration.line({ class: 'cm-center-line' });
const markDeco = Decoration.mark({ class: 'cm-md-mark' });
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?$/;
const RGB_COLOR_RE = /^rgba?\(\s*(?:\d{1,3}\s*,\s*){2}\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i;
const BG_SPAN_RE = /<span\s+style=(["'])\s*background(?:-color)?\s*:\s*([^;"']+)\s*;?\s*\1>([\s\S]*?)<\/span>/ig;
const FENCE_RE = /^(?: {0,3})(`{3,}|~{3,})/;

export const CONCEAL_MARKS = new Set([
  'HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark',
  'LinkMark', 'URL', 'QuoteMark',
]);

export function collectActiveLines(view: EditorView): Set<number> {
  return collectActiveLinesFromState(view.state);
}

function collectActiveLinesFromState(state: EditorState): Set<number> {
  const active = new Set<number>();
  for (const range of state.selection.ranges) {
    const start = state.doc.lineAt(range.from).number;
    const end = state.doc.lineAt(range.to).number;
    for (let i = start; i <= end; i += 1) active.add(i);
  }
  return active;
}

function normalizeSafeBackgroundColor(raw: string): string | null {
  const color = raw.trim();
  if (HEX_COLOR_RE.test(color)) return color;
  if (RGB_COLOR_RE.test(color)) return color;
  return null;
}

type InlineRange = { from: number; to: number };

function rangeOverlaps(from: number, to: number, excluded: InlineRange[]): boolean {
  return excluded.some(range => from < range.to && to > range.from);
}

function findNextOutside(line: string, needle: string, from: number, excluded: InlineRange[]): number {
  let index = line.indexOf(needle, from);
  while (index >= 0) {
    if (!rangeOverlaps(index, index + needle.length, excluded)) return index;
    index = line.indexOf(needle, index + needle.length);
  }
  return -1;
}

function collectInlineCodeRanges(line: string): InlineRange[] {
  const ranges: InlineRange[] = [];
  let i = 0;
  while (i < line.length) {
    const start = line.indexOf('`', i);
    if (start < 0) return ranges;
    let tickCount = 1;
    while (line[start + tickCount] === '`') tickCount += 1;
    const fence = '`'.repeat(tickCount);
    const end = line.indexOf(fence, start + tickCount);
    if (end < 0) return ranges;
    ranges.push({ from: start, to: end + tickCount });
    i = end + tickCount;
  }
  return ranges;
}

function collectFenceLineNumbers(src: string): Set<number> {
  const fenced = new Set<number>();
  const lines = src.split('\n');
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const fence = line.match(FENCE_RE);
    if (!inFence && fence) {
      inFence = true;
      fenceChar = fence[1][0] as '`' | '~';
      fenced.add(idx + 1);
      continue;
    }
    if (inFence) {
      fenced.add(idx + 1);
      if (fence && fenceChar === fence[1][0]) {
        inFence = false;
        fenceChar = null;
      }
    }
  }

  return fenced;
}

function findInlineMath(line: string, lineOffset: number, ranges: LivePreviewRange[], excluded: InlineRange[]): void {
  let i = 0;
  while (i < line.length) {
    const start = findNextOutside(line, '$', i, excluded);
    if (start < 0) return;
    if (line[start + 1] === '$') {
      i = start + 2;
      continue;
    }
    const end = findNextOutside(line, '$', start + 1, excluded);
    if (end < 0) return;
    const source = line.slice(start + 1, end).trim();
    if (source) {
      ranges.push({
        kind: 'inlineMath',
        from: lineOffset + start,
        to: lineOffset + end + 1,
        source,
      });
    }
    i = end + 1;
  }
}

function findMarks(line: string, lineOffset: number, ranges: LivePreviewRange[], excluded: InlineRange[]): void {
  let i = 0;
  while (i < line.length) {
    const start = findNextOutside(line, '==', i, excluded);
    if (start < 0) return;
    const end = findNextOutside(line, '==', start + 2, excluded);
    if (end < 0) return;
    const text = line.slice(start + 2, end);
    if (text) {
      ranges.push({ kind: 'hide', from: lineOffset + start, to: lineOffset + start + 2 });
      ranges.push({ kind: 'mark', from: lineOffset + start + 2, to: lineOffset + end, text });
      ranges.push({ kind: 'hide', from: lineOffset + end, to: lineOffset + end + 2 });
    }
    i = end + 2;
  }
}

function findBackgroundSpans(line: string, lineOffset: number, ranges: LivePreviewRange[], excluded: InlineRange[]): void {
  BG_SPAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BG_SPAN_RE.exec(line)) !== null) {
    if (rangeOverlaps(match.index, match.index + match[0].length, excluded)) continue;
    const color = normalizeSafeBackgroundColor(match[2]);
    if (!color) continue;
    const openEnd = match.index + match[0].indexOf('>') + 1;
    const closeStart = match.index + match[0].length - '</span>'.length;
    const text = match[3];
    ranges.push({ kind: 'hide', from: lineOffset + match.index, to: lineOffset + openEnd });
    ranges.push({ kind: 'mark', from: lineOffset + openEnd, to: lineOffset + closeStart, text, color });
    ranges.push({ kind: 'hide', from: lineOffset + closeStart, to: lineOffset + match.index + match[0].length });
  }
}

export function collectLivePreviewRanges(
  src: string,
  activeLines: Set<number>,
  options: LivePreviewOptions = {},
): LivePreviewRange[] {
  const includeBlockMath = options.includeBlockMath ?? true;
  const lines = src.split('\n');
  const ranges: LivePreviewRange[] = [];
  let offset = 0;
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNo = idx + 1;
    const line = lines[idx];
    const fence = line.match(FENCE_RE);
    if (fence) {
      const markerChar = fence[1][0] as '`' | '~';
      if (!inFence) {
        inFence = true;
        fenceChar = markerChar;
      } else if (fenceChar === markerChar) {
        inFence = false;
        fenceChar = null;
      }
      offset += line.length + 1;
      continue;
    }

    if (activeLines.has(lineNo) || inFence) {
      offset += line.length + 1;
      continue;
    }

    if (line.trim() === '$$') {
      let endIdx = idx + 1;
      while (endIdx < lines.length && lines[endIdx].trim() !== '$$') endIdx += 1;
      if (endIdx < lines.length) {
        let blockHasActiveLine = false;
        for (let n = lineNo; n <= endIdx + 1; n += 1) {
          if (activeLines.has(n)) blockHasActiveLine = true;
        }
        if (!blockHasActiveLine) {
          const source = lines.slice(idx + 1, endIdx).join('\n').trim();
          const blockTo = offset + lines.slice(idx, endIdx + 1).join('\n').length;
          if (source && includeBlockMath) ranges.push({ kind: 'blockMath', from: offset, to: blockTo, source });
          for (; idx < endIdx; idx += 1) offset += lines[idx].length + 1;
          offset += lines[idx].length + 1;
          continue;
        }
      }
    }

    const inlineCodeRanges = collectInlineCodeRanges(line);
    findInlineMath(line, offset, ranges, inlineCodeRanges);
    findMarks(line, offset, ranges, inlineCodeRanges);
    findBackgroundSpans(line, offset, ranges, inlineCodeRanges);
    offset += line.length + 1;
  }
  return ranges;
}

class MathWidget extends WidgetType {
  constructor(private source: string, private displayMode: boolean, private revealFrom: number | null = null) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {

    const el = document.createElement(this.displayMode ? 'div' : 'span');
    el.className = this.displayMode ? 'cm-math-widget cm-math-block-widget' : 'cm-math-widget';
    if (this.displayMode && this.revealFrom !== null) {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', 'Edit LaTeX block');
      const revealSource = () => {
        view.focus();
        view.dispatch({
          selection: { anchor: this.revealFrom ?? 0 },
          scrollIntoView: true,
        });
      };
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        revealSource();
      });
      el.addEventListener('keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        revealSource();
      });
    }
    try {
      el.innerHTML = katex.renderToString(this.source, {
        displayMode: this.displayMode,
        throwOnError: false,
      });
    } catch {
      el.textContent = this.source;
    }
    return el;
  }
}

function livePreviewDeco(range: LivePreviewRange): DecoRange {
  if (range.kind === 'hide') return { from: range.from, to: range.to, deco: hideMark };
  if (range.kind === 'mark') {
    const deco = range.color
      ? Decoration.mark({
          class: 'cm-md-mark',
          attributes: { style: `--cm-md-mark-bg: ${range.color}` },
        })
      : markDeco;
    return { from: range.from, to: range.to, deco };
  }
  return {
    from: range.from,
    to: range.to,
    deco: Decoration.replace({
      widget: new MathWidget(
        range.source,
        range.kind === 'blockMath',
        range.kind === 'blockMath' ? range.from : null,
      ),
      block: range.kind === 'blockMath',
    }),
  };
}

function buildMarkdownBlockDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const activeLines = collectActiveLinesFromState(state);
  const ranges: DecoRange[] = collectLivePreviewRanges(state.doc.toString(), activeLines)
    .filter((range): range is Extract<LivePreviewRange, { kind: 'blockMath' }> => range.kind === 'blockMath')
    .map(livePreviewDeco);

  ranges.push(...collectActiveImageBlockDecorations(state, activeLines));
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const { from, to, deco } of ranges) builder.add(from, to, deco);

  return builder.finish();
}

export const markdownBlockDecoField = StateField.define<DecorationSet>({
  create(state) {
    return buildMarkdownBlockDecorations(state);
  },
  update(value, tr: Transaction) {
    if (tr.docChanged || tr.selection) return buildMarkdownBlockDecorations(tr.state);
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

export function buildMarkdownDecorations(view: EditorView): DecorationSet {
  const activeLines = collectActiveLines(view);
  const ranges: DecoRange[] = [];
  const imageContext = view.state.facet(markdownImageContextFacet);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter(node) {
        const line = view.state.doc.lineAt(node.from);
        const isActive = activeLines.has(line.number);

        switch (node.name) {
          case 'ATXHeading1':
            ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
            return;
          case 'HorizontalRule':
            if (!isActive) {
              ranges.push({ from: node.from, to: node.to, deco: hrDecoration });
              ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
            }
            return;
          case 'TaskMarker':
            handleCheckbox({ view, node, ranges });
            return;
          case 'Blockquote':
            handleBlockquote({ view, node, ranges });
            return;
          case 'FencedCode':
            handleCodeBlock({ view, node, activeLines, ranges });
            return false;
        }

        if (node.name === 'Image') {
          handleImage({ view, node, activeLines, ranges, imageContext });
          return;
        }

        if (isActive) return;

        switch (node.name) {
          case 'Link':
            handleLink({ view, node, activeLines, ranges });
            break;
          case 'HeaderMark':
          case 'EmphasisMark':
          case 'CodeMark':
          case 'StrikethroughMark':
          case 'LinkMark':
          case 'URL':
          case 'QuoteMark': {
            let hideTo = node.to;
            if (node.name === 'HeaderMark') {
              const next = view.state.doc.sliceString(hideTo, hideTo + 1);
              if (next === ' ') hideTo += 1;
            }
            ranges.push({ from: node.from, to: hideTo, deco: hideMark });
            break;
          }
        }
      },
    });
  }

  collectObsidianImageDecorations(view, activeLines, imageContext, ranges);

  for (const range of collectLivePreviewRanges(view.state.doc.toString(), activeLines, { includeBlockMath: false })) {
    ranges.push(livePreviewDeco(range));
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

function collectActiveImageBlockDecorations(
  state: EditorState,
  activeLines: Set<number>,
): DecoRange[] {
  const ranges: DecoRange[] = [];
  const imageContext = state.facet(markdownImageContextFacet);
  const fencedLines = collectFenceLineNumbers(state.doc.toString());

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Image') return;
      const line = state.doc.lineAt(node.from);
      if (!activeLines.has(line.number)) return;
      if (fencedLines.has(line.number)) return;
      if (state.doc.lineAt(node.to).number !== line.number) return;

      addStandardMarkdownImageDecoration({
        source: state.doc.sliceString(node.from, node.to),
        ranges,
        from: node.from,
        to: node.to,
        lineTo: line.to,
        imageContext,
        placement: 'below-source-line',
      });
    },
  });

  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    if (!activeLines.has(lineNo) || fencedLines.has(lineNo)) continue;
    const line = state.doc.line(lineNo);
    collectObsidianImagesInLine(line.text, line.from, imageContext, ranges, true);
  }

  return ranges.sort((a, b) => a.from - b.from || a.to - b.to);
}

function collectObsidianImageDecorations(
  view: EditorView,
  activeLines: Set<number>,
  imageContext: MarkdownImageContext,
  ranges: DecoRange[],
): void {
  const fencedLines = collectFenceLineNumbers(view.state.doc.toString());

  for (const { from, to } of view.visibleRanges) {
    let line = view.state.doc.lineAt(from);
    while (line.from <= to) {
      if (!activeLines.has(line.number) && !fencedLines.has(line.number)) {
        collectObsidianImagesInLine(
          line.text,
          line.from,
          imageContext,
          ranges,
          false,
        );
      }
      if (line.to >= view.state.doc.length) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
}

function collectObsidianImagesInLine(
  line: string,
  lineOffset: number,
  imageContext: MarkdownImageContext,
  ranges: DecoRange[],
  isActiveLine: boolean,
): void {
  const inlineCodeRanges = collectInlineCodeRanges(line);
  let from = 0;

  while (from < line.length) {
    const start = findNextOutside(line, '![[', from, inlineCodeRanges);
    if (start < 0) return;
    const close = findNextOutside(line, ']]', start + 3, inlineCodeRanges);
    if (close < 0) return;

    const parsed = parseObsidianImageEmbed(line.slice(start + 3, close));
    if (parsed) {
      const src = resolveMarkdownImageSrc(parsed.src, imageContext);
      addImageDecoration({
        ranges,
        from: lineOffset + start,
        to: lineOffset + close + 2,
        lineTo: lineOffset + line.length,
        url: src,
        alt: parsed.alt,
        dimensions: parsed.dimensions,
        placement: isActiveLine ? 'below-source-line' : 'replace-source',
      });
    }

    from = close + 2;
  }
}

export const markdownDecoPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged
          || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = buildMarkdownDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
