import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelRouter } from "../hub/channel-router.js";
import { getAgentPhoneProjectionPath, readAgentPhoneProjection } from "../lib/conversations/agent-phone-projection.js";
import { loadLocale } from "../server/i18n.js";

const { runAgentPhoneSessionMock } = vi.hoisted(() => ({
  runAgentPhoneSessionMock: vi.fn(async (_agentId, _rounds, options) => {
    const passTool = options.extraCustomTools.find((tool) => tool.name === "channel_pass");
    await passTool.execute("tool-call-1", { reason: "watching" });
    return "";
  }),
}));

vi.mock("../hub/agent-executor.js", () => ({
  runAgentSession: vi.fn(async () => ""),
  runAgentPhoneSession: runAgentPhoneSessionMock,
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(async () => "NO"),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

describe("ChannelRouter phone activity delivery", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-channel-phone-activity-"));
    runAgentPhoneSessionMock.mockClear();
    loadLocale("en");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records channel delivery activity for the phone/window activity panel", async () => {
    const agentsDir = path.join(tmpDir, "agents");
    const channelsDir = path.join(tmpDir, "channels");
    const userDir = path.join(tmpDir, "user");
    const productDir = path.join(tmpDir, "product");
    const agentDir = path.join(agentsDir, "nova");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Nova\n  yuan: codia\n", "utf-8");

    const activities = [];
    const router = new ChannelRouter({
      hub: {
        engine: {
          agentsDir,
          channelsDir,
          productDir,
          userDir,
          agents: new Map(),
          getAgent: () => null,
          resolveUtilityConfig: () => ({
            utility_large: "utility-large",
            large_api_key: "key",
            large_base_url: "https://example.test",
            large_api: "openai-completions",
          }),
        },
        eventBus: { emit: vi.fn() },
        agentPhoneActivities: { record: (activity) => activities.push(activity) },
      },
    });

    const result = await router._executeCheck(
      "nova",
      "ch_crew",
      [{ sender: "user", timestamp: "2026-05-20 10:00:00", body: "hello" }],
      [],
      {
        deliveryWindow: {
          totalUnreadCount: 3,
          droppedUnreadCount: 2,
          bookmarkState: "missing",
        },
      },
    );

    expect(result).toMatchObject({ replied: false, passed: true });
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationId: "ch_crew",
        agentId: "nova",
        state: "viewed",
        details: expect.objectContaining({
          totalUnreadCount: 3,
          droppedUnreadCount: 2,
          bookmarkState: "missing",
        }),
      }),
      expect.objectContaining({
        conversationId: "ch_crew",
        agentId: "nova",
        state: "no_reply",
      }),
    ]));

    const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(agentDir, "ch_crew"));
    expect(projection.meta).toMatchObject({
      agentId: "nova",
      conversationId: "ch_crew",
      conversationType: "channel",
      state: "no_reply",
      summary: "Viewed and chose not to post",
      lastViewedTimestamp: "2026-05-20 10:00:00",
    });
  });
});
