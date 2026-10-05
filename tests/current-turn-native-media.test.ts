// @ts-nocheck
import path from "path";
import { describe, expect, it } from "vitest";
import {
  createCurrentTurnNativeMediaStore,
} from "../core/current-turn-native-media.js";
import { stripHistoricalInlineMediaForReplay } from "../core/message-sanitizer.js";

const TEXT_BLOCK = (text) => ({ type: "text", text });
const AUDIO_BLOCK = { type: "audio", data: "UklGRg==", mimeType: "audio/wav" };

describe("current-turn native media store", () => {
  it("rehydrates current-turn attached audio after a tool replay strips inline bytes", () => {
    const sessionPath = path.join("/tmp", "gsap", "session.jsonl");
    const audioPath = path.join("/tmp", "gsap", "session-files", "voice.wav");
    const store = createCurrentTurnNativeMediaStore();
    const turn = store.begin(sessionPath, {
      audios: [AUDIO_BLOCK],
      audioAttachmentPaths: [audioPath],
    });

    const messagesWithInlineAudio = [
      { role: "user", content: [TEXT_BLOCK(`[attached_audio: ${audioPath}]\nwhat time is it`), AUDIO_BLOCK] },
      { role: "assistant", content: [TEXT_BLOCK("checking")], toolCalls: [{ id: "call_1", name: "current_status" }] },
      { role: "toolResult", toolCallId: "call_1", content: [TEXT_BLOCK("20:01")] },
    ];
    const replaySafe = stripHistoricalInlineMediaForReplay(messagesWithInlineAudio);

    expect(replaySafe.strippedAudios).toBe(1);

    const result = store.inject(sessionPath, replaySafe.messages);

    expect(result.changed).toBe(true);
    expect(result.messages[0].content).toEqual([
      TEXT_BLOCK(`[attached_audio: ${audioPath}]\nwhat time is it`),
      AUDIO_BLOCK,
    ]);
    expect(messagesWithInlineAudio[0].content).toEqual([
      TEXT_BLOCK(`[attached_audio: ${audioPath}]\nwhat time is it`),
      AUDIO_BLOCK,
    ]);

    store.end(turn);
    expect(store.inject(sessionPath, replaySafe.messages).changed).toBe(false);
  });

  it("does not duplicate audio blocks that are already present in the current replay", () => {
    const sessionPath = path.join("/tmp", "gsap", "session.jsonl");
    const audioPath = path.join("/tmp", "gsap", "session-files", "voice.wav");
    const store = createCurrentTurnNativeMediaStore();
    store.begin(sessionPath, {
      audios: [AUDIO_BLOCK],
      audioAttachmentPaths: [audioPath],
    });

    const messages = [
      { role: "user", content: [TEXT_BLOCK(`[attached_audio: ${audioPath}]`), AUDIO_BLOCK] },
    ];

    const result = store.inject(sessionPath, messages);

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("uses sessionId as the current-turn key when the session file moves", () => {
    const originalPath = path.join("/tmp", "gsap", "before.jsonl");
    const movedPath = path.join("/tmp", "gsap", "after.jsonl");
    const audioPath = path.join("/tmp", "gsap", "session-files", "voice.wav");
    const store = createCurrentTurnNativeMediaStore();
    const turn = store.begin({ sessionId: "sess_native_media", sessionPath: originalPath }, {
      audios: [AUDIO_BLOCK],
      audioAttachmentPaths: [audioPath],
    });

    const replay = [{ role: "user", content: [TEXT_BLOCK(`[attached_audio: ${audioPath}]`)] }];
    expect(store.inject({ sessionId: "sess_native_media", sessionPath: movedPath }, replay)).toMatchObject({
      changed: true,
      injectedAudios: 1,
    });

    store.end(turn);
    expect(store.inject({ sessionId: "sess_native_media", sessionPath: movedPath }, replay).changed).toBe(false);
  });

  it("clears active native media for one discarded session only", () => {
    const sessionA = path.join("/tmp", "gsap", "a.jsonl");
    const sessionB = path.join("/tmp", "gsap", "b.jsonl");
    const audioA = path.join("/tmp", "gsap", "session-files", "a.wav");
    const audioB = path.join("/tmp", "gsap", "session-files", "b.wav");
    const store = createCurrentTurnNativeMediaStore();
    store.begin(sessionA, { audios: [AUDIO_BLOCK], audioAttachmentPaths: [audioA] });
    store.begin(sessionB, { audios: [AUDIO_BLOCK], audioAttachmentPaths: [audioB] });

    expect(store.clearSession(sessionA)).toBe(true);

    const messagesA = [{ role: "user", content: [TEXT_BLOCK(`[attached_audio: ${audioA}]`)] }];
    const messagesB = [{ role: "user", content: [TEXT_BLOCK(`[attached_audio: ${audioB}]`)] }];
    expect(store.inject(sessionA, messagesA).changed).toBe(false);
    expect(store.inject(sessionB, messagesB).changed).toBe(true);
  });
});
