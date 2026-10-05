import { describe, expect, it } from "vitest";

import {
  isBridgeOwner,
  resolveBridgeOwnerDeliveryTarget,
  resolveBridgeOwnerUserId,
} from "../lib/bridge/owner-policy.js";

describe("Bridge owner policy", () => {
  it("treats wechat DMs as owner only when the inferred owner is unique", () => {
    const agent = { config: { bridge: {} } };
    const index = {
      "wx_dm_wxid_a@agent-1": { file: "a.jsonl", userId: "wxid_a" },
    };

    expect(resolveBridgeOwnerUserId({ platform: "wechat", agent, index })).toBe("wxid_a");
    expect(isBridgeOwner({ platform: "wechat", chatType: "dm", userId: "wxid_a", agent })).toBe(true);
    expect(isBridgeOwner({ platform: "wechat", chatType: "group", userId: "wxid_a", agent })).toBe(false);
  });

  it("resolves feishu proactive delivery through the known DM chat id", () => {
    const agent = { config: { bridge: { feishu: { owner: "ou_owner" } } } };
    const index = {
      "fs_dm_ou_owner@agent-1": {
        file: "owner.jsonl",
        userId: "ou_owner",
        chatId: "oc_actual_chat",
      },
    };

    expect(resolveBridgeOwnerDeliveryTarget({ platform: "feishu", agent, index })).toEqual({
      userId: "ou_owner",
      chatId: "oc_actual_chat",
      sessionKey: "fs_dm_ou_owner@agent-1",
    });
  });
});
