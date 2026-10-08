// @ts-nocheck
import { findCutPoint, estimateTokens } from "../lib/pi-sdk/index.ts";

type PathEntry = {
  id?: string;
  type?: string;
  message?: unknown;
};

type HardTruncationOptions = {
  summary?: string;
  reason?: string;
};

type CompactionPreparation = {
  messagesToSummarize?: unknown[];
  isSplitTurn?: boolean;
  turnPrefixMessages?: unknown[];
};

export function computeHardTruncation(pathEntries: PathEntry[], keepRecentTokens: number, options: HardTruncationOptions = {}) {
  const {
    summary = "[Earlier conversation history was truncated because the context was too long]",
    reason = "hard-truncation",
  } = options;

  const messageEntries = pathEntries.filter((e) => e.type === "message");
  if (messageEntries.length < 2) return null;

  const cutResult = findCutPoint(pathEntries, 0, pathEntries.length, keepRecentTokens);
  const { firstKeptEntryIndex, turnStartIndex, isSplitTurn } = cutResult;
  const effectiveCutIndex = isSplitTurn ? turnStartIndex : firstKeptEntryIndex;
  if (effectiveCutIndex <= 0) return null;

  let tokensBefore = 0;
  for (let i = 0; i < effectiveCutIndex; i++) {
    if (pathEntries[i].type === "message" && pathEntries[i].message) {
      tokensBefore += estimateTokens(pathEntries[i].message);
    }
  }

  return {
    summary,
    firstKeptEntryId: pathEntries[effectiveCutIndex].id,
    tokensBefore,
    details: { reason, keepRecentTokens },
  };
}

export function estimateMessagesTokens(messages: unknown[]) {
  let sum = 0;
  for (const m of messages) sum += estimateTokens(m);
  return sum;
}

export function estimatePreparationTokens(preparation: CompactionPreparation | null | undefined) {
  if (!preparation) return 0;
  const historyTokens = preparation.messagesToSummarize
    ? estimateMessagesTokens(preparation.messagesToSummarize)
    : 0;
  const turnPrefixTokens = preparation.isSplitTurn && preparation.turnPrefixMessages
    ? estimateMessagesTokens(preparation.turnPrefixMessages)
    : 0;
  return Math.max(historyTokens, turnPrefixTokens);
}

export function truncateTextHeadTail(text: string, opts: { maxBytes: number; headBytes?: number; tailBytes?: number }) {
  const { maxBytes } = opts;
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }

  const headBytes = opts.headBytes ?? Math.floor(maxBytes * 0.4);
  const tailBytes = opts.tailBytes ?? Math.floor(maxBytes * 0.4);
  const buf = Buffer.from(text, "utf8");
  const head = safeSliceUtf8(buf, 0, headBytes);
  const tail = safeSliceUtf8(buf, buf.length - tailBytes, buf.length);
  const omittedBytes = originalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  const marker = `\n\n[... ${formatBytes(omittedBytes)} omitted (original ${formatBytes(originalBytes)}) ...]\n\n`;

  return {
    text: head + marker + tail,
    truncated: true,
    originalBytes,
  };
}

function safeSliceUtf8(buf: Buffer, start: number, end: number) {
  let s = Math.max(0, start);
  let e = Math.min(buf.length, end);
  while (s < buf.length && (buf[s] & 0xc0) === 0x80) s++;
  while (e < buf.length && (buf[e] & 0xc0) === 0x80) e++;
  return buf.slice(s, e).toString("utf8");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
