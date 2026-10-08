import { describe, expect, it } from "vitest";

import {
  DINGTALK_ACCESS_TOKEN_URL,
  DINGTALK_BOT_CALLBACK_TOPIC,
  DINGTALK_DM_SEND_URL,
  DINGTALK_GROUP_SEND_URL,
  DINGTALK_REST_API_BASE_URL,
  DINGTALK_STREAM_API_BASE_URL,
  DINGTALK_STREAM_OPEN_URL,
  assertNoUnsupportedDingTalkRobotFields,
  buildDingTalkUrl,
  normalizeDingTalkBaseUrl,
  normalizeDingTalkBridgeCredentials,
  normalizeDingTalkEndpointUrl,
} from "../lib/bridge/dingtalk-contract.ts";

describe("DingTalk contract compatibility", () => {
  it("keeps the original Enterprise Stream URL contract importable", () => {
    expect(DINGTALK_STREAM_API_BASE_URL).toBe("https://api.dingtalk.com/v1.0");
    expect(DINGTALK_REST_API_BASE_URL).toBe("https://api.dingtalk.io/v1.0");
    expect(DINGTALK_BOT_CALLBACK_TOPIC).toBe("/v1.0/im/bot/messages/get");
    expect(DINGTALK_STREAM_OPEN_URL).toBe("https://api.dingtalk.com/v1.0/gateway/connections/open");
    expect(DINGTALK_ACCESS_TOKEN_URL).toBe("https://api.dingtalk.io/v1.0/oauth2/accessToken");
    expect(DINGTALK_DM_SEND_URL).toBe("https://api.dingtalk.io/v1.0/robot/oToMessages/batchSend");
    expect(DINGTALK_GROUP_SEND_URL).toBe("https://api.dingtalk.io/v1.0/robot/groupMessages/send");
  });

  it("normalizes base URLs and endpoint URLs without losing query parameters on endpoints", () => {
    expect(normalizeDingTalkBaseUrl("https://api.dingtalk.io/v1.0/?debug=1#hash")).toBe("https://api.dingtalk.io/v1.0");
    expect(normalizeDingTalkEndpointUrl("https://api.dingtalk.com/open?ticket=1#hash", "endpoint")).toBe("https://api.dingtalk.com/open?ticket=1");
    expect(buildDingTalkUrl("https://api.dingtalk.io/v1.0/", "/oauth2/accessToken")).toBe(DINGTALK_ACCESS_TOKEN_URL);
  });

  it("accepts original appKey/appSecret fields and main-program clientId/clientSecret aliases", () => {
    expect(normalizeDingTalkBridgeCredentials({
      appKey: " app-key ",
      appSecret: " app-secret ",
      robotCode: " robot-code ",
    })).toEqual({
      appKey: "app-key",
      appSecret: "app-secret",
      robotCode: "robot-code",
      restBaseUrl: DINGTALK_REST_API_BASE_URL,
      streamOpenUrl: DINGTALK_STREAM_OPEN_URL,
    });

    expect(normalizeDingTalkBridgeCredentials({
      clientId: " client-id ",
      clientSecret: " client-secret ",
      robotCode: " robot-code ",
      restBaseUrl: "https://example.com/rest/",
      streamOpenUrl: "https://example.com/stream?x=1",
    })).toMatchObject({
      appKey: "client-id",
      appSecret: "client-secret",
      robotCode: "robot-code",
      restBaseUrl: "https://example.com/rest",
      streamOpenUrl: "https://example.com/stream?x=1",
    });
  });

  it("rejects custom robot webhook fields for the Enterprise Stream connector", () => {
    expect(() => assertNoUnsupportedDingTalkRobotFields({ webhook: "https://example.com" }))
      .toThrow(/custom robot webhook fields/);
    expect(() => normalizeDingTalkBridgeCredentials({
      appKey: "app",
      appSecret: "secret",
      robotCode: "robot",
      webhookSecret: "legacy-secret",
    })).toThrow(/custom robot webhook fields/);
  });
});
