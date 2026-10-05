/**
 * #1285 读时修复测试 — 已落盘坏会话的孤儿 toolResult entry 清理。
 *
 * 坏数据成因：agentic 工具循环里 assistant 回包 stopReason=error/aborted 时，Pi SDK
 * agent-loop 立即 return 不执行其 tool calls，但此前已完成轮次的 toolResult 已 push
 * 进 context 并持久化。重放时 Pi SDK transform-messages 整条丢弃 error/aborted
 * assistant（连带 tool_calls），残留的 toolResult 变孤儿 → role:"tool" 缺前驱
 * tool_calls → provider 400。
 *
 * 读时修复（repairOrphanToolResultEntries）在 restore 时检测并删除这些孤儿 toolResult
 * entry，并修复 parentId 链（被删 entry 的子节点重连到被删节点的父节点），让
 * buildSessionContext 的 tree-walk 不被破坏。
 *
 * 镜像 SDK transform-messages 的丢弃规则：只有 stopReason 非 error/aborted 的
 * assistant 声明的 toolCall 才算「父存在」；error/aborted assistant 的 toolCall 视为
 * 会被 SDK 丢弃 → 其 toolResult 是孤儿。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { repairOrphanToolResultEntries, repairOrphanToolResultEntriesInFile } from "../core/session-health.ts";

// ── 构造 entry 辅助 ──

function sessionHeader() {
  return { type: "session", version: 3, id: "sess-1", timestamp: "2026-05-29T00:00:00.000Z" };
}

let seq = 0;
function nextId() {
  return `e${++seq}`;
}

function msgEntry(parentId, message) {
  return { type: "message", id: nextId(), parentId, timestamp: "2026-05-29T00:00:00.000Z", message };
}

function userMsg(parentId, text = "hi") {
  return msgEntry(parentId, { role: "user", content: text });
}

function assistantToolCall(parentId, { stopReason, toolCallId, toolName = "f" }) {
  return msgEntry(parentId, {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
    stopReason,
    provider: "deepseek",
    model: "deepseek-chat",
  });
}

function toolResult(parentId, toolCallId, toolName = "f") {
  return msgEntry(parentId, {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "result" }],
    isError: false,
  });
}

function assistantText(parentId, text = "done", stopReason = "stop") {
  return msgEntry(parentId, {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    provider: "deepseek",
    model: "deepseek-chat",
  });
}

// 用 id 串成链：返回 [header, ...entries] 并自动设置 parentId
function chain(...builders) {
  seq = 0;
  const header = sessionHeader();
  const entries = [header];
  let parentId = null;
  for (const build of builders) {
    const entry = build(parentId);
    entries.push(entry);
    parentId = entry.id;
  }
  return entries;
}

function roles(entries) {
  return entries
    .filter((e) => e.type === "message")
    .map((e) => e.message.role);
}

describe("repairOrphanToolResultEntries — 孤儿清理", () => {
  it("删除父 assistant=error 的孤儿 toolResult（#1285 核心复现）", () => {
    const entries = chain(
      (p) => userMsg(p, "调用工具"),
      (p) => assistantToolCall(p, { stopReason: "error", toolCallId: "call_orphan" }),
      (p) => toolResult(p, "call_orphan"),
      (p) => userMsg(p, "继续"),
    );
    const { entries: repaired, removed } = repairOrphanToolResultEntries(entries);
    expect(removed).toBe(1);
    // toolResult 被删，error assistant 本身保留（SDK 自己会在 replay 时丢，不归读时修复删）
    expect(roles(repaired)).toEqual(["user", "assistant", "user"]);
    expect(repaired.some((e) => e.type === "message" && e.message.role === "toolResult")).toBe(false);
  });

  it("删除父 assistant=aborted 的孤儿 toolResult", () => {
    const entries = chain(
      (p) => userMsg(p),
      (p) => assistantToolCall(p, { stopReason: "aborted", toolCallId: "call_a" }),
      (p) => toolResult(p, "call_a"),
      (p) => userMsg(p, "next"),
    );
    const { removed } = repairOrphanToolResultEntries(entries);
    expect(removed).toBe(1);
  });

  it("被删 toolResult 的子节点 parentId 重连到被删节点的父节点（链不断）", () => {
    const entries = chain(
      (p) => userMsg(p, "q"),                                              // e1
      (p) => assistantToolCall(p, { stopReason: "error", toolCallId: "x" }), // e2
      (p) => toolResult(p, "x"),                                           // e3 (被删)
      (p) => userMsg(p, "继续"),                                            // e4 -> 应重连到 e2
    );
    const errorAssistantId = entries[2].id; // e2
    const { entries: repaired } = repairOrphanToolResultEntries(entries);
    const lastUser = repaired.find((e) => e.type === "message" && e.message.role === "user" && e.message.content === "继续");
    expect(lastUser.parentId).toBe(errorAssistantId);
  });
});

describe("repairOrphanToolResultEntries — 正常序列不受影响（关键回归保护）", () => {
  it("成对 toolCall(stop) + toolResult 原样保留，removed=0，返回原数组引用", () => {
    const entries = chain(
      (p) => userMsg(p, "今天几号"),
      (p) => assistantToolCall(p, { stopReason: "toolUse", toolCallId: "call_1", toolName: "date" }),
      (p) => toolResult(p, "call_1", "date"),
      (p) => assistantText(p, "今天是 2026-05-29"),
    );
    const result = repairOrphanToolResultEntries(entries);
    expect(result.removed).toBe(0);
    expect(result.entries).toBe(entries); // 未修改时返回原引用
  });

  it("连续多轮 agentic 工具调用（全 toolUse）全部保留", () => {
    const entries = chain(
      (p) => userMsg(p, "q"),
      (p) => assistantToolCall(p, { stopReason: "toolUse", toolCallId: "c1" }),
      (p) => toolResult(p, "c1"),
      (p) => assistantToolCall(p, { stopReason: "toolUse", toolCallId: "c2" }),
      (p) => toolResult(p, "c2"),
      (p) => assistantText(p, "final"),
    );
    const result = repairOrphanToolResultEntries(entries);
    expect(result.removed).toBe(0);
    expect(roles(result.entries).filter((r) => r === "toolResult")).toHaveLength(2);
  });

  it("stopReason 缺失（老数据/正常完成）的 assistant tool_calls 视为有效父", () => {
    // 一些路径 assistant 不带 stopReason；只有显式 error/aborted 才算被 SDK 丢弃
    const entries = chain(
      (p) => userMsg(p),
      (p) => assistantToolCall(p, { stopReason: undefined, toolCallId: "c1" }),
      (p) => toolResult(p, "c1"),
      (p) => assistantText(p, "ok"),
    );
    const result = repairOrphanToolResultEntries(entries);
    expect(result.removed).toBe(0);
  });
});

describe("repairOrphanToolResultEntries — 混合与边界", () => {
  it("混合：第一轮成对(toolUse)保留，第二轮 error 孤儿删除", () => {
    const entries = chain(
      (p) => userMsg(p, "q"),
      (p) => assistantToolCall(p, { stopReason: "toolUse", toolCallId: "good" }),
      (p) => toolResult(p, "good"),
      (p) => assistantToolCall(p, { stopReason: "error", toolCallId: "bad" }),
      (p) => toolResult(p, "bad"),
      (p) => userMsg(p, "继续"),
    );
    const { entries: repaired, removed } = repairOrphanToolResultEntries(entries);
    expect(removed).toBe(1);
    const toolResults = repaired.filter((e) => e.type === "message" && e.message.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].message.toolCallId).toBe("good");
  });

  it("error assistant 后多个孤儿 toolResult（并行工具）全删", () => {
    const entries = chain(
      (p) => userMsg(p),
      (p) => msgEntry(p, {
        role: "assistant",
        content: [
          { type: "toolCall", id: "p1", name: "f", arguments: {} },
          { type: "toolCall", id: "p2", name: "f", arguments: {} },
        ],
        stopReason: "error",
        provider: "deepseek",
        model: "deepseek-chat",
      }),
      (p) => toolResult(p, "p1"),
      (p) => toolResult(p, "p2"),
      (p) => userMsg(p, "继续"),
    );
    const { removed } = repairOrphanToolResultEntries(entries);
    expect(removed).toBe(2);
  });

  it("非数组 / 空 / 无 toolResult 输入安全返回原引用", () => {
    expect(repairOrphanToolResultEntries(null).entries).toBe(null);
    expect(repairOrphanToolResultEntries(null).removed).toBe(0);
    const empty = [];
    expect(repairOrphanToolResultEntries(empty).entries).toBe(empty);
    const plain = chain((p) => userMsg(p), (p) => assistantText(p, "hi"));
    expect(repairOrphanToolResultEntries(plain).entries).toBe(plain);
    expect(repairOrphanToolResultEntries(plain).removed).toBe(0);
  });

  it("非 message 类型 entry（compaction/model_change）穿过不受影响", () => {
    seq = 0;
    const header = sessionHeader();
    const u = userMsg(null);
    const a = assistantToolCall(u.id, { stopReason: "error", toolCallId: "z" });
    const tr = toolResult(a.id, "z");
    const modelChange = { type: "model_change", id: nextId(), parentId: tr.id, timestamp: "x", provider: "deepseek", modelId: "deepseek-chat" };
    const u2 = userMsg(modelChange.id, "继续");
    const entries = [header, u, a, tr, modelChange, u2];
    const { entries: repaired, removed } = repairOrphanToolResultEntries(entries);
    expect(removed).toBe(1);
    // model_change 仍在，且 parentId 从被删的 tr 重连到 a
    const mc = repaired.find((e) => e.type === "model_change");
    expect(mc.parentId).toBe(a.id);
  });
});

// ── 文件层读时修复（落盘） ──

describe("repairOrphanToolResultEntriesInFile — 落盘修复", () => {
  let tmpDir;
  let sessionPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-repair-"));
    sessionPath = path.join(tmpDir, "session.jsonl");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function writeEntries(entries) {
    fs.writeFileSync(sessionPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  }

  function readEntries() {
    return fs.readFileSync(sessionPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  it("坏会话被落盘修复，孤儿 toolResult 从文件中删除（#1285 端到端）", () => {
    const entries = chain(
      (p) => userMsg(p, "调用工具"),
      (p) => assistantToolCall(p, { stopReason: "error", toolCallId: "call_orphan" }),
      (p) => toolResult(p, "call_orphan"),
      (p) => userMsg(p, "继续"),
    );
    writeEntries(entries);

    const result = repairOrphanToolResultEntriesInFile(sessionPath);
    expect(result.repaired).toBe(true);
    expect(result.removed).toBe(1);

    const after = readEntries();
    expect(after.some((e) => e.type === "message" && e.message.role === "toolResult")).toBe(false);
    // 文件仍以 session header 开头，可被 SessionManager 正常读回
    expect(after[0].type).toBe("session");
  });

  it("健康会话不被改写，repaired=false，文件内容字节不变", () => {
    const entries = chain(
      (p) => userMsg(p, "今天几号"),
      (p) => assistantToolCall(p, { stopReason: "toolUse", toolCallId: "call_1", toolName: "date" }),
      (p) => toolResult(p, "call_1", "date"),
      (p) => assistantText(p, "今天是 2026-05-29"),
    );
    writeEntries(entries);
    const before = fs.readFileSync(sessionPath, "utf-8");

    const result = repairOrphanToolResultEntriesInFile(sessionPath);
    expect(result.repaired).toBe(false);
    expect(result.removed).toBe(0);
    expect(fs.readFileSync(sessionPath, "utf-8")).toBe(before);
  });

  it("不存在的文件安全返回 { repaired:false }，不抛错", () => {
    const result = repairOrphanToolResultEntriesInFile(path.join(tmpDir, "nope.jsonl"));
    expect(result).toEqual({ repaired: false, removed: 0 });
  });

  it("含坏行的文件放弃修复（避免无损 round-trip 风险），不改写", () => {
    // 坏行存在时无法保证重写不丢数据，宁可不修，交给运行时兜底防 400
    fs.writeFileSync(sessionPath,
      `${JSON.stringify(sessionHeader())}\n` +
      `not valid json line\n` +
      `${JSON.stringify(toolResult(null, "orphan"))}\n`
    );
    const before = fs.readFileSync(sessionPath, "utf-8");
    const result = repairOrphanToolResultEntriesInFile(sessionPath);
    expect(result.repaired).toBe(false);
    expect(fs.readFileSync(sessionPath, "utf-8")).toBe(before);
  });

  it("非法 header（首行不是 session）放弃修复", () => {
    fs.writeFileSync(sessionPath,
      `${JSON.stringify(userMsg(null))}\n` +
      `${JSON.stringify(toolResult(null, "orphan"))}\n`
    );
    const result = repairOrphanToolResultEntriesInFile(sessionPath);
    expect(result.repaired).toBe(false);
  });
});
