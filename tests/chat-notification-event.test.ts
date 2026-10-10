// @ts-nocheck
import { describe, expect, it } from "vitest";

import { toNotificationWsMessage } from "../server/routes/chat.ts";

describe("chat route notification messages", () => {
  it("carries the triggering agentId through to the desktop client", () => {
    expect(toNotificationWsMessage({
      type: "notification",
      title: "提醒",
      body: "该喝水了",
      agentId: "codia",
    })).toEqual({
      type: "notification",
      title: "提醒",
      body: "该喝水了",
      agentId: "codia",
      desktopFocusPolicy: "always",
      sessionPath: null,
    });
  });

  it("normalizes a missing agentId to null instead of dropping the field", () => {
    expect(toNotificationWsMessage({
      type: "notification",
      title: "提醒",
      body: "正文",
    })).toEqual({
      type: "notification",
      title: "提醒",
      body: "正文",
      agentId: null,
      desktopFocusPolicy: "always",
      sessionPath: null,
    });
  });

  it("carries the desktop focus policy through to the desktop client", () => {
    expect(toNotificationWsMessage({
      type: "notification",
      title: "完成",
      body: "这一轮已经结束",
      agentId: "codia",
      desktopFocusPolicy: "when_unfocused",
    })).toEqual({
      type: "notification",
      title: "完成",
      body: "这一轮已经结束",
      agentId: "codia",
      desktopFocusPolicy: "when_unfocused",
      sessionPath: null,
    });
  });

  it("carries the completed sessionPath for session-aware desktop notification filtering", () => {
    expect(toNotificationWsMessage({
      type: "notification",
      title: "完成",
      body: "这一轮已经结束",
      agentId: "codia",
      desktopFocusPolicy: "when_session_unfocused",
      sessionPath: "/tmp/finished.jsonl",
    })).toEqual({
      type: "notification",
      title: "完成",
      body: "这一轮已经结束",
      agentId: "codia",
      desktopFocusPolicy: "when_session_unfocused",
      sessionPath: "/tmp/finished.jsonl",
    });
  });
});
