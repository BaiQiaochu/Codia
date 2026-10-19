// @ts-nocheck
/**
  *
 * 摘要通过 rollingSummary() 滚动更新（覆盖式，非追加），
  *
  * */

import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../shared/safe-fs.ts";
import { scrubPII } from "../pii-guard.ts";
import { callText } from "../../core/llm-client.ts";
import { getToolArgs, isToolCallBlock } from "../../core/llm-utils.ts";
import { getLocale } from "../i18n.ts";
import { readCompiledResetAt, readCompiledGeneration, assertCompiledGeneration, isCompiledMemoryEligible } from "./compiled-memory-state.ts";
import { attachPromptLayoutMetadata, buildUtilityPromptLayout } from "../llm/prompt-layout.ts";
import {
  buildSourceTimeRange,
  formatZonedDateTime,
  resolveMemoryTimeZone,
} from "./time-context.ts";
import { captureMemoryEvidenceEpoch, assertMemoryEvidenceEpoch, guardMemoryContext } from "./prompt-guard.ts";
import { memoryContentHash, scrubMemorySecrets } from "./memory-lifecycle.ts";
import { createModuleLogger } from "../debug-log.ts";
import { withMemoryReasoningBuffer } from "./llm-budget.ts";
import {
  MAX_ROLLING_SUMMARY_FORMAT_REPAIRS,
  buildRollingSummaryRepairInput,
  buildRollingSummaryRepairPrompt,
  validateRollingSummaryFormat,
} from "./rolling-summary-format.ts";

const log = createModuleLogger("session-summary");

export class SessionSummaryManager {
  /**
 * @param {string} summariesDir - summaries/ 目录的绝对路- */
  constructor(summariesDir) {
    this.summariesDir = summariesDir;
    this.memoryDir = path.dirname(summariesDir);
    this.agentDir = path.basename(this.memoryDir) === "memory" ? path.dirname(this.memoryDir) : this.memoryDir;
    this._generation = readCompiledGeneration(this.memoryDir);
    fs.mkdirSync(summariesDir, { recursive: true });
    this._cache = new Map();          // sessionId -> summary data
    this._cachePopulated = false;     // 是否已做过全量扫描
    this._cachePopulated = false;     }

  // ════════════════════════════
 // 读写
  // ════════════════════════════

  /**
  *
   * @returns {object|null}
   */
  getSummary(sessionId) {
    this._checkGeneration();
    if (this._cache.has(sessionId)) {
      const cached = this._cache.get(sessionId);
      if (this._isCurrent(cached)) return cached;
      this._cache.delete(sessionId);
      return null;
    }
    const fp = this._filePath(sessionId);
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      if (!this._isCurrent(data)) return null;
      this._cache.set(sessionId, data);
      return data;
    } catch {
      return null;
    }
  }

  /**
 * 写入摘要（原子写入）
   * @param {string} sessionId
   * @param {object} data
   */
  saveSummary(sessionId, data) {
    this._checkGeneration();
    if (data.memoryGeneration !== undefined) assertCompiledGeneration(this.memoryDir, data.memoryGeneration);
    if (data.memoryEvidenceEpoch) assertMemoryEvidenceEpoch(this.agentDir, data.memoryEvidenceEpoch);
    if (!this._isCurrent(data)) return false;
    data = { ...data, summary: scrubMemorySecrets(data.summary || ""), snapshot: scrubMemorySecrets(data.snapshot || "") };
    const fp = this._filePath(sessionId);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    atomicWriteSync(fp, JSON.stringify(data, null, 2) + "\n");
    this._cache.set(sessionId, data);
  }

  // ════════════════════════════
 // -session 追踪（供深度记忆用）
  // ════════════════════════════

  /**
  *
   */
  getDirtySessions(opts = {}) {
    this._ensureCachePopulated();
    const since = normalizeSince(opts.since);
    const dirty = [];
    for (const data of this._cache.values()) {
      if (!data?.summary || !this._isCurrent(data)) continue;
      if (since && !isAfter(data.updated_at || data.created_at, since)) continue;
      if (data.summary !== (data.snapshot || "")) {
        dirty.push(data);
      }
    }
    return dirty;
  }

  /**
 * 标记 session 已被深度记忆处理（snapshot = summary- * @param {string} sessionId
   */
  markProcessed(sessionId, sourceRevision = null, expectedSummary = null) {
    const data = this.getSummary(sessionId);
    if (!data || (expectedSummary !== null && data.summary !== expectedSummary)) return false;

    data.extractedSourceRevision = sourceRevision;
    data.snapshot = data.summary;
    data.snapshot_at = new Date().toISOString();
    this.saveSummary(sessionId, data);
  }

  // ════════════════════════════
  //
  // ════════════════════════════

  /**
  *
   */
  getAllSummaries() {
    this._ensureCachePopulated();
    const summaries = [];
    for (const data of this._cache.values()) {
      if (data?.summary && this._isCurrent(data)) summaries.push(data);
    }
    summaries.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    return summaries;
  }

 /** */
  _ensureCachePopulated() {
    this._checkGeneration();
    if (this._cachePopulated) return;
    const files = this._listFiles();
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (data?.session_id && this._isCurrent(data)) this._cache.set(data.session_id, data);
      } catch {}
    }
    this._cachePopulated = true;
  }

  /**
 * 获取指定日期范围内的摘要
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Array<object>}
   */
  getSummariesInRange(startDate, endDate, opts = {}) {
    const startISO = startDate.toISOString();
    const endISO = endDate.toISOString();
    const since = normalizeSince(opts.since);

    return this.getAllSummaries().filter((s) => {
      const updated = s.updated_at || s.created_at || "";
      if (updated < startISO || updated > endISO) return false;
      if (since && !isAfter(updated, since)) return false;
      return true;
    });
  }

  _isCurrent(data) {
    const resetAt = readCompiledResetAt(this.memoryDir);
    if (data.memoryGeneration !== undefined && data.memoryGeneration !== readCompiledGeneration(this.memoryDir)) return false;
    if (resetAt && !isAfter(data.updated_at || data.created_at, resetAt)) return false;
    const current = this._evidenceEpoch || captureMemoryEvidenceEpoch(this.agentDir);
    const expected = data.memoryEvidenceEpoch;
    if (!expected) return !this._hasDestructiveEvidence(current) && isCompiledMemoryEligible(this.memoryDir);
    if (["lifecycleGeneration", "compiledGeneration", "experienceGeneration"].some(key => expected[key] !== current[key])) return false;
    return !expected.expiresAt || (Number.isFinite(Date.parse(expected.expiresAt)) && Date.parse(expected.expiresAt) > Date.now());
  }

  _hasDestructiveEvidence(epoch) {
    return epoch.lifecycleGeneration !== "0" || epoch.experienceGeneration !== "0" || !!readCompiledResetAt(this.memoryDir);
  }

  _checkGeneration() {
    const current = readCompiledGeneration(this.memoryDir);
    const evidence = captureMemoryEvidenceEpoch(this.agentDir);
    const previous = this._evidenceEpoch;
    if (current !== this._generation || (previous && ["lifecycleGeneration", "compiledGeneration", "experienceGeneration"].some(key => previous[key] !== evidence[key]))) this.clearCache();
    this._generation = current;
    this._evidenceEpoch = evidence;
  }

  clearCache() {
    this._cache.clear();
    this._cachePopulated = false;
  }

  clearAll() {
    fs.mkdirSync(this.summariesDir, { recursive: true });
    for (const file of this._listFiles()) {
      try { fs.unlinkSync(file); } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    }
    this.clearCache();
  }

  // ════════════════════════════
  //  内部
  // ════════════════════════════

  _filePath(sessionId) {
 // session 文件名可能包含时间戳前缀（如 1234567890_uuid），
 //
    const cleanId = sessionId.replace(/\.jsonl$/, "");
    return path.join(this.summariesDir, `${cleanId}.json`);
  }

  _listFiles() {
    try {
      return fs.readdirSync(this.summariesDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(this.summariesDir, f));
    } catch {
      return [];
    }
  }

  /**
 * 从消息列表构建带时间戳的对话文本
    *
   * @returns {string}
   */
  _buildConversationText(messages, opts = {}) {
    const parts = [];
    const isZh = getLocale().startsWith("zh");
    const timeZone = resolveMemoryTimeZone(opts.timeZone);

    for (const msg of messages) {
      const segments = this._extractSummarySegments(msg, isZh);
      if (segments.length === 0) continue;

 // 时间标注
      let timePrefix = "";
      if (msg.timestamp) {
        const d = new Date(msg.timestamp);
        if (!isNaN(d.getTime())) {
          timePrefix = `[${formatZonedDateTime(d, timeZone)}] `;
        }
      }

      const speaker = msg.role === "user" ? (isZh ? "用户" : "User") : (isZh ? "助手" : "Assistant");
      for (const segment of segments) {
        parts.push(`${timePrefix}【${speaker}】${segment}`);
      }
    }

    return parts.join("\n\n");
  }

  _extractSummarySegments(msg, isZh) {
    if (!msg?.content) return [];

    if (typeof msg.content === "string") {
      const text = msg.content.trim();
      return text ? [text] : [];
    }

    if (!Array.isArray(msg.content)) return [];

    const segments = [];
    let textBuffer = "";
    const flushText = () => {
      const text = textBuffer.trim();
      if (text) segments.push(text);
      textBuffer = "";
    };

    for (const block of msg.content) {
      if (block?.type === "text" && block.text) {
        textBuffer += block.text;
        continue;
      }

      if (msg.role === "assistant" && isToolCallBlock(block)) {
        flushText();
        const title = this._summarizeToolCall(block, isZh);
        if (title) segments.push(title);
      }
    }

    flushText();
    return segments;
  }

  _summarizeToolCall(block, isZh) {
    const name = String(block?.name || "").trim();
    if (!name) return "";
    const args = getToolArgs(block) && typeof getToolArgs(block) === "object" ? getToolArgs(block) : {};
    const pick = (...keys) => {
      for (const key of keys) {
        const value = args[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return "";
    };
    const shorten = (text, limit = 120) => {
      if (!text) return "";
      return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
    };

    switch (name) {
      case "read":
      case "read_file":
        return isZh ? `读取了 ${pick("file_path", "path")}` : `Read ${pick("file_path", "path")}`;
      case "write":
        return isZh ? `写入了 ${pick("file_path", "path")}` : `Wrote ${pick("file_path", "path")}`;
      case "edit":
      case "edit-diff":
        return isZh ? `修改了 ${pick("file_path", "path")}` : `Edited ${pick("file_path", "path")}`;
      case "bash":
        return isZh ? `执行了命令 ${shorten(pick("command"), 80)}` : `Ran command ${shorten(pick("command"), 80)}`;
      case "glob":
      case "find":
        return isZh ? `查找了 ${shorten(pick("pattern"), 80)}` : `Searched for ${shorten(pick("pattern"), 80)}`;
      case "grep": {
        const pattern = shorten(pick("pattern"), 60);
        const target = pick("path");
        return isZh
          ? `搜索了 ${pattern}${target ? `（范围 ${target}）` : ""}`
          : `Searched ${pattern}${target ? ` in ${target}` : ""}`;
      }
      case "ls":
        return isZh ? `查看了 ${pick("path")}` : `Listed ${pick("path")}`;
      case "web_fetch":
        return isZh ? `读取了网页 ${pick("url")}` : `Fetched ${pick("url")}`;
      case "web_search":
        return isZh ? `搜索了 ${shorten(pick("query"), 80)}` : `Searched ${shorten(pick("query"), 80)}`;
      case "browser": {
        const action = pick("action");
        const url = pick("url");
        const detail = url || action;
        return isZh ? `操作了浏览器${detail ? `（${detail}）` : ""}` : `Used browser${detail ? ` (${detail})` : ""}`;
      }
      case "search_memory":
        return isZh ? `搜索了记忆 ${shorten(pick("query"), 80)}` : `Searched memory ${shorten(pick("query"), 80)}`;
      case "subagent":
        return isZh ? `启动了子代理${pick("task", "prompt") ? `：${shorten(pick("task", "prompt"), 80)}` : ""}` : `Started subagent${pick("task", "prompt") ? `: ${shorten(pick("task", "prompt"), 80)}` : ""}`;
      case "dm":
        return isZh ? `发送了私信${pick("to") ? ` 给 ${pick("to")}` : ""}` : `Sent DM${pick("to") ? ` to ${pick("to")}` : ""}`;
      case "channel":
        return isZh ? `操作了频道 ${pick("channel", "name")}` : `Used channel ${pick("channel", "name")}`;
      case "cron":
        return isZh ? `设置了定时任务${pick("label", "prompt") ? `：${shorten(pick("label", "prompt"), 80)}` : ""}` : `Scheduled task${pick("label", "prompt") ? `: ${shorten(pick("label", "prompt"), 80)}` : ""}`;
      case "notify":
        return isZh ? `发送了通知${pick("title") ? `：${shorten(pick("title"), 80)}` : ""}` : `Sent notification${pick("title") ? `: ${shorten(pick("title"), 80)}` : ""}`;
      case "artifact":
        return isZh ? `生成了产物${pick("title") ? `：${shorten(pick("title"), 80)}` : ""}` : `Generated artifact${pick("title") ? `: ${shorten(pick("title"), 80)}` : ""}`;
      case "install_skill":
        return isZh ? `安装了技能 ${pick("skill_name")}` : `Installed skill ${pick("skill_name")}`;
      case "update_settings":
        return isZh ? `修改了设置 ${pick("key", "setting")}` : `Updated setting ${pick("key", "setting")}`;
      default: {
        const detail = shorten(
          pick("file_path", "path", "query", "url", "command", "pattern", "prompt", "label", "title"),
          80,
        );
        return isZh
          ? `调用了 ${name}${detail ? `：${detail}` : ""}`
          : `Called ${name}${detail ? `: ${detail}` : ""}`;
      }
    }
  }

  // ════════════════════════════
  //  滚动摘要
  // ════════════════════════════

  /**
   * 滚动更新 session 摘要：每 10 轮或 session 结束时触发。
   * 若有旧摘要则将旧摘要 + 新对话合并产出新摘要（覆盖，非追加）；
   * 若无旧摘要则直接从对话生成。
   * 输出格式固定为两节：### 重要事实 + ### 事情经过。
   *
   * @param {string} sessionId
    *
   * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
   * @returns {Promise<string>} 更新后的摘要文本
   */
  async rollingSummary(sessionId, messages, resolvedModel, opts: Record<string, any> = {}) {
    const draft = await this.createRollingSummaryDraft(sessionId, messages, resolvedModel, opts);
    if (draft?.data) {
      this.saveSummary(sessionId, draft.data);
    }
    return draft?.summary || "";
  }

  /**
   * 生成 legacy utility rolling summary 草稿但不落盘。
   * session_snapshot memory reflection 走 live session side-task runner，
   * 不通过这个 utility_template 冷路径。
   *
   * @param {string} sessionId
    *
   * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
    *
   */
  async createRollingSummaryDraft(sessionId, messages, resolvedModel, opts = {}) {
    const generation = readCompiledGeneration(this.memoryDir);
    const resetAt = latestSince(opts.resetAt, readCompiledResetAt(path.dirname(this.summariesDir)));
    if (resetAt) messages = messages.filter(message => message.timestamp && isAfter(message.timestamp, resetAt));
    // Scrub stale tool returns and imported compaction/branch summaries before any
    // source text is sent to the rolling-summary model. Source chats remain untouched.
    const guardedContext = guardMemoryContext({ systemPrompt: "", messages }, this.agentDir);
    messages = guardedContext.messages.filter(message => message.details?.revoked !== true);
    const existingRaw = this.getSummary(sessionId);
    const existing = resetAt && existingRaw && !isAfter(existingRaw.updated_at || existingRaw.created_at, resetAt)
      ? null
      : existingRaw;
    const prevSummary = existing?.summary || "";
    let memoryEvidenceEpoch = captureMemoryEvidenceEpoch(this.agentDir, { messages: [
      ...messages,
      ...(existing ? [{ role: "compactionSummary", summary: prevSummary, details: { memoryEvidenceEpoch: existing.memoryEvidenceEpoch } }] : []),
    ] });
    let memoryReflectionSnapshot = opts.memoryReflectionSnapshot;
    if (memoryReflectionSnapshot) {
      let stale = !memoryReflectionSnapshot.memoryEvidenceEpoch
        && (this._hasDestructiveEvidence(memoryEvidenceEpoch) || !isCompiledMemoryEligible(this.memoryDir));
      if (memoryReflectionSnapshot.memoryEvidenceEpoch) {
        try { assertMemoryEvidenceEpoch(this.agentDir, memoryReflectionSnapshot.memoryEvidenceEpoch); } catch { stale = true; }
      }
      if (stale) memoryReflectionSnapshot = { ...memoryReflectionSnapshot, existingMemory: "", userProfile: "" };
      else if (memoryReflectionSnapshot.memoryEvidenceEpoch) memoryEvidenceEpoch = captureMemoryEvidenceEpoch(this.agentDir, { messages: [
        { role: "compactionSummary", details: { memoryEvidenceEpoch } },
        { role: "compactionSummary", details: { memoryEvidenceEpoch: memoryReflectionSnapshot.memoryEvidenceEpoch } },
      ] });
    }

 //
    const lastMessageCount = existing?.messageCount || 0;
    const newMessages = lastMessageCount > 0 && lastMessageCount < messages.length
      ? messages.slice(lastMessageCount)
      : messages; // 旧数据无 messageCount 时 fallback 到全量
    const timeZone = resolveMemoryTimeZone(opts.timeZone);
    const sourceTimeRange = buildSourceTimeRange(messages, { timeZone });
    const convText = this._buildConversationText(newMessages, { timeZone });
    if (!convText) {
      return {
        summary: prevSummary,
        changed: false,
        data: null,
        usage: null,
        reason: "empty_conversation",
      };
    }

 // 按全量用户轮数计算摘要配额（预算反映对话整体体量，输入只传增量）
    const turnCount = messages.filter((m) => m.role === "user").length;
    const llmResult = await this._callRollingLLM(convText, prevSummary, resolvedModel, turnCount, {
      memoryReflectionSnapshot,
      returnUsage: opts.returnUsage,
      usageTrigger: opts.usageTrigger,
    });
    let usage = typeof llmResult === "object" && llmResult !== null ? llmResult.usage || null : null;
    const evidenceStillCurrent = () => {
      if (readCompiledGeneration(this.memoryDir) !== generation) return false;
      try { assertMemoryEvidenceEpoch(this.agentDir, memoryEvidenceEpoch); return true; } catch { return false; }
    };
    if (!evidenceStillCurrent()) return { summary: "", changed: false, data: null, usage, reason: "evidence_changed" };
    let newSummary = typeof llmResult === "object" && llmResult !== null ? llmResult.text : llmResult;
    if (!newSummary?.trim()) {
      return {
        summary: prevSummary,
        changed: false,
        data: null,
        usage,
        reason: "empty_output",
      };
    }

    let repairsUsed = 0;
    let validation = validateRollingSummaryFormat(newSummary);
    while (!validation.ok && repairsUsed < MAX_ROLLING_SUMMARY_FORMAT_REPAIRS) {
      repairsUsed += 1;
      log.warn(`rolling summary format invalid for ${sessionId} (${validation.issues.join("; ")}), repair attempt ${repairsUsed}/${MAX_ROLLING_SUMMARY_FORMAT_REPAIRS}`);
      const repairResult = await this._callRollingRepairLLM(newSummary, validation.issues, resolvedModel, turnCount, {
        returnUsage: opts.returnUsage,
        usageTrigger: opts.usageTrigger,
      });
      if (!evidenceStillCurrent()) return { summary: "", changed: false, data: null, usage, reason: "evidence_changed" };
      usage = typeof repairResult === "object" && repairResult !== null ? repairResult.usage || null : usage;
      newSummary = typeof repairResult === "object" && repairResult !== null ? repairResult.text : repairResult;
      if (!newSummary?.trim()) {
        validation = { ok: false, issues: [...validation.issues, "format repair attempt returned empty output"] };
        break;
      }
      validation = validateRollingSummaryFormat(newSummary);
    }
    if (!validation.ok) {
      throw new Error(`rolling summary format invalid after ${repairsUsed} repair attempt(s): ${validation.issues.join("; ")}`);
    }

    if (opts.isEnabled && !opts.isEnabled()) return { summary: "", changed: false, data: null, usage, reason: "learning_paused" };
    if (readCompiledGeneration(this.memoryDir) !== generation) return { summary: "", changed: false, data: null, usage, reason: "generation_changed" };
    try { assertMemoryEvidenceEpoch(this.agentDir, memoryEvidenceEpoch); }
    catch { return { summary: "", changed: false, data: null, usage, reason: "evidence_changed" }; }
    const latestResetAt = latestSince(resetAt, readCompiledResetAt(path.dirname(this.summariesDir)));
    if (latestResetAt && !areMessagesAfter(messages, latestResetAt)) {
      return {
        summary: prevSummary,
        changed: false,
        data: null,
        usage,
        reason: "reset_watermark",
      };
    }

    // PII 鑴辨晱
    const { cleaned: scrubbedRolling, detected: rollingDetected } = scrubPII(scrubMemorySecrets(newSummary));
    newSummary = scrubbedRolling;
    if (rollingDetected.length > 0) {
      log.warn(`PII detected in rolling summary (${rollingDetected.join(", ")}), redacted`);
      newSummary = scrubbedRolling;
    }

    const finalValidation = validateRollingSummaryFormat(newSummary);
    if (!finalValidation.ok) {
      throw new Error(`rolling summary format invalid after PII scrub: ${finalValidation.issues.join("; ")}`);
    }

    const now = new Date().toISOString();
    const data = {
      session_id: sessionId,
      memoryGeneration: generation,
      memoryEvidenceEpoch,
      projectId: opts.projectId || existing?.projectId || null,
      channelId: opts.channelId || existing?.channelId || null,
      sourceRefs: messages.map(message => ({
        kind: "message", sessionId,
        messageId: message.id || message.messageId || null,
        runId: message.runId || opts.runId || null,
        author: message.role,
        evidenceHash: memoryContentHash(JSON.stringify(message.content || "")),
        observedAt: message.timestamp || null,
      })),
      sourceRevision: memoryContentHash(JSON.stringify(messages.map(message => [message.id || null, message.timestamp || null, message.content]))),
      created_at: existing?.created_at || now,
      updated_at: now,
      summary: newSummary.trim(),
      messageCount: messages.length, // 记录已覆盖的消息总数
      source_time_range: sourceTimeRange || existing?.source_time_range || null,
      snapshot: existing?.snapshot || "",
      snapshot_at: existing?.snapshot_at || null,
    };

    return {
      summary: newSummary.trim(),
      changed: true,
      data,
      usage,
      reason: rollingDetected.length > 0 ? "pii_redacted" : "",
    };
  }

  async _callRollingRepairLLM(summaryText, issues, resolvedModel, turnCount = 10, opts: Record<string, any> = {}) {
    const { model: utilityModel, api, api_key, base_url } = resolvedModel;
    const locale = getLocale();
    const totalBudget = Math.min(400, Math.max(40, turnCount * 40));
    const visibleMaxTokens = Math.max(150, Math.min(750, Math.round(totalBudget * 1.5)));
    const layout = buildUtilityPromptLayout({
      cacheGroup: "memory.rolling_summary",
      templateVersion: "rolling-summary-repair.v1",
      systemPrompt: buildRollingSummaryRepairPrompt(locale),
      userContent: buildRollingSummaryRepairInput({ locale, issues, summaryText }),
    });
    const usageContext = attachPromptLayoutMetadata({
      source: {
        subsystem: "memory",
        operation: "rolling_summary_repair",
        surface: "system",
        trigger: opts.usageTrigger || "threshold",
      },
      attribution: {
        kind: "memory",
        agentId: resolvedModel.usageAgentId || null,
      },
    }, layout.usageMetadata);

    return callText({
      api, model: utilityModel,
      apiKey: api_key,
      baseUrl: base_url,
      systemPrompt: layout.systemPrompt,
      messages: layout.messages,
      temperature: 0.3,
      maxTokens: withMemoryReasoningBuffer(visibleMaxTokens, resolvedModel),
      timeoutMs: 60_000,
      returnUsage: opts.returnUsage === true,
      usageLedger: resolvedModel.usageLedger,
      usageContext,
    });
  }

  /**
 * 调用 LLM 生成滚动摘要（两节格式）
 * @param {string} convText - 本次对话文本
 * @param {string} prevSummary - 上一次摘要（可为空）
   * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
   * @returns {Promise<string>}
   */
  async _callRollingLLM(convText, prevSummary, resolvedModel, turnCount = 10, opts: Record<string, any> = {}) {
    const { model: utilityModel, api, api_key, base_url } = resolvedModel;

    const isZh = getLocale().startsWith("zh");
    const hasPrev = !!prevSummary;
    const memorySnapshot = normalizeMemoryReflectionSnapshot(opts.memoryReflectionSnapshot);
    const agentName = memorySnapshot.agentName || (isZh ? "这个 Agent" : "this agent");
    const userName = memorySnapshot.userName || (isZh ? "主人" : "the user");
    const identityAndPersonality = memorySnapshot.identityAndPersonality || (isZh ? "（未提供）" : "(Not provided)");
    const userProfile = memorySnapshot.userProfile || (isZh ? "（未提供）" : "(Not provided)");
    const existingMemory = memorySnapshot.existingMemory || (isZh ? "（暂无已有长期记忆）" : "(No existing long-term memory)");
    const roster = memorySnapshot.roster || (isZh ? "（没有其他 Agent）" : "(No other agents)");

    // 按轮数线性缩放：每轮 40 字配额，10 轮封顶 400 字
    const totalBudget = Math.min(400, Math.max(40, turnCount * 40));
    const factsBudget = Math.max(15, Math.round(totalBudget * 0.3));
    const eventsBudget = totalBudget - factsBudget;

    // 英文 budget 按 word 估算（约 1.5x 字符比）
    const factsWordBudget = Math.max(10, Math.round(factsBudget * 0.6));
    const eventsWordBudget = Math.max(20, Math.round(eventsBudget * 0.6));

    const systemPrompt = isZh
      ? `你是 ${agentName}。你正在整理自己刚刚经历的一段对话。

下面是你在本次对话开始前已经拥有的设定和记忆。它们是背景，不是新增事实。请从自己的视角审视本次对话，判断哪些新信息值得进入长期记忆。

## 你的身份与人格
${identityAndPersonality}

## 主人设定
${userProfile}

## 你已有的长期记忆
这是你在本次对话开始前已经拥有的记忆。不要因为它出现在这里就重复写入；只有本次对话更新、反驳、强化它时才记录变化。

${existingMemory}

## 花名册
花名册告诉你同处于这个系统里的别的 Agent。它只用于理解对话中的 Agent 名字和协作语境，不要把花名册本身当作新增记忆。

${roster}

## 核心原则
记忆的核心职责是维护你对${userName}的理解，让你以后更自然地理解这个人、你们的关系、长期项目和共同语境。摘要仍然以用户侧为中心：优先记录${userName}是谁、喜欢什么、在意什么、最近关注什么大主题。你的回复只需记录"做了什么"（如"生成了一篇关于X的文章""写了一段代码实现Y功能"），不记录回复的具体内容，也不记录即时内心想法。

## 输出格式
最终答案必须只包含两个三级标题，标题文本和顺序固定：
1. 第一行必须是 \`### 重要事实\`
2. 第二个标题必须是 \`### 事情经过\`

两个标题下的正文都必须使用无序列表。列表项必须以 \`- \` 开头。
如果某一节没有内容，也要输出一个列表项：\`- 无\`。
标题之外不要输出前言、后记、XML 标签或代码块。

## 内容要求

**重要事实一节**
只记录用户画像类信息：身份属性、人格特质、审美和兴趣、喜欢或讨厌的事物、长期关系、生活或创作取向、近期正在关注/投入的大主题。没有则写 \`- 无\`。

不要抽：
- 工作方式偏好：用户希望助手怎样审查、规划、调研、实现、测试、汇报、commit、push
- 协作流程偏好：用户要求的步骤、确认点、验证顺序、上下文管理方式
- 工具和平台偏好：某次任务中使用什么工具、命令、文件、模型、目录
- 工程纪律和项目规则：这些属于项目文档或系统规则，不属于用户画像记忆
- 一次任务里的格式、标准、临时判断

只抽：
- 用户是什么样的人
- 用户喜欢或讨厌什么对象、风格、内容、体验
- 用户长期在意的主题、关系、身份、审美、价值取向
- 用户最近正在关注哪个领域/项目/主题，只保留大主题，不保留细节

判别标准：
- 如果这条信息回答的是“用户是谁、喜欢什么、在意什么”，可以抽。
- 如果这条信息回答的是“和用户工作时该怎么做”，不要抽。
- 如果这条信息回答的是“用户最近在关注哪个领域/项目/主题”，只保留大主题，不保留该主题里的细节。
- 拿不准一律不抽。宁可漏，不可错。

字数要求：按实际信息量写，遵守本次摘要预算。信息少就写短，不要凑字数。

**事情经过一节**
按时间顺序记录本 session 发生了什么，带 YYYY-MM-DD HH:MM 时间标注，抓重点脉络。工作相关内容只允许保留到大主题层级。
工作内容可以写成“用户在讨论记忆系统”“用户在做 Codia”，不要写具体子问题、方案、文件、工具、命令、测试、执行步骤、检查顺序或协作偏好。
字数要求：按实际信息量写，遵守本次摘要预算。三句话能说清的事不要写成一段。

## 规则
1. 有已有摘要时：新旧内容合并，同一件事以新信息为准，不要重复
2. 时间标注从消息时间戳提取（YYYY-MM-DD HH:MM 格式）
3. 只记录客观事实，不记录 MOOD 或助手内心想法
4. 用户提供的文件/附件：只记录文件名和用途，忽略文件的具体内容
5. 助手的长篇输出（文章、代码、分析等）：只记录产出了什么，不摘录内容
6. 宁短勿长：摘要长度应与对话的实际信息密度成正比，闲聊几句只需一两行
7. 直接以 ### 重要事实 开头输出，不要前言后记`
      : `You are ${agentName}. You are reviewing a conversation you just experienced.

Below are the identity, settings, and memories you already had at the start of this session. They are background, not new facts. Review the new conversation from your own perspective and decide what deserves long-term memory.

## Your Identity And Personality
${identityAndPersonality}

## Owner / User Settings
${userProfile}

## Your Existing Long-Term Memory
This is the memory you already had before this conversation began. Do not rewrite it merely because it appears here; record only what this conversation updates, contradicts, or reinforces.

${existingMemory}

## Roster
The roster tells you which other agents are in the same system. Use it only to understand agent names and collaboration context; do not treat the roster itself as new memory.

${roster}

## Core Principle
Memory's core job is to maintain your understanding of ${userName}: who they are, your relationship with them, their long-running projects, and shared context. Keep the summary user-centric: prioritize who the user is, what they like, what they care about, and the broad themes they are currently focused on. For your replies, only record what was done (e.g. "generated an article about X", "wrote code implementing Y"), not the actual content or transient inner thoughts.

## Output Format
The final answer must contain exactly two third-level headings, with fixed text and order:
1. The first line must be \`### Key Facts\`
2. The second heading must be \`### Timeline\`

The body under both headings must use unordered lists. Each list item must start with \`- \`.
If a section has no content, output one list item: \`- None\`.
Do not output any preamble, conclusion, XML tags, or code fences outside those headings.

## Content Requirements

**Key Facts section**
Only record user-profile information: identity attributes, personality traits, aesthetics and interests, likes and dislikes, long-term relationships, life or creative orientation, and broad current themes the user is focused on. Write \`- None\` if none.

Do NOT extract:
- Work-style preferences: how the user wants the assistant to review, plan, research, implement, test, report, commit, or push
- Collaboration-process preferences: steps, checkpoints, validation order, context-management rules
- Tool and platform preferences from a task: tools, commands, files, models, directories
- Engineering discipline and project rules: these belong in explicit project instructions, not profile memory
- One-task formats, standards, or temporary judgments

ONLY extract:
- What kind of person the user is
- What objects, styles, content, and experiences the user likes or dislikes
- Long-term themes, relationships, identity, aesthetics, and values the user cares about
- Which domain/project/theme the user is currently focused on, keeping only the broad theme and no details

Test:
- If the information answers "who is the user, what do they like, what do they care about", extract it.
- If the information answers "how should one work with the user", do not extract it.
- If the information answers "which domain/project/theme is the user focused on recently", keep only the broad theme and no details inside that theme.
- When in doubt, skip. Better miss than mis-record.

Word limit: follow the per-run summary budget. Keep it short if there's little info.

**Timeline section**
Record what happened in this session in chronological order with YYYY-MM-DD HH:MM timestamps, capturing key points. Work-related content may only be kept at the broad-theme level.
Work can be written as "the user discussed memory systems" or "the user worked on Codia"; do not record subproblems, proposals, files, tools, commands, tests, execution steps, validation order, or collaboration preferences.
Word limit: follow the per-run summary budget. If three sentences suffice, don't write a paragraph.

## Rules
1. When existing summary is present: merge old and new, use newer info for the same topic, no duplicates
2. Extract time annotations from message timestamps (YYYY-MM-DD HH:MM format)
3. Only record objective facts, not MOOD or assistant's inner thoughts
4. User-provided files/attachments: only record filename and purpose, ignore file contents
5. Assistant's long outputs (articles, code, analysis): only record what was produced, don't excerpt content
6. Prefer brevity: summary length should be proportional to actual information density
7. Start output directly with ### Key Facts, no preamble or conclusion`;

    const prevLabel = isZh ? "## 已有摘要" : "## Existing Summary";
    const newLabel = isZh ? "## 新增对话" : "## New Conversation";
    const budgetLabel = isZh ? "## 本次摘要预算" : "## This Run's Summary Budget";
    const budgetText = isZh
      ? `重要事实最多${factsBudget}字。事情经过最多${eventsBudget}字。`
      : `Key Facts max ${factsWordBudget} words. Timeline max ${eventsWordBudget} words.`;
    const userContent = [
      hasPrev ? `${prevLabel}\n\n${prevSummary}` : "",
      `${newLabel}\n\n${convText}`,
      `${budgetLabel}\n\n${budgetText}`,
    ].filter(Boolean).join("\n\n");
    const layout = buildUtilityPromptLayout({
      cacheGroup: "memory.rolling_summary",
      templateVersion: "rolling-summary.v1",
      systemPrompt,
      userContent,
    });
    const usageContext = attachPromptLayoutMetadata({
      source: {
        subsystem: "memory",
        operation: "rolling_summary",
        surface: "system",
        trigger: opts.usageTrigger || "threshold",
      },
      attribution: {
        kind: "memory",
        agentId: resolvedModel.usageAgentId || null,
      },
    }, layout.usageMetadata);

 // max_tokens 跟着配额走，避免固定值引-LLM 写满
    const visibleMaxTokens = Math.max(150, Math.min(750, Math.round(totalBudget * 1.5)));
    const maxTokens = withMemoryReasoningBuffer(visibleMaxTokens, resolvedModel);

    return callText({
      api, model: utilityModel,
      apiKey: api_key,
      baseUrl: base_url,
      systemPrompt: layout.systemPrompt,
      messages: layout.messages,
      temperature: 0.3,
      maxTokens: maxTokens,
      timeoutMs: 60_000,
      returnUsage: opts.returnUsage === true,
      usageLedger: resolvedModel.usageLedger,
      usageContext,
    });
  }

}

function normalizeSince(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function latestSince(...values) {
  let latest = null;
  for (const value of values) {
    const normalized = normalizeSince(value);
    if (!normalized) continue;
    if (!latest || Date.parse(normalized) > Date.parse(latest)) latest = normalized;
  }
  return latest;
}

function isAfter(value, since) {
  if (!value) return false;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return false;
  return ts > Date.parse(since);
}

function areMessagesAfter(messages, since) {
  if (!since) return true;
  return messages.every((message) => isAfter(message.timestamp, since));
}

function normalizeMemoryReflectionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const pick = (key) => typeof value[key] === "string" ? value[key].trim() : "";
  return {
    agentName: pick("agentName"),
    userName: pick("userName"),
    identityAndPersonality: pick("identityAndPersonality"),
    userProfile: pick("userProfile"),
    existingMemory: pick("existingMemory"),
    roster: pick("roster"),
  };
}
