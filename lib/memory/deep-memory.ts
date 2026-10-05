// @ts-nocheck
/**
  *
  *
 * 通过 snapshot diff 发现新增内容，调 LLM 拆成元事-+ 打标签，
  *
  * */

import { callText } from "../../core/llm-client.ts";
import { getLocale } from "../i18n.ts";
import { attachPromptLayoutMetadata, buildUtilityPromptLayout } from "../llm/prompt-layout.ts";
import { buildFactExtractionPrompt as buildFactExtractionPromptSpec } from "./prompts/fact-extraction.ts";
import {
  buildFactTimeContext,
  normalizeFactTime,
  resolveMemoryTimeZone,
} from "./time-context.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("deep-memory");

const MAX_RETRIES = 3;
const MAX_CONCURRENT = 3;
const _failCounts = new Map(); // session -> { count, lastUpdated }
const FAIL_COUNT_TTL_MS = 60 * 60 * 1000;

function cleanExpiredFailCounts() {
  const cutoff = Date.now() - FAIL_COUNT_TTL_MS;
  for (const [k, v] of _failCounts) {
    if (v.lastUpdated < cutoff) _failCounts.delete(k);
  }
}

/**
  *
 *
 * @param {import('./session-summary.ts').SessionSummaryManager} summaryManager
 * @param {import('./fact-store.ts').FactStore} factStore
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<{ processed: number, factsAdded: number }>}
 */
export async function processDirtySessions(summaryManager, factStore, resolvedModel, opts = {}) {
  const dirty = summaryManager.getDirtySessions({ since: opts.since || null });
  if (dirty.length === 0) {
    return { processed: 0, factsAdded: 0 };
  }

  log.log(`${dirty.length} dirty sessions pending`);

  let totalFacts = 0;

  const processOne = async (session) => {
    try {
      const sourceTimeRange = !session?.source_time_range && typeof opts.getSourceTimeRange === "function"
        ? await opts.getSourceTimeRange(session.session_id)
        : null;
      const sessionForTime = sourceTimeRange
        ? { ...session, source_time_range: sourceTimeRange }
        : session;
      const timeContext = buildFactTimeContext(sessionForTime, { timeZone: opts.timeZone });
      const facts = await extractFactsFromDiff(
        session.summary,
        session.snapshot || "",
        resolvedModel,
        timeContext,
      );

      if (facts.length > 0) {
        factStore.addBatch(
          facts.map((f) => ({
            fact: f.fact,
            tags: f.tags || [],
            time: f.time || null,
            session_id: session.session_id,
          })),
        );
        totalFacts += facts.length;
        log.log(
          `${session.session_id.slice(0, 8)}...: ${facts.length} 条元事实`,
        );
      }

      summaryManager.markProcessed(session.session_id);
      _failCounts.delete(session.session_id);
    } catch (err) {
      cleanExpiredFailCounts();
      const prev = _failCounts.get(session.session_id);
      const count = (prev?.count || 0) + 1;
      _failCounts.set(session.session_id, { count, lastUpdated: Date.now() });

      if (count >= MAX_RETRIES) {
        log.error(
          `${session.session_id.slice(0, 8)}... 连续失败 ${count} 次，标记跳过: ${err.message}`,
        );
        summaryManager.markProcessed(session.session_id);
        _failCounts.delete(session.session_id);
      } else {
        log.error(
          `处理失败 (${session.session_id.slice(0, 8)}... ${count}/${MAX_RETRIES}): ${err.message}`,
        );
      }
    }
  };

 //
  for (let i = 0; i < dirty.length; i += MAX_CONCURRENT) {
    const batch = dirty.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(batch.map(processOne));
  }

  log.log(`Completed: ${dirty.length} sessions, ${totalFacts} new facts`);
  return { processed: dirty.length, factsAdded: totalFacts };
}

/**
 * 从摘-diff 中提取元事实
 *
 * @param {string} currentSummary - 当前摘要全文
 * @param {string} previousSnapshot - 上次处理时的摘要快照
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<Array<{ fact: string, tags: string[], time: string }>>}
 */
async function extractFactsFromDiff(currentSummary, previousSnapshot, resolvedModel, timeContext = null) {
  const { model: utilityModel, api, api_key, base_url } = resolvedModel;

  const hasPrevious = !!previousSnapshot;

  const isZh = getLocale().startsWith("zh");

  let userContent;
  const timeContextBlock = buildTimeContextBlock(timeContext, isZh);
  if (hasPrevious) {
    const prevLabel = isZh ? "## 上次快照" : "## Previous Snapshot";
    const currLabel = isZh ? "## 当前摘要" : "## Current Summary";
    userContent = `${timeContextBlock}\n\n${prevLabel}\n\n${previousSnapshot}\n\n${currLabel}\n\n${currentSummary}`;
  } else {
    const label = isZh ? "## 摘要内容" : "## Summary Content";
    userContent = `${timeContextBlock}\n\n${label}\n\n${currentSummary}`;
  }

  const promptSpec = buildFactExtractionPromptSpec({ locale: getLocale(), hasPrevious });
  const layout = buildUtilityPromptLayout({
    cacheGroup: promptSpec.cacheGroup,
    templateVersion: promptSpec.templateVersion,
    systemPrompt: promptSpec.systemPrompt + buildFactExtractionPolicyOverride(),
    userContent,
  });
  const usageContext = attachPromptLayoutMetadata({
    source: {
      subsystem: "memory",
      operation: "extract_facts",
      surface: "system",
      trigger: "daily",
    },
    attribution: {
      kind: "memory",
      agentId: resolvedModel.usageAgentId || null,
    },
  }, layout.usageMetadata);

  const raw = await callText({
    api, model: utilityModel,
    apiKey: api_key,
    baseUrl: base_url,
    systemPrompt: layout.systemPrompt,
    messages: layout.messages,
    temperature: 0.3,
    maxTokens: 4096,
    timeoutMs: 60_000,
    usageLedger: resolvedModel.usageLedger,
    usageContext,
  });

 // 兼容 markdown 代码块包裹（提取最外层 fence 之间的内容）
  const fenceMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  const jsonStr = (fenceMatch ? fenceMatch[1] : raw).trim();

  try {
    const facts = JSON.parse(jsonStr);
    if (!Array.isArray(facts)) return [];
    return facts
      .filter((f) => f && typeof f.fact === "string" && f.fact.length > 0)
      .map((f) => ({
        ...f,
        time: normalizeFactTime(f.time, timeContext || {}),
      }));
  } catch {
    log.error(`JSON 解析失败: ${jsonStr.slice(0, 200)}`);
    return [];
  }
}

function buildTimeContextBlock(timeContext, isZh) {
  const context = timeContext || {};
  const sourceRange = context.sourceRange || {};
  const timezone = resolveMemoryTimeZone(context.timezone);
  const unknown = isZh ? "未知" : "unknown";
  const localDates = Array.isArray(context.localDates) && context.localDates.length > 0
    ? context.localDates.join(", ")
    : unknown;
  const range = sourceRange.start || sourceRange.end
    ? `${sourceRange.start || "?"} -> ${sourceRange.end || "?"}`
    : unknown;
  const summaryDateTimes = Array.isArray(context.summaryDateTimes) && context.summaryDateTimes.length > 0
    ? context.summaryDateTimes.join(", ")
    : isZh ? "无" : "none";

  if (isZh) {
    return `## 时间上下文

- 时区: ${timezone}
- 会话来源时间范围: ${range}
- 会话来源本地日期: ${localDates}
- 摘要中明确出现的完整时间: ${summaryDateTimes}

时间规则: 只允许使用本时间上下文或摘要正文中明确出现的日期。摘要只有 HH:MM 且会话来源只有一个本地日期时，才能把该日期和 HH:MM 合成 time；摘要跨多个本地日期且只有 HH:MM 时，time 填 null。不要从输出格式示例或说明文字中推断日期。`;
  }

  return `## Time Context

- Timezone: ${timezone}
- Source time range: ${range}
- Source local dates: ${localDates}
- Explicit full timestamps in summary: ${summaryDateTimes}

Time rule: use only dates from this time context or dates explicitly present in the summary text. If the summary has HH:MM only and the source has exactly one local date, combine that date with HH:MM; if the source spans multiple local dates and the summary has HH:MM only, use null. Do not infer dates from output-format examples or explanatory text.`;
}

function buildFactExtractionPolicyOverride() {
  return `\n\n## Memory Fact Scope Override\n- 只提取用户画像和粗颗粒近况。禁止提取工作方式偏好、协作流程偏好、工具偏好、项目工程规则、助手执行规则、文件名、命令、测试、发布、commit、push 或其他执行细节。\n- 如果一条事实描述的是“以后遇到类似任务应该怎么做”，它属于项目说明、经验库或 skill，不属于记忆事实。\n- Extract only user-profile and coarse current-state facts: identity, traits, aesthetics, interests, likes/dislikes, long-term relationships, life orientation, and broad current themes.\n- Do not extract work-style preferences, collaboration-process preferences, tool preferences, project engineering rules, assistant execution rules, filenames, commands, tests, releases, commits, pushes, or other execution details.\n- If a fact describes how to handle similar tasks in the future, it belongs in explicit project instructions, an experience library, or a skill, not memory facts.\n- If a fact describes a concrete subproblem, concrete solution, or concrete change inside a theme, do not extract it.\n- The time field must use YYYY-MM-DDTHH:MM only when supported by the summary body or Time Context. Use null when the source spans multiple local dates and the summary only has HH:MM.\n- Use broad themes such as "the user has recently been focused on memory systems" or "the user worked on G-SAP" instead of detailed execution records.`;
}
