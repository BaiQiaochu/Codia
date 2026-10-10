import { describe, expect, it } from "vitest";
import {
  buildBridgeContext,
  buildBridgePromptLine,
  normalizeBridgePlatforms,
} from "../lib/bridge/bridge-context.js";

describe("bridge context", () => {
  it("formats a low-salience English platform line", () => {
    const context = buildBridgeContext({
      sessionKey: "fs_dm_owner@codia",
      role: "owner",
    }, "en");

    const line = buildBridgePromptLine(context, "en");
    expect(line).toContain(
      'The user is currently talking with you through Feishu; use this only when interpreting the current platform or references like "here."',
    );
    expect(line).toContain("text-only");
    expect(line).toContain("/apply");
  });

  it("builds detailed bridge state without turning guest chats into owner notification targets", () => {
    const ownerContext = buildBridgeContext({
      sessionKey: "fs_dm_open-id@codia",
      role: "owner",
      userId: "owner-user",
      chatId: "oc_chat",
      agentId: "codia",
    }, "en");

    expect(ownerContext).toMatchObject({
      isBridgeSession: true,
      platform: "feishu",
      platformLabel: "Feishu",
      chatType: "dm",
      role: "owner",
      sessionKey: "fs_dm_open-id@codia",
      agentId: "codia",
      userId: "owner-user",
      chatId: "oc_chat",
      interactionCapabilities: {
        platform: "feishu",
        confirmationMode: "text_command",
      },
      notificationHint: {
        channels: ["bridge_owner"],
        bridgePlatforms: ["feishu"],
        contextPolicy: "record_when_delivered",
      },
    });

    const guestContext = buildBridgeContext({
      sessionKey: "tg_group_g1@codia",
      role: "guest",
      userId: "guest-user",
      chatId: "g1",
      agentId: "codia",
    }, "en");

    expect(guestContext).toMatchObject({
      platform: "telegram",
      chatType: "group",
      role: "guest",
      notificationHint: null,
    });
  });

  it("normalizes allowed bridge platform preferences", () => {
    expect(normalizeBridgePlatforms(["feishu", "sms", "dingtalk", "feishu", "qq"])).toEqual({
      bridgePlatforms: ["feishu", "dingtalk", "qq"],
      invalidBridgePlatforms: ["sms"],
    });
  });

  it("builds Wukong context without requiring a native bridge adapter", () => {
    const context = buildBridgeContext({
      platform: "wukong",
      sessionKey: "wk_conv_conv-99@codia",
      chatType: "dm",
      role: "owner",
      userId: "manager-001",
      chatId: "conv-99",
      agentId: "codia",
    }, "zh");

    expect(context).toMatchObject({
      isBridgeSession: true,
      platform: "wukong",
      platformLabel: "悟空",
      interactionCapabilities: {
        platform: "wukong",
        confirmationMode: "text_command",
      },
    });
    expect(buildBridgePromptLine(context, "zh")).toContain("悟空");
  });
});
