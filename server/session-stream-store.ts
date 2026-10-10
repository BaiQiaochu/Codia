// @ts-nocheck
/**
 * session-stream-store.js
 *
  * */

const DEFAULT_MAX_EVENTS = 5000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
const MAX_COMPACT_STRING_CHARS = 8192;
const MAX_COMPACT_ARRAY_ITEMS = 64;
const MAX_COMPACT_OBJECT_KEYS = 64;
const LARGE_FIELD_KEYS = new Set([
  "base64",
  "content",
  "data",
  "details",
  "snapshot",
  "text",
  "thumbnail",
]);

/** 创建初始流状-*/
export function createSessionStreamState(opts = {}) {
  return {
    streamId: null,
    nextSeq: 1,
    isStreaming: false,
    startedAt: 0,
    endedAt: 0,
    events: [],
    maxEvents: Math.max(1, opts.maxEvents || DEFAULT_MAX_EVENTS),
    maxBytes: Math.max(1024, opts.maxBytes || DEFAULT_MAX_BYTES),
    maxEventBytes: Math.max(1024, opts.maxEventBytes || DEFAULT_MAX_EVENT_BYTES),
    totalEventBytes: 0,
    droppedEvents: 0,
    droppedBytes: 0,
    compactedEvents: 0,
  };
}

/** */
export function beginSessionStream(state, streamId = null) {
  state.streamId = streamId || createStreamId();
  state.nextSeq = 1;
  state.isStreaming = true;
  state.startedAt = Date.now();
  state.endedAt = 0;
  state.events = [];
  state.totalEventBytes = 0;
  state.droppedEvents = 0;
  state.droppedBytes = 0;
  state.compactedEvents = 0;
  return state.streamId;
}

/** */
export function appendSessionStreamEvent(state, event) {
  if (!state.streamId) beginSessionStream(state);

  const prepared = prepareStoredEvent(event, state.maxEventBytes);
  if (prepared.compacted) state.compactedEvents += 1;

  const entry = {
    streamId: state.streamId,
    seq: state.nextSeq++,
    event: prepared.event,
    ts: Date.now(),
    byteLength: prepared.byteLength,
  };

  state.events.push(entry);
  state.totalEventBytes += entry.byteLength;
  trimEvents(state);
  return entry;
}

/** */
export function finishSessionStream(state) {
  state.isStreaming = false;
  state.endedAt = Date.now();
  state.events = [];
  state.totalEventBytes = 0;
}

/**
  *
 */
export function resumeSessionStream(state, opts = {}) {
  const requestedStreamId = opts.streamId ?? state.streamId ?? null;
  const currentStreamId = state.streamId ?? null;
  const requestedSinceSeq = normalizeSeq(opts.sinceSeq);

  if (!currentStreamId) {
    return {
      streamId: null,
      sinceSeq: requestedSinceSeq,
      nextSeq: 1,
      isStreaming: false,
      reset: false,
      truncated: false,
      events: [],
    };
  }

 // 请求的是 stream，说明客户端需要丢弃本地状态并用当前流重建
  if (requestedStreamId && requestedStreamId !== currentStreamId) {
    return {
      streamId: currentStreamId,
      sinceSeq: 0,
      nextSeq: state.nextSeq,
      isStreaming: state.isStreaming,
      reset: true,
      truncated: false,
      events: state.events.map(toPublicEvent),
    };
  }

  const firstSeq = state.events[0]?.seq || state.nextSeq;
  const minSinceSeq = Math.max(0, firstSeq - 1);
  const truncated = requestedSinceSeq < minSinceSeq;
  const effectiveSinceSeq = truncated ? minSinceSeq : requestedSinceSeq;

  return {
    streamId: currentStreamId,
    sinceSeq: effectiveSinceSeq,
    nextSeq: state.nextSeq,
    isStreaming: state.isStreaming,
    reset: false,
    truncated,
    events: state.events
      .filter(entry => entry.seq > effectiveSinceSeq)
      .map(toPublicEvent),
  };
}

function trimEvents(state) {
  while (state.events.length > state.maxEvents || state.totalEventBytes > state.maxBytes) {
    const [removed] = state.events.splice(0, 1);
    if (!removed) break;
    state.totalEventBytes = Math.max(0, state.totalEventBytes - (removed.byteLength || 0));
    state.droppedEvents += 1;
    state.droppedBytes += removed.byteLength || 0;
  }
}

function toPublicEvent(entry) {
  return {
    seq: entry.seq,
    event: entry.event,
    ts: entry.ts,
  };
}

function prepareStoredEvent(event, maxEventBytes) {
  const initialBytes = jsonByteLength(event);
  if (initialBytes <= maxEventBytes) {
    return { event, byteLength: initialBytes, compacted: false };
  }

  const compacted = compactValue(event, new Set());
  const compactedBytes = jsonByteLength(compacted);
  if (compactedBytes <= maxEventBytes) {
    const marked = markCompactedEvent(compacted, initialBytes);
    return {
      event: marked,
      byteLength: jsonByteLength(marked),
      compacted: true,
    };
  }

  const fallback = {
    type: event?.type || "stream_event",
    compacted: true,
    omitted: true,
    originalByteLength: initialBytes,
  };
  return {
    event: fallback,
    byteLength: jsonByteLength(fallback),
    compacted: true,
  };
}

function markCompactedEvent(event, originalByteLength) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return {
      type: "stream_event",
      compacted: true,
      originalByteLength,
      value: event,
    };
  }
  return {
    ...event,
    compacted: true,
    originalByteLength,
  };
}

function compactValue(value, seen) {
  if (typeof value === "string") {
    if (value.length <= MAX_COMPACT_STRING_CHARS) return value;
    return `[omitted ${value.length} chars]`;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_COMPACT_ARRAY_ITEMS)
      .map((item) => compactValue(item, seen));
  }
  const out = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= MAX_COMPACT_OBJECT_KEYS) {
      out._omittedKeys = Object.keys(value).length - count;
      break;
    }
    count += 1;
    if (LARGE_FIELD_KEYS.has(key) && typeof item === "string" && item.length > 256) {
      out[key] = `[omitted ${item.length} chars]`;
      continue;
    }
    out[key] = compactValue(item, seen);
  }
  seen.delete(value);
  return out;
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

function normalizeSeq(value) {
  const n = Number.isFinite(value) ? value : 0;
  return n < 0 ? 0 : Math.floor(n);
}

function createStreamId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
