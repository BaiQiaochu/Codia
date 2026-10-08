import { describe, expect, it } from "vitest";
import {
  createSessionStreamEventWsMessage,
  createStreamResumeWsMessage,
  validateClientWsMessage,
  wsParse,
  wsSendSerialized,
} from "../server/ws-protocol.js";

describe("ws protocol JSON parsing", () => {
  it("parses valid object messages", () => {
    expect(wsParse('{"type":"prompt","text":"hello"}')).toEqual({
      type: "prompt",
      text: "hello",
    });
  });

  it("rejects malformed or non-object JSON messages", () => {
    expect(wsParse("{bad json")).toBeNull();
    expect(wsParse("null")).toBeNull();
    expect(wsParse("1")).toBeNull();
    expect(wsParse('"text"')).toBeNull();
  });

  it("sends an already serialized payload without double encoding it", () => {
    const sent = [];
    const ws = {
      readyState: 1,
      send(payload) {
        sent.push(payload);
      },
    };

    wsSendSerialized(ws, '{"type":"status","isStreaming":true}');

    expect(sent).toEqual(['{"type":"status","isStreaming":true}']);
  });

  it("validates client messages before route handlers read payload fields", () => {
    expect(validateClientWsMessage({ type: "prompt", text: "hello" })).toMatchObject({
      ok: true,
      message: { type: "prompt", text: "hello" },
    });

    expect(validateClientWsMessage({ type: "", text: "hello" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/type.*non-empty string/),
    });

    expect(validateClientWsMessage({ type: "prompt", sessionPath: 123 })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/sessionPath.*non-empty string/),
    });

    expect(validateClientWsMessage({
      type: "resume_stream",
      sessionPath: "/sessions/a.jsonl",
      sinceSeq: -1,
    })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/sinceSeq.*non-negative integer/),
    });
  });

  it("wraps outbound session stream events with replay metadata", () => {
    expect(createSessionStreamEventWsMessage({
      sessionPath: "/sessions/a.jsonl",
      sessionEvent: { type: "text_delta", delta: "hello" },
      streamId: "stream_1",
      seq: 7,
    })).toEqual({
      type: "text_delta",
      delta: "hello",
      sessionPath: "/sessions/a.jsonl",
      streamId: "stream_1",
      seq: 7,
    });

    expect(() => createSessionStreamEventWsMessage({
      sessionPath: "/sessions/a.jsonl",
      sessionEvent: { type: "text_delta", sessionPath: "/other.jsonl" },
      streamId: "stream_1",
      seq: 7,
    })).toThrow(/conflicts/);
  });

  it("builds stream resume responses and validates replay events", () => {
    expect(createStreamResumeWsMessage({
      sessionPath: "/sessions/a.jsonl",
      streamId: "stream_1",
      sinceSeq: 4,
      nextSeq: 8,
      reset: false,
      truncated: false,
      isStreaming: true,
      runtimeIsStreaming: false,
      events: [{
        seq: 5,
        ts: 123,
        event: { type: "text_delta", delta: "hello" },
      }],
    })).toEqual({
      type: "stream_resume",
      sessionPath: "/sessions/a.jsonl",
      streamId: "stream_1",
      sinceSeq: 4,
      nextSeq: 8,
      reset: false,
      truncated: false,
      isStreaming: true,
      runtimeIsStreaming: false,
      events: [{
        seq: 5,
        ts: 123,
        event: { type: "text_delta", delta: "hello" },
      }],
    });

    expect(() => createStreamResumeWsMessage({
      sessionPath: "/sessions/a.jsonl",
      streamId: "stream_1",
      sinceSeq: 4,
      nextSeq: 8,
      reset: false,
      truncated: false,
      isStreaming: true,
      events: [{ seq: 5, event: { delta: "missing type" } }],
    })).toThrow(/events\[0\]\.event\.type.*non-empty string/);
  });
});
