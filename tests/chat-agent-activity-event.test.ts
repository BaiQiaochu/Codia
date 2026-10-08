import { describe, expect, it } from "vitest";

import { toAgentActivityWsMessage } from "../server/routes/chat.ts";

// 回归：ActivityHub 广播的 agent_activity 事件必须经 chat.js 的 hub.subscribe 转发链
// broadcast 到 WS client，否则右侧「子助手 / workflow / 巡检」卡永远收不到数据。
// 关键契约：消息带顶层 sessionPath —— wsClientCanReceiveEvent 靠它给非本地（PWA/远程）
// client 做 session 订阅校验；缺失会 fail-closed，远程端收不到。
describe("chat route agent_activity forwarding", () => {
  it("forwards ActivityHub entry with top-level sessionPath for delivery routing", () => {
    const entry = {
      id: "subagent-1", kind: "subagent", status: "running",
      sessionPath: "/session/a.jsonl", agentId: "butter", agentName: "butter",
      summary: "点评咖啡", childSessionPath: null, startedAt: 1, finishedAt: null,
    };
    expect(toAgentActivityWsMessage({ type: "agent_activity", entry }, "/session/a.jsonl")).toEqual({
      type: "agent_activity",
      entry,
      sessionPath: "/session/a.jsonl",
    });
  });

  it("falls back to entry.sessionPath when listener sessionPath is missing", () => {
    const entry = { id: "x", kind: "subagent", status: "done", sessionPath: "/session/b.jsonl" };
    expect(toAgentActivityWsMessage({ type: "agent_activity", entry }, null)).toEqual({
      type: "agent_activity",
      entry,
      sessionPath: "/session/b.jsonl",
    });
  });

  it("ignores non-agent_activity events", () => {
    expect(toAgentActivityWsMessage({ type: "turn_end" }, "/session/a.jsonl")).toBeNull();
  });
});
