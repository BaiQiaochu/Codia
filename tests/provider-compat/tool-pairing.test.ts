/**
 * #1285 回归测试 — 孤儿 toolResult 配对兜底（provider-agnostic）。
 *
 * 根因：assistant 回包 stopReason=error/aborted 时，Pi SDK agent-loop 立即 return
 * 不执行其 tool calls，但此前已完成轮次的 toolResult 已 push 进 context 并持久化。
 * 重放时 Pi SDK transform-messages 整条丢弃 stopReason=error/aborted 的 assistant
 * （连带其 tool_calls），但没有反向逻辑删除「父 tool_calls 已被丢弃的孤儿
 * toolResult」。openai-completions convertMessages 无条件把残留 toolResult 序列化成
 * role:"tool"，前面缺 tool_calls → DeepSeek/OpenAI-compatible 返回 400。
 *
 * 这里覆盖序列化后的 OpenAI 风格 payload（before_provider_request hook 的形态）：
 * 每个 role:"tool" 必须有前驱带匹配 tool_calls 的 assistant，否则视为孤儿删除。
 */
import { describe, expect, it } from "vitest";
import { stripOrphanToolResults } from "../../core/provider-compat/tool-pairing.js";

describe("stripOrphanToolResults — 孤儿删除", () => {
  it("删除父 tool_calls 不存在的孤儿 role:tool（#1285 核心复现）", () => {
    // SDK transform-messages 丢掉 error assistant 及其 tool_calls 后，残留这条孤儿 tool
    const messages = [
      { role: "user", content: "调用工具" },
      // error assistant 已被 SDK 丢弃，这里只剩它的 toolResult
      { role: "tool", tool_call_id: "call_orphan", content: "工具结果" },
      { role: "user", content: "继续" },
    ];
    const result = stripOrphanToolResults(messages);
    expect(result).not.toBe(messages); // 修改时返回新数组
    expect(result.find((m) => m.role === "tool")).toBeUndefined();
    expect(result.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("孤儿在序列中间时，前后消息顺序不变", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "tool", tool_call_id: "ghost", content: "orphan" },
      { role: "assistant", content: "回答" },
    ];
    const result = stripOrphanToolResults(messages);
    expect(result.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("多个孤儿全部删除", () => {
    const messages = [
      { role: "user", content: "x" },
      { role: "tool", tool_call_id: "g1", content: "r1" },
      { role: "tool", tool_call_id: "g2", content: "r2" },
      { role: "assistant", content: "done" },
    ];
    const result = stripOrphanToolResults(messages);
    expect(result.some((m) => m.role === "tool")).toBe(false);
  });
});

describe("stripOrphanToolResults — 正常成对序列不受影响（关键回归保护）", () => {
  it("正常 assistant(tool_calls) + tool 配对原样返回，且返回同一数组引用", () => {
    const messages = [
      { role: "user", content: "今天几号" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "2026-05-29" },
      { role: "assistant", content: "今天是 2026-05-29" },
    ];
    const result = stripOrphanToolResults(messages);
    expect(result).toBe(messages); // 未修改时返回原数组（不可变契约 + 避免无谓拷贝）
  });

  it("一个 assistant 多个 tool_calls 对应多个 tool 全部保留", () => {
    const messages = [
      { role: "user", content: "并行调用" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "f1", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "f2", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "ra" },
      { role: "tool", tool_call_id: "call_b", content: "rb" },
      { role: "assistant", content: "都好了" },
    ];
    const result = stripOrphanToolResults(messages);
    expect(result).toBe(messages);
    expect(result.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("连续多轮工具调用（agentic 循环）全部成对时不动", () => {
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "r1" },
      { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c2", content: "r2" },
      { role: "assistant", content: "final" },
    ];
    const result = stripOrphanToolResults(messages);
    expect(result).toBe(messages);
  });
});

describe("stripOrphanToolResults — 部分孤儿（混合场景）", () => {
  it("只删孤儿，保留同序列里成对的 tool", () => {
    // 真实 #1285 场景：第一轮工具成对完成，第二轮 assistant error 被丢弃后留下孤儿
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: null, tool_calls: [{ id: "good", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "good", content: "ok" },
      // 第二轮 error assistant 已被 SDK 丢弃，残留孤儿
      { role: "tool", tool_call_id: "orphan", content: "leftover" },
      { role: "user", content: "继续" },
    ];
    const result = stripOrphanToolResults(messages);
    const toolMsgs = result.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].tool_call_id).toBe("good");
  });

  it("孤儿后紧跟一个成对的 tool（顺序中混合）", () => {
    const messages = [
      { role: "tool", tool_call_id: "orphan", content: "x" },
      { role: "assistant", content: null, tool_calls: [{ id: "real", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "real", content: "y" },
    ];
    const result = stripOrphanToolResults(messages);
    expect(result.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(result.find((m) => m.role === "tool").tool_call_id).toBe("real");
  });
});

describe("stripOrphanToolResults — 边界与容错", () => {
  it("非数组输入原样返回", () => {
    expect(stripOrphanToolResults(null)).toBe(null);
    expect(stripOrphanToolResults(undefined)).toBe(undefined);
    expect(stripOrphanToolResults("nope")).toBe("nope");
  });

  it("空数组返回原数组", () => {
    const messages = [];
    expect(stripOrphanToolResults(messages)).toBe(messages);
  });

  it("无 tool 消息的普通对话不动", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(stripOrphanToolResults(messages)).toBe(messages);
  });

  it("tool_calls 为空数组的 assistant 不提供任何配对（其后 tool 视为孤儿）", () => {
    const messages = [
      { role: "assistant", content: "x", tool_calls: [] },
      { role: "tool", tool_call_id: "c1", content: "r" },
    ];
    const result = stripOrphanToolResults(messages);
    expect(result.some((m) => m.role === "tool")).toBe(false);
  });

  it("tool_calls 项缺 id 时不污染配对集合（其后同 id 缺失的 tool 仍是孤儿）", () => {
    const messages = [
      { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "r" },
    ];
    const result = stripOrphanToolResults(messages);
    expect(result.some((m) => m.role === "tool")).toBe(false);
  });
});
