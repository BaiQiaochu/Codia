// @ts-nocheck
import fs from "fs";
import { callText } from "../llm-client.ts";
import { callTextWithLengthContract, type OutputLengthContract } from "../output-length-contract.ts";
import { getLocale } from "../../lib/i18n.ts";
import { isToolCallBlock } from "../llm-utils.ts";

const SUMMARY_TIMEOUT_MS = 15_000;
const CONTENT_CHAR_LIMIT = 1500;
const MAX_TURNS_FROM_TAIL = 8;

export async function summarizeSessionForRc(engine, agent, sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return null;

  const content = _extractRecentTurns(sessionPath);
  if (!content.userText && !content.assistantText) return null;

  const isZh = getLocale().startsWith("zh");
  const messages = _buildMessages(content, isZh);
  const lengthContract = _summaryLengthContract(isZh);

  let utilConfig = null;
  try {
    utilConfig = engine.resolveUtilityConfig?.(agent?.id ? { agentId: agent.id } : undefined);
  } catch {}

  if (utilConfig?.utility && utilConfig.api_key && utilConfig.base_url && utilConfig.api) {
    const text = await _safeCall({
      api: utilConfig.api,
      model: utilConfig.utility,
      apiKey: utilConfig.api_key,
      baseUrl: utilConfig.base_url,
      messages,
      usageLedger: utilConfig.usageLedger ?? engine.usageLedger,
      usageContext: usageContextForRc(agent, sessionPath, "rc_summary_utility"),
      lengthContract,
    }, "utility");
    if (text) return text;
  }

  if (utilConfig?.utility_large && utilConfig.large_api_key && utilConfig.large_base_url && utilConfig.large_api) {
    const text = await _safeCall({
      api: utilConfig.large_api,
      model: utilConfig.utility_large,
      apiKey: utilConfig.large_api_key,
      baseUrl: utilConfig.large_base_url,
      messages,
      usageLedger: utilConfig.usageLedger ?? engine.usageLedger,
      usageContext: usageContextForRc(agent, sessionPath, "rc_summary_utility_large"),
      lengthContract,
    }, "utility_large");
    if (text) return text;
  }

  const chatRef = agent?.config?.models?.chat;
  if (chatRef?.id && chatRef?.provider) {
    try {
      const resolved = engine.resolveModelWithCredentials?.({ id: chatRef.id, provider: chatRef.provider });
      if (resolved) {
        const text = await _safeCall({
          api: resolved.api,
          model: resolved.model,
          apiKey: resolved.api_key,
          baseUrl: resolved.base_url,
          messages,
          usageLedger: engine.usageLedger,
          usageContext: usageContextForRc(agent, sessionPath, "rc_summary_chat"),
          lengthContract,
        }, "chat");
        if (text) return text;
      }
    } catch (err) {
      console.warn(`[rc-summary] chat tier resolve failed: ${err.message}`);
    }
  }

  return null;
}

function usageContextForRc(agent, sessionPath, operation) {
  return {
    source: {
      subsystem: "utility",
      operation,
      surface: "bridge",
      trigger: "remote_control",
    },
    attribution: {
      kind: "session",
      agentId: agent?.id || null,
      sessionPath,
    },
  };
}

function _summaryLengthContract(isZh): OutputLengthContract {
  return isZh
    ? { label: "/rc summary", target: 100, unit: "chars", min: 1, locale: "zh" }
    : { label: "/rc summary", target: 60, unit: "words", min: 1, locale: "en" };
}

async function _safeCall({ api, model, apiKey, baseUrl, messages, usageLedger, usageContext, lengthContract }, tierLabel) {
  try {
    const { text } = await callTextWithLengthContract({
      callText,
      request: {
        api,
        model,
        apiKey,
        baseUrl,
        messages,
        temperature: 0.3,
        timeoutMs: SUMMARY_TIMEOUT_MS,
        usageLedger,
        usageContext,
      },
      contract: lengthContract,
    });
    return text?.trim() || null;
  } catch (err) {
    console.warn(`[rc-summary] ${tierLabel} tier failed: ${err.message}`);
    return null;
  }
}

function _extractRecentTurns(sessionPath) {
  let raw;
  try {
    raw = fs.readFileSync(sessionPath, "utf-8");
  } catch {
    return { userText: "", assistantText: "", tools: [] };
  }

  const lines = raw.trim().split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  const messages = lines
    .filter((line) => line.type === "message" && line.message)
    .slice(-MAX_TURNS_FROM_TAIL);

  let userText = "";
  let assistantText = "";
  const tools = [];
  for (const line of messages) {
    const message = line.message;
    const textParts = (message.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (message.role === "user" && textParts) {
      userText += (userText ? "\n---\n" : "") + textParts;
    }
    if (message.role === "assistant") {
      if (textParts) assistantText += (assistantText ? "\n---\n" : "") + textParts;
      const toolParts = (message.content || []).filter(isToolCallBlock);
      for (const part of toolParts) tools.push(part.name || "unknown_tool");
    }
  }
  return {
    userText: userText.slice(0, CONTENT_CHAR_LIMIT),
    assistantText: assistantText.slice(0, CONTENT_CHAR_LIMIT),
    tools: [...new Set(tools)],
  };
}

function _buildMessages({ userText, assistantText, tools }, isZh) {
  const system = isZh
    ? "你是对话摘要生成器。根据下面几轮对话，概括这个桌面会话正在处理什么、当前进展，以及能看出的下一步线索。规则：中文，直接输出 1-3 句，目标约 100 字，可在 60-200 字之间自然浮动；不加引号、不加前缀、不列编号；不要逐条复述工具日志，也不要只写工具名或泛泛一句。"
    : "You summarize conversations. Given the turns below, describe what this desktop session is handling, its current progress, and any visible next-step clue. Rules: output 1-3 direct English sentences, aiming for about 60 words; 36-120 words is acceptable. No quotes, preamble, or numbering; do not list tool logs, and do not reduce the summary to tool names or a generic phrase.";

  const toolStr = tools.length > 0
    ? (isZh ? `\n用到的工具：${tools.join("、")}` : `\nTools used: ${tools.join(", ")}`)
    : "";

  const contextLabel = isZh ? "对话片段" : "Conversation";
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `${contextLabel}：\n\n${isZh ? "用户：" : "User: "}${userText}\n\n${isZh ? "助手：" : "Assistant: "}${assistantText}${toolStr}`,
    },
  ];
}
