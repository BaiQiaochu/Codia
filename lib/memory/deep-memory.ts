// @ts-nocheck
/**
  *
 * 通过 snapshot diff 发现新增内容，调 LLM 拆成元事-+ 打标签，
  *
  * */

import { deferExtractionForBudget } from "./retention-policy.ts";
import { createHash } from "node:crypto";
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

export const FACT_EXTRACTOR_VERSION = "facts.v2";
const MAX_CONCURRENT = 3;
export function summarySourceRevision(session) {
  return createHash("sha256").update(JSON.stringify([session.session_id, session.summary, session.sourceRefs || [], session.projectId || null])).digest("hex");
}

/** Facts and the authoritative extraction receipt commit in one SQLite transaction. */
export async function processDirtySessions(summaryManager, factStore, resolvedModel, opts = {}) {
  const dirty = summaryManager.getDirtySessions({ since: opts.since || null });
  const result = { processed: 0, succeeded: 0, failed: 0, skipped: 0, quarantined: 0, deferred: 0, factsAdded: 0 };
  const processOne = async (session) => {
    if (opts.isSessionEnabled?.(session) === false) { result.skipped++; result.deferred++; return; }
    if (opts.isEnabled && !opts.isEnabled()) { result.skipped++; return; }
    const sourceRevision = summarySourceRevision(session);
    const key = createHash("sha256").update(`${session.session_id}:${sourceRevision}:${FACT_EXTRACTOR_VERSION}`).digest("hex");
    // Compatibility for external legacy stores; production FactStore always owns the durable ledger.
    const durable = typeof factStore.beginExtraction === "function";
    const claim = durable ? factStore.beginExtraction(key, {
      sessionId: session.session_id, sourceRevision, extractorVersion: FACT_EXTRACTOR_VERSION,
      sourceRefs: session.sourceRefs || [], projectId: session.projectId || null,
    }, opts) : { status: "running", generation: factStore.generation };
    if (claim.status !== "running") {
      result.skipped++;
      if (claim.status === "quarantined") result.quarantined++;
      if (["deferred", "busy"].includes(claim.status)) result.deferred++;
      if (claim.status === "succeeded") summaryManager.markProcessed(session.session_id, sourceRevision, session.summary);
      return;
    }
    try {
      const sourceTimeRange = !session?.source_time_range && typeof opts.getSourceTimeRange === "function"
        ? await opts.getSourceTimeRange(session.session_id) : null;
      const timeContext = buildFactTimeContext(sourceTimeRange ? { ...session, source_time_range: sourceTimeRange } : session, { timeZone: opts.timeZone });
      const facts = await extractFactsFromDiff(session.summary, session.snapshot || "", { ...resolvedModel, usageJobId: key, usageSessionId: session.session_id }, timeContext);
      if (opts.isEnabled && !opts.isEnabled()) throw new Error("Memory learning paused during extraction");
      const latest = summaryManager.getSummary?.(session.session_id);
      if (latest && summarySourceRevision(latest) !== sourceRevision) throw new Error("Source summary changed during extraction; retry the newer revision");
      const entries = facts.map(f => ({
        fact: f.fact, tags: f.tags || [], time: f.time || null, session_id: session.session_id,
        ...(durable ? {
          sourceRefs: session.sourceRefs?.length ? session.sourceRefs : [{ kind: "session", sessionId: session.session_id, revision: sourceRevision }],
          sourceRevision, extractorVersion: FACT_EXTRACTOR_VERSION,
          projectId: session.projectId || null, channelId: session.channelId || null,
          observedAt: session.updated_at || new Date().toISOString(),
          // Extracted assertions are not evidence of verification or permission.
          reviewStatus: "unverified", status: "candidate",
        } : {}),
      }));
      if (opts.isSessionEnabled?.(session) === false) throw new Error('Session memory environment became ambiguous during extraction');
      const committed = durable ? factStore.commitExtraction(key, entries, claim) : { factsAdded: factStore.addBatch(entries) ?? entries.length };
      result.factsAdded += committed.factsAdded;
      result.succeeded++;
      result.processed++;
      // A failed JSON/cache write cannot undo a durable receipt or cause duplicate inserts.
      try { summaryManager.markProcessed(session.session_id, sourceRevision, session.summary); }
      catch { log.warn("Extraction committed; summary cache will be reconciled on retry"); }
    } catch (err) {
      if (deferExtractionForBudget(factStore, key, claim, err)) { result.deferred++; return; }
      const status = durable ? factStore.failExtraction(key, err, claim, opts) : "failed";
      result.failed++;
      if (status === "quarantined") result.quarantined++;
      log.error(`Extraction failed for ${session.session_id}: ${err?.code || "invalid_or_failed_extraction"}`);
    }
  };
  for (let i = 0; i < dirty.length; i += MAX_CONCURRENT) await Promise.all(dirty.slice(i, i + MAX_CONCURRENT).map(processOne));
  return result;
}

/**
 * 从摘-diff 中提取元事实
 *
 * @param {string} currentSummary - 当前摘要全文
 * @param {string} previousSnapshot - 上次处理时的摘要快照
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<Array<{ fact: string, tags: string[], time: string }>>}
 */
export async function extractFactsFromDiff(currentSummary, previousSnapshot, resolvedModel, timeContext = null) {
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
      jobId: resolvedModel.usageJobId || null, sessionId: resolvedModel.usageSessionId || null,
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

  let facts;
  try { facts = JSON.parse(jsonStr); }
  catch { throw Object.assign(new Error("Fact extraction returned invalid JSON"), { code: "INVALID_EXTRACTION_JSON" }); }
  if (!Array.isArray(facts) || facts.some(f => !f || typeof f.fact !== "string" || !f.fact.trim() || (f.tags !== undefined && (!Array.isArray(f.tags) || f.tags.some(tag => typeof tag !== "string"))))) {
    throw Object.assign(new Error("Fact extraction returned an invalid fact schema"), { code: "INVALID_EXTRACTION_SCHEMA" });
  }
  return facts.map(f => ({ fact: f.fact.trim(), tags: f.tags || [], time: normalizeFactTime(f.time, timeContext || {}) }));
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
  return `\n\n## Memory Fact Scope Override\n- 只提取用户画像和粗颗粒近况。禁止提取工作方式偏好、协作流程偏好、工具偏好、项目工程规则、助手执行规则、文件名、命令、测试、发布、commit、push 或其他执行细节。\n- 如果一条事实描述的是“以后遇到类似任务应该怎么做”，它属于项目说明、经验库或 skill，不属于记忆事实。\n- Extract only user-profile and coarse current-state facts: identity, traits, aesthetics, interests, likes/dislikes, long-term relationships, life orientation, and broad current themes.\n- Do not extract work-style preferences, collaboration-process preferences, tool preferences, project engineering rules, assistant execution rules, filenames, commands, tests, releases, commits, pushes, or other execution details.\n- If a fact describes how to handle similar tasks in the future, it belongs in explicit project instructions, an experience library, or a skill, not memory facts.\n- If a fact describes a concrete subproblem, concrete solution, or concrete change inside a theme, do not extract it.\n- The time field must use YYYY-MM-DDTHH:MM only when supported by the summary body or Time Context. Use null when the source spans multiple local dates and the summary only has HH:MM.\n- Use broad themes such as "the user has recently been focused on memory systems" or "the user worked on Codia" instead of detailed execution records.`;
}
