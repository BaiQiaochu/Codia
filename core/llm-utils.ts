// @ts-nocheck
/**
  *
 *
  * */
import fs from "fs";
import path from "path";
import { callText } from "./llm-client.ts";
import { getLocale } from "../lib/i18n.ts";

/** Pi SDK content block 是否为工具调用（兼容 tool_use / toolCall 两种格式-*/
export const isToolCallBlock = (b) => (b.type === "tool_use" || b.type === "toolCall") && !!b.name;

/** 取工具调用参数（兼容 input / arguments-*/
export const getToolArgs = (b) => b.input || b.arguments;

/**
  *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.api_key
 * @param {string} opts.base_url
 * @param {Array} opts.messages
 * @param {number} [opts.temperature=0.3]
 * @param {number} [opts.max_tokens=100]
  *
 */
async function callLlm({
  model,
  api,
  api_key,
  base_url,
  messages,
  temperature = 0.3,
  max_tokens = 100,
  timeoutMs,
  signal,
  quirks,
  usageLedger,
  usageContext,
}) {
  return callText({
    api, model,
    apiKey: api_key,
    baseUrl: base_url,
    messages, temperature,
    maxTokens: max_tokens,
    ...(timeoutMs != null && { timeoutMs }),
    ...(signal != null && { signal }),
    ...(quirks != null && { quirks }),
    ...(usageLedger != null && { usageLedger }),
    ...(usageContext != null && { usageContext }),
  });
}

function utilityUsageContext(utilConfig, operation, trigger = "tool") {
  const agentId = utilConfig?.usageAgentId || null;
  const sessionPath = utilConfig?.usageSessionPath || null;
  return {
    source: {
      subsystem: "utility",
      operation,
      surface: "system",
      trigger,
    },
    attribution: sessionPath
      ? { kind: "session", agentId, sessionPath }
      : { kind: "utility", agentId },
  };
}

/**
  * */
function parseSessionContent(sessionPath, { userLimit = 1000, assistantLimit = 1000 } = {}) {
  const raw = fs.readFileSync(sessionPath, "utf-8");
  const lines = raw.trim().split("\n").map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  let userText = "";
  let assistantText = "";
  const toolCalls = [];
  for (const line of lines) {
    if (line.type !== "message" || !line.message) continue;
    const msg = line.message;
    if (msg.role === "user" && !userText) {
      const textParts = (msg.content || []).filter(c => c.type === "text");
      userText = textParts.map(c => c.text).join("\n").slice(0, userLimit);
    }
    if (msg.role === "assistant") {
      const textParts = (msg.content || []).filter(c => c.type === "text");
      assistantText = textParts.map(c => c.text).join("\n").slice(0, assistantLimit);
      const toolParts = (msg.content || []).filter(isToolCallBlock);
      for (const t of toolParts) toolCalls.push(t.name || "unknown_tool");
    }
  }
  return { userText, assistantText, toolCalls };
}

/**
 * -session 内容生成本地兜底摘要（不依赖外部 API- */
export function buildLocalSummary(assistantText, toolCalls) {
  const isZh = getLocale().startsWith("zh");
  const uniqueTools = [...new Set(toolCalls)];
  if (uniqueTools.length > 0) {
    if (isZh) {
      return `执行了 ${uniqueTools.slice(0, 3).join("、")}${uniqueTools.length > 3 ? " 等" : ""}`;
    }
    return `Ran ${uniqueTools.slice(0, 3).join(", ")}${uniqueTools.length > 3 ? ", etc." : ""}`;
  }
  if (assistantText) {
    const clean = assistantText.replace(/[#*_`>\-[\]()]/g, "").trim();
    if (clean.length <= 50) return clean;
    return clean.slice(0, 47) + "...";
  }
  return null;
}

/**
 * 生成对话标题
 * @param {object} utilConfig - resolveUtilityConfig() 缁撴灉
 * @param {string} userText
 * @param {string} assistantText
  *
 */
export async function summarizeTitle(utilConfig, userText, assistantText, opts = {}) {
  try {
    const isZh = getLocale().startsWith("zh");
    const { utility: model, api_key, base_url, api } = utilConfig;
    if (!api_key || !base_url || !api) return null;

    const systemContent = isZh
      ? `你是一个对话标题生成器。根据用户和助手的第一轮对话，用一句很短的话概括主题。

规则：
1. 中文标题控制在 10 个字以内，英文标题控制在 5 个词以内
2. 标题语言必须匹配用户第一句话
3. 不要加引号、句号或其他标点
4. 直接输出标题，不要解释`
      : `You are a conversation title generator. Based on the first exchange between user and assistant, summarize the topic in a very short phrase.

Rules:
1. Keep the title under 5 words (English) or 10 characters (Chinese)
2. The title language must match the user's first message
3. No quotes, periods, or other punctuation
4. Output the title directly, no explanation`;

    const userLabel = isZh ? "用户" : "User";
  const assistantLabel = isZh ? "助手" : "Assistant";

    return await callLlm({
      model, api, api_key, base_url,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${userLabel}：${(userText || "").slice(0, 500)}\n${assistantLabel}：${(assistantText || "").slice(0, 500)}`,
        },
      ],
      max_tokens: 50,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      usageLedger: utilConfig.usageLedger,
      usageContext: utilityUsageContext(utilConfig, "title", "user"),
    });
  } catch (err) {
 //
    if (err.name === "AbortError" || err.name === "TimeoutError" || err.code === "LLM_TIMEOUT") return null;
    console.error("[llm-utils] summarizeTitle failed:", formatErrorWithCause(err));
    return null;
  }
}

function formatErrorWithCause(err) {
  const parts = [];
  if (err?.message) parts.push(err.message);
  const cause = err?.cause;
  if (cause) {
    const causeParts = [];
    if (cause.code) causeParts.push(cause.code);
    if (cause.message) causeParts.push(cause.message);
    if (causeParts.length > 0) parts.push(`cause: ${causeParts.join(" ")}`);
  }
  return parts.join(" | ") || String(err);
}

/**
  * */
export async function translateSkillNames(utilConfig, names, lang) {
  if (!names.length) return {};
  const LANG_LABEL = { zh: "中文", ja: "日本語", ko: "한국어" };
  const label = LANG_LABEL[lang] || lang;
  try {
    const { utility: model, api_key, base_url, api } = utilConfig;
    if (!api_key || !base_url || !api) return {};
    const isZh = getLocale().startsWith("zh");
    const text = await callLlm({
      model, api, api_key, base_url,
      messages: [
        {
          role: "system",
          content: isZh
            ? `将下列 kebab-case 英文技能名翻译成简短的${label}名称（2-4 个字）。直接输出 JSON 对象，key 为原名，value 为翻译。不要解释。`
            : `Translate the following kebab-case English skill names into short ${label} names (2-4 characters). Output a JSON object directly, key = original name, value = translation. No explanation.`,
        },
        { role: "user", content: JSON.stringify(names) },
      ],
      temperature: 0,
      max_tokens: 200,
      usageLedger: utilConfig.usageLedger,
      usageContext: utilityUsageContext(utilConfig, "translate_skill_names", "startup"),
    });
    if (!text) return {};
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch (err) {
    console.error("[llm-utils] translateSkillNames 失败:", err.message);
    return {};
  }
}

/**
  *
 * @param {string} sessionPath
  *
 */
export async function summarizeActivity(utilConfig, sessionPath, emitDevLog, preloaded) {
  const log = emitDevLog || (() => {});
  const isZh = getLocale().startsWith("zh");
  try {
    let userText, assistantText, toolCalls;
    if (preloaded) {
      userText = preloaded.userText || "";
      assistantText = preloaded.assistantText || "";
      toolCalls = preloaded.toolCalls || [];
    } else {
      ({ userText, assistantText, toolCalls } = parseSessionContent(sessionPath));
    }
    if (!userText && !assistantText) {
      log("[summarize] session empty, skipping");
      return null;
    }

    const toolInfo = toolCalls.length > 0
      ? (isZh
          ? `\n\n调用的工具：${[...new Set(toolCalls)].join("、")}`
          : `\n\nTools used: ${[...new Set(toolCalls)].join(", ")}`)
      : "";
    const { utility_large: model, large_api_key: api_key, large_base_url: base_url, large_api: api } = utilConfig;
    if (!api_key || !base_url || !api) {
      log("[summarize] utility_large config incomplete, skipping");
      return null;
    }

    const systemContent = isZh
      ? `你是一个执行摘要生成器。根据 Agent 的巡检上下文、执行结果和使用的工具，概括它做了什么。

规则：
1. 使用中文，50 字以内
2. 直接输出摘要，不要前缀或解释
3. 说清楚具体动作
4. 如果调用了工具，提到工具名和用途
5. 如果没有执行动作，就说“巡检完毕，一切正常”`
      : `You are an execution summary generator. Based on the Agent's patrol context, execution results, and tools used, summarize what it did.

Rules:
1. In English, under 30 words
2. Output the summary directly, no prefix or explanation
3. Be specific about what actions were taken (broke down tasks, searched info, marked complete, read files, etc.)
4. If tools were called, mention the tool names and what they did
5. If the Agent reported "all clear" or took no action, say "Patrol complete, all clear"`;

    const contextLabel = isZh ? "巡检上下文" : "Patrol context";
    const replyLabel = isZh ? "Agent 回复" : "Agent reply";

    const text = await callText({
      api, model,
      apiKey: api_key,
      baseUrl: base_url,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${contextLabel}：\n${userText.slice(0, 600)}\n\n${replyLabel}：\n${assistantText.slice(0, 600)}${toolInfo}`,
        },
      ],
      temperature: 0.3,
      maxTokens: 150,
      usageLedger: utilConfig.usageLedger,
      usageContext: utilityUsageContext(utilConfig, "activity_summary", "scheduled"),
    });

    return text;
  } catch (err) {
    log(`[summarize] error: ${err.message}`);
    console.error("[llm-utils] summarizeActivity failed:", err.message);
    return null;
  }
}

/**
  *
 * @param {object} utilConfig
 * @param {string} sessionPath - activity session 文件绝对路径
 */
export async function summarizeActivityQuick(utilConfig, sessionPath) {
  if (!fs.existsSync(sessionPath)) return null;
  const isZh = getLocale().startsWith("zh");
  try {
    const { userText, assistantText } = parseSessionContent(sessionPath, {
      userLimit: 800, assistantLimit: 800,
    });
    if (!userText && !assistantText) return null;

    const { utility: model, api_key, base_url, api } = utilConfig;
    if (!api_key || !base_url || !api) return null;

    const systemContent = isZh
      ? `根据 Agent 的巡检上下文和执行结果，用一两句话概括它做了什么。50 字以内，中文，直接输出。`
      : `Based on the Agent's patrol context and execution results, summarize what it did in one or two sentences. Under 15 words, English, output directly.`;

    const contextLabel = isZh ? "巡检上下文" : "Patrol context";
    const replyLabel = isZh ? "Agent 回复" : "Agent reply";

    return await callText({
      api, model,
      apiKey: api_key,
      baseUrl: base_url,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${contextLabel}：\n${userText.slice(0, 400)}\n\n${replyLabel}：\n${assistantText.slice(0, 400)}`,
        },
      ],
      temperature: 0.3,
      maxTokens: 80,
      usageLedger: utilConfig.usageLedger,
      usageContext: utilityUsageContext(utilConfig, "activity_summary_quick", "scheduled"),
    });
  } catch (err) {
    console.error("[llm-utils] summarizeActivityQuick failed:", err.message);
    return null;
  }
}

/**
  *
 * @param {object} utilConfig
  *
 */
function sanitizeAgentId(raw) {
  return (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 12)
    .replace(/-+$/g, "");
}

function findAvailableAgentId(base, agentsDir, max = 99) {
  if (!base) return null;
  if (!fs.existsSync(path.join(agentsDir, base))) return base;
  for (let i = 2; i <= max; i += 1) {
    const suffix = `-${i}`;
    const trimmedBase = base.slice(0, Math.max(2, 12 - suffix.length));
    const candidate = `${trimmedBase}${suffix}`;
    if (!fs.existsSync(path.join(agentsDir, candidate))) return candidate;
  }
  return null;
}

/**
 * Generate a semantic, collision-free agent id from a display name.
 * @param {object} utilConfig
 * @param {string} name
 * @param {string} agentsDir
 */
export async function generateAgentId(utilConfig, name, agentsDir) {
  let base = "";

  try {
    const isZh = getLocale().startsWith("zh");
    const { utility: model, api_key, base_url, api } = utilConfig;
    const text = await callLlm({
      model, api, api_key, base_url,
      messages: [
        {
          role: "system",
          content: isZh
            ? `根据给定的助手名字，生成一个简短的小写英文 ID，用于文件夹名。
规则：
1. 只使用小写英文字母、数字和连字符
2. 长度 2 到 12 个字符
3. 尽量使用名字的英文音译或缩写
4. 直接输出 ID，不要解释

示例：
- "G-SAP Balance" -> "gsap-balance"
- "miku" -> "miku"
- "小助手" -> "helper"
- "Alice" -> "alice"`
            : `Given an assistant display name, generate a short lowercase English ID for a folder name.
Rules:
1. Use only lowercase English letters, numbers, and hyphens
2. Length must be 2 to 12 characters
3. Prefer a transliteration or abbreviation of the name
4. Output the ID directly, no explanation

Examples:
- "G-SAP Balance" -> "gsap-balance"
- "銉熴偗" -> "miku"
- "Helper" -> "helper"
- "Alice" -> "alice"`,
        },
        { role: "user", content: name },
      ],
      max_tokens: 20,
      usageLedger: utilConfig.usageLedger,
      usageContext: utilityUsageContext(utilConfig, "generate_agent_id", "manual"),
    });

    base = sanitizeAgentId(text);
  } catch (err) {
    console.error("[llm-utils] generateAgentId LLM failed:", err.message);
  }

  if (base.length < 2) {
    base = sanitizeAgentId(name);
  }

  if (base.length >= 2) {
    const available = findAvailableAgentId(base, agentsDir);
    if (available) return available;
  }

  let fallback = `agent-${Date.now().toString(36)}`;
  while (fs.existsSync(path.join(agentsDir, fallback))) {
    fallback = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
  }
  return fallback;
}

/*
async function generateAgentIdLegacy(utilConfig, name, agentsDir) {
  try {
    const isZh = getLocale().startsWith("zh");
    const { utility: model, api_key, base_url, api } = utilConfig;
    const text = await callLlm({
      model, api, api_key, base_url,
      messages: [
        {
          role: "system",
          content: isZh
            ? `Given an assistant display name, generate a short lowercase English ID for use as a folder name.
Rules:
1. Lowercase English letters only; hyphens are allowed
2. 2-12 characters
3. Prefer a transliteration or abbreviation of the name
4. Output the ID directly, with no explanation

Examples:
- "G-SAP Balance" -> "gsap-balance"
- "Miku" -> "miku"
- "Helper" -> "helper"
- "Alice" -> "alice"`
            : `Given an assistant's display name, generate a short lowercase English ID (for use as a folder name).
Rules:
1. Lowercase English letters only, hyphens allowed
2. 2-12 characters
3. Prefer a transliteration or abbreviation of the name
4. Output the ID directly, no explanation

Examples:
- "G-SAP Balance" -> "gsap-balance"
- "Miku" -> "miku"
- "Helper" -> "helper"
- "Alice" -> "alice"`,
        },
        { role: "user", content: name },
      ],
      max_tokens: 20,
    });

    if (text) {
      const id = text.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 12);
      if (id.length >= 2 && !fs.existsSync(path.join(agentsDir, id))) {
        return id;
      }
    }
  } catch (err) {
    console.error("[llm-utils] generateAgentId LLM failed:", err.message);
  }
  return `agent-${Date.now().toString(36)}`;
}
*/

/**
 * -agent 生成能力描述摘要
  *
  *
 * @returns {Promise<string|null>}
 */
export async function generateDescription(utilConfig, personality, locale) {
  try {
    const { utility: model, api_key, base_url, api } = utilConfig;
    if (!api_key || !base_url || !api) return null;

    const isZh = String(locale || "").startsWith("zh");
    const systemContent = isZh
      ? "根据以下 AI agent 的人格设定，写一段 100 字以内的能力描述。覆盖人格特征、专长领域、沟通风格和适合的任务类型。纯文本，不要 markdown，直接输出描述，不要解释。"
      : "Based on the following AI agent persona, write a capability description in under 100 characters. Cover: personality traits, expertise, communication style, suitable tasks. Plain text, no markdown. Output the description directly, no explanation.";

    const raw = await callLlm({
      model, api, api_key, base_url,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: personality.slice(0, 3000) },
      ],
      temperature: 0.3,
      max_tokens: 200,
      usageLedger: utilConfig.usageLedger,
      usageContext: utilityUsageContext(utilConfig, "generate_description", "manual"),
    });
    if (!raw) return null;

    const text = raw.trim();
    if (text.length <= 100) return text;
    const cutIdx = Math.max(
      text.lastIndexOf("。", 100),
      text.lastIndexOf(".", 100),
    );
    return cutIdx > 20 ? text.slice(0, cutIdx + 1) : text.slice(0, 100);
  } catch (err) {
    console.error("[llm-utils] generateDescription failed:", err.message);
    return null;
  }
}
