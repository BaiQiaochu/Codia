const TOOL_PROTOCOL_TAGS = Object.freeze([
  "tool_calls",
  "tool_call",
  "function_calls",
  "function_call",
  "tool_use",
  "invoke",
  "parameter",
]);

const TOOL_PROTOCOL_TAG_SET = new Set(TOOL_PROTOCOL_TAGS);

const CHANNEL_MARKER_RE = /[<＜]\|[\s\S]*?\|[>＞]/g;
const TOOL_TAG_RE = /[<＜]\s*([/／]?)\s*([\p{L}\p{N}_.:：-]+)([^<＜>＞]*)[>＞]/gu;
const NORMALIZED_START_TAG_RE = /^<\s*(\/?)\s*([\p{L}\p{N}_.:-]+)([^<>]*)>/u;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

function normalizeForProtocolDetection(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "");
}

function normalizeTagName(rawName: unknown): string {
  const normalized = normalizeForProtocolDetection(rawName)
    .trim()
    .toLowerCase();
  const colon = normalized.lastIndexOf(":");
  return colon >= 0 ? normalized.slice(colon + 1) : normalized;
}

function isToolProtocolTagName(rawName: unknown): boolean {
  return TOOL_PROTOCOL_TAG_SET.has(normalizeTagName(rawName));
}

function attrsHaveName(rawAttrs: unknown): boolean {
  return /\bname\s*=/.test(normalizeForProtocolDetection(rawAttrs).toLowerCase());
}

interface ToolTag {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  attrs: string;
}

function parseToolTags(text: string): ToolTag[] {
  const tags: ToolTag[] = [];
  TOOL_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_TAG_RE.exec(text)) !== null) {
    const name = normalizeTagName(match[2]);
    if (!TOOL_PROTOCOL_TAG_SET.has(name)) continue;
    tags.push({
      start: match.index,
      end: match.index + match[0].length,
      name,
      closing: normalizeForProtocolDetection(match[1]) === "/",
      attrs: match[3] || "",
    });
  }
  return tags;
}

function startsWithToolProtocolTag(text: string): boolean {
  const normalized = normalizeForProtocolDetection(text).trimStart();
  return isToolProtocolTagName(NORMALIZED_START_TAG_RE.exec(normalized)?.[2]);
}

function isStructuralOpenTag(tag: ToolTag, source: string): boolean {
  if (attrsHaveName(tag.attrs)) return true;
  return startsWithToolProtocolTag(source.slice(tag.end));
}

function findMatchingClose(tags: ToolTag[], startIndex: number): ToolTag | null {
  const opener = tags[startIndex];
  let depth = 1;
  for (let i = startIndex + 1; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.name !== opener.name) continue;
    if (tag.closing) {
      depth -= 1;
      if (depth === 0) return tag;
    } else {
      depth += 1;
    }
  }
  return null;
}

function removeRanges(text: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (end <= cursor) continue;
    out += text.slice(cursor, Math.max(cursor, start));
    cursor = Math.max(cursor, end);
  }
  return out + text.slice(cursor);
}

export function stripToolProtocolTagsFromProse(value: unknown): string {
  let text = String(value ?? "");
  text = text.replace(CHANNEL_MARKER_RE, "");

  const tags = parseToolTags(text);
  const ranges: Array<[number, number]> = [];
  let coveredUntil = -1;

  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.start < coveredUntil) continue;

    if (tag.closing) {
      ranges.push([tag.start, tag.end]);
      coveredUntil = tag.end;
      continue;
    }

    const close = findMatchingClose(tags, i);
    if (close) {
      ranges.push([tag.start, close.end]);
      coveredUntil = close.end;
      continue;
    }

    if (isStructuralOpenTag(tag, text)) {
      ranges.push([tag.start, text.length]);
      coveredUntil = text.length;
      break;
    }

    ranges.push([tag.start, tag.end]);
    coveredUntil = tag.end;
  }

  return removeRanges(text, ranges);
}

export function isToolProtocolFragment(value: unknown): boolean {
  const normalized = normalizeForProtocolDetection(value).trimStart();
  if (!normalized) return false;
  if (/^<\|[\s\S]*?\|>/.test(normalized)) return true;

  const match = NORMALIZED_START_TAG_RE.exec(normalized);
  if (!match) return false;

  const [, closing, rawName, attrs] = match;
  if (!isToolProtocolTagName(rawName)) return false;
  if (closing === "/") return true;
  if (attrsHaveName(attrs)) return true;
  if (startsWithToolProtocolTag(normalized.slice(match[0].length))) return true;

  const stripped = stripToolProtocolTagsFromProse(normalized);
  return stripped.length < normalized.length && stripped.trim().length === 0;
}
