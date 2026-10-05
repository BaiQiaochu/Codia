// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { AgentPhoneActivityStore } from "../lib/conversations/agent-phone-activity.js";

describe("AgentPhoneActivityStore", () => {
  it("stores latest activity per conversation and agent, then emits a websocket-ready event", () => {
    const emit = vi.fn();
    const store = new AgentPhoneActivityStore({
      emit,
      now: () => "2026-05-12T12:00:00.000Z",
    });

    const activity = store.record({
      conversationId: "ch_crew",
      conversationType: "channel",
      agentId: "hana",
      state: "triaging",
      summary: "Checking whether to reply",
    });

    expect(activity).toMatchObject({
      conversationId: "ch_crew",
      conversationType: "channel",
      agentId: "hana",
      state: "triaging",
      summary: "Checking whether to reply",
      timestamp: "2026-05-12T12:00:00.000Z",
    });
    expect(store.snapshot("ch_crew")).toEqual([activity]);
    expect(emit).toHaveBeenCalledWith({
      type: "conversation_agent_activity",
      activity,
    });
  });

  it("keeps independent histories for each agent in the same conversation", () => {
    const store = new AgentPhoneActivityStore({ emit: () => {} });

    store.record({
      conversationId: "ch_crew",
      conversationType: "channel",
      agentId: "hana",
      state: "viewed",
      summary: "Viewed messages",
    });
    store.record({
      conversationId: "ch_crew",
      conversationType: "channel",
      agentId: "yui",
      state: "no_reply",
      summary: "Skipped reply",
    });

    expect(store.snapshot("ch_crew").map((item) => item.agentId).sort()).toEqual(["hana", "yui"]);
    expect(store.snapshot("dm:yui")).toEqual([]);
  });
});
