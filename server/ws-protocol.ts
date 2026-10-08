/**
 * Shared WebSocket JSON helpers.
 *
 * Client -> server messages include prompt, abort, and resume_stream.
 * Server -> client messages include stream deltas, tool events, status,
 * resource cards, bridge status, and stream_resume payloads.
 */

export function wsSend(ws, msg) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

export function wsSendSerialized(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(payload);
  }
}

export function wsParse(data) {
  try {
    const str = typeof data === "string" ? data : (data?.toString?.() ?? String(data));
    const parsed = JSON.parse(str);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function validateClientWsMessage(message) {
  const context = "Invalid WebSocket client message";
  try {
    const msg = assertObject(message, "message", context);
    assertNonEmptyString(msg.type, "type", context);
    assertOptionalNonEmptyString(msg.sessionPath, "sessionPath", context);
    assertOptionalNonEmptyString(msg.path, "path", context);
    assertOptionalNonEmptyString(msg.sessionId, "sessionId", context);
    assertOptionalNonEmptyString(msg.agentId, "agentId", context);

    if (Object.prototype.hasOwnProperty.call(msg, "streamId")) {
      assertNullableNonEmptyString(msg.streamId, "streamId", context);
    }
    if (Object.prototype.hasOwnProperty.call(msg, "sinceSeq")) {
      assertNonNegativeInteger(msg.sinceSeq, "sinceSeq", context);
    }
    if (Object.prototype.hasOwnProperty.call(msg, "offset")) {
      assertNonNegativeInteger(msg.offset, "offset", context);
    }
    if (Object.prototype.hasOwnProperty.call(msg, "eventId")) {
      assertNullableNonEmptyString(msg.eventId, "eventId", context);
    }
    if (Object.prototype.hasOwnProperty.call(msg, "text") && msg.text !== null && typeof msg.text !== "string") {
      throw new TypeError(`${context}: text must be a string when provided`);
    }
    if (msg.type === 'prompt' && msg.displayMessage) {
      const display = assertObject(msg.displayMessage, 'displayMessage', context);
      for (const [field, idField, max] of [['agentMentions', 'agentId', 1], ['sessionRefs', 'sessionId', 8]] as const) {
        if (display[field] === undefined) continue;
        if (!Array.isArray(display[field]) || display[field].length > max) throw new TypeError(`${field}: 最多 ${max} 项`);
        for (const item of display[field]) {
          assertObject(item, field, context);
          const id = assertNonEmptyString(item[idField], idField, context);
          if (id.length > 160 || (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 500))) throw new TypeError(`${field}: 引用无效`);
        }
      }
      if (display.agentMentions?.length && (typeof display.clientMessageId !== 'string' || !display.clientMessageId || display.clientMessageId.length > 160)) throw new TypeError('审阅请求标识无效');
      if (display.quickAction !== undefined && !['ideas', 'code', 'workflow', 'agents'].includes(display.quickAction)) throw new TypeError('快捷任务无效');
    }
    return { ok: true, message: msg };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function createSessionStreamEventWsMessage(input) {
  const context = "Invalid WebSocket session stream event";
  const payload = assertObject(input, "input", context);
  const sessionPath = assertNonEmptyString(payload.sessionPath, "sessionPath", context);
  const sessionEvent = assertSessionEventPayload(payload.sessionEvent, "sessionEvent", context);
  const streamId = assertNonEmptyString(payload.streamId, "streamId", context);
  const seq = assertPositiveInteger(payload.seq, "seq", context);

  assertCompatibleField(sessionEvent, "sessionPath", sessionPath, context);
  assertCompatibleField(sessionEvent, "streamId", streamId, context);
  assertCompatibleField(sessionEvent, "seq", seq, context);

  return {
    ...sessionEvent,
    sessionPath,
    streamId,
    seq,
  };
}

export function createStreamResumeWsMessage(input) {
  const context = "Invalid WebSocket stream_resume message";
  const payload = assertObject(input, "input", context);
  const sessionPath = assertNonEmptyString(payload.sessionPath, "sessionPath", context);
  const streamId = assertNullableNonEmptyString(payload.streamId, "streamId", context);
  const sinceSeq = assertNonNegativeInteger(payload.sinceSeq, "sinceSeq", context);
  const nextSeq = assertPositiveInteger(payload.nextSeq, "nextSeq", context);
  const reset = assertBoolean(payload.reset, "reset", context);
  const truncated = assertBoolean(payload.truncated, "truncated", context);
  const isStreaming = assertBoolean(payload.isStreaming, "isStreaming", context);
  const events = assertReplayEvents(payload.events, context);

  const message: Record<string, unknown> = {
    type: "stream_resume",
    sessionPath,
    streamId,
    sinceSeq,
    nextSeq,
    reset,
    truncated,
    isStreaming,
    events,
  };

  if (Object.prototype.hasOwnProperty.call(payload, "runtimeIsStreaming")) {
    message.runtimeIsStreaming = assertBoolean(payload.runtimeIsStreaming, "runtimeIsStreaming", context);
  }

  return message;
}

function assertReplayEvents(events, context) {
  if (!Array.isArray(events)) {
    throw new TypeError(`${context}: events must be an array`);
  }
  for (let index = 0; index < events.length; index += 1) {
    const entry = assertObject(events[index], `events[${index}]`, context);
    assertPositiveInteger(entry.seq, `events[${index}].seq`, context);
    if (Object.prototype.hasOwnProperty.call(entry, "ts") && !Number.isFinite(entry.ts)) {
      throw new TypeError(`${context}: events[${index}].ts must be a finite number`);
    }
    assertSessionEventPayload(entry.event, `events[${index}].event`, context);
  }
  return events;
}

function assertSessionEventPayload(value, field, context) {
  const event = assertObject(value, field, context);
  assertNonEmptyString(event.type, `${field}.type`, context);
  return event;
}

function assertCompatibleField(value, field, expected, context) {
  if (!Object.prototype.hasOwnProperty.call(value, field)) return;
  const actual = value[field];
  if (actual === undefined || actual === null) return;
  if (actual !== expected) {
    throw new TypeError(`${context}: sessionEvent.${field} conflicts with top-level ${field}`);
  }
}

function assertObject(value, field, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context}: ${field} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, field, context) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${context}: ${field} must be a non-empty string`);
  }
  return value;
}

function assertOptionalNonEmptyString(value, field, context) {
  if (value === undefined || value === null) return value;
  return assertNonEmptyString(value, field, context);
}

function assertNullableNonEmptyString(value, field, context) {
  if (value === null) return null;
  return assertNonEmptyString(value, field, context);
}

function assertPositiveInteger(value, field, context) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${context}: ${field} must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInteger(value, field, context) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${context}: ${field} must be a non-negative integer`);
  }
  return value;
}

function assertBoolean(value, field, context) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${context}: ${field} must be a boolean`);
  }
  return value;
}
