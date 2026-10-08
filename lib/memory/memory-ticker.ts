// @ts-nocheck
/**
  *
 * 触发机制改为 turn-based- * - -6 轮：滚动摘要 + compileToday + assemble
 * - session 结束：final 滚动摘要 + compileToday + assemble
  *
 *
  * */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { debugLog } from "../debug-log.ts";
import {
  compileToday,
  compileWeek,
  compileLongterm,
  compileFacts,
  compileEditableFacts,
  assemble,
  editableFactsPath,
  ensureEditableFactsBaseline,
} from "./compile.ts";
import { processDirtySessions } from "./deep-memory.ts";
import { getLogicalDay } from "../time-utils.ts";
import { readCompiledResetAt } from "./compiled-memory-state.ts";
import { isAgentPhoneSessionPath } from "../conversations/agent-phone-session.ts";
import { buildSourceTimeRange } from "./time-context.ts";
import { writeCacheSnapshotObservation } from "./cache-snapshot-observation.ts";
import { runMemoryReflection as defaultRunMemoryReflection } from "./memory-reflection-runner.ts";
import { CACHE_STRATEGIES } from "../llm/cache-strategy-contract.ts";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

const TURNS_PER_SUMMARY = 6;
const CACHE_SNAPSHOT_PREVIEW_LIMIT = 16_000;
const DAILY_STATE_FILE = "daily-state.json";
const DAILY_STATE_SCHEMA_VERSION = 1;
const DAILY_STEP_KEYS = ["compileToday", "compileWeek", "compileLongterm", "compileFacts", "deepMemory"];

//

/**
  *
 */
const TAIL_READ_THRESHOLD = 256 * 1024; // 256KB：超过此大小只读尾部

function readSessionMessages(filePath, opts = {}) {
  const since = opts.since && !Number.isNaN(Date.parse(opts.since))
    ? Date.parse(opts.since)
    : null;
  let raw;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > TAIL_READ_THRESHOLD) {
 // 大文件：只读尾部，跳过首个不完整-
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(TAIL_READ_THRESHOLD);
        fs.readSync(fd, buf, 0, TAIL_READ_THRESHOLD, stat.size - TAIL_READ_THRESHOLD);
        raw = buf.toString("utf-8");
        const firstNewline = raw.indexOf("\n");
        if (firstNewline !== -1) raw = raw.slice(firstNewline + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(filePath, "utf-8");
    }
  } catch {
    return { messages: [], lastTimestamp: null };
  }

  const messages = [];
  let lastTimestamp = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) {
        const { role, content } = entry.message;
        if (role === "user" || role === "assistant") {
          const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
          if (since && (Number.isNaN(ts) || ts <= since)) continue;
          messages.push({ role, content, timestamp: entry.timestamp || null });
          if (entry.timestamp) lastTimestamp = entry.timestamp;
        }
      }
    } catch {
      //
      }
  }

  return { messages, lastTimestamp };
}

/**
  *
 */
function listAllSessions(sessionDir) {
  const results = [];

  function scanDir(dir, prefix) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(dir, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.isFile()) results.push({ filename: prefix ? `${prefix}/${f}` : f, filePath: fp, mtime: stat.mtime });
        } catch {}
      }
    } catch {}
  }

  scanDir(sessionDir, null);
  scanDir(path.join(sessionDir, "bridge", "owner"), "bridge/owner");
 // DM 不再通过 session 系统，不扫描 dms/ 目录

  return results;
}

function sessionIdFromFilename(filename) {
  return filename.replace(/\.jsonl$/, "");
}

function latestIsoTimestamp(...values) {
  let latest = null;
  for (const value of values) {
    if (!value || Number.isNaN(Date.parse(value))) continue;
    const normalized = new Date(value).toISOString();
    if (!latest || Date.parse(normalized) > Date.parse(latest)) latest = normalized;
  }
  return latest;
}

//

/**
  *
 * @param {object} opts
 * @param {import('./session-summary.ts').SessionSummaryManager} opts.summaryManager
 * @param {string} opts.configPath
 * @param {import('./fact-store.ts').FactStore} opts.factStore
 * @param {function} opts.getResolvedMemoryModel - 返回预解析的 { model, provider, api, api_key, base_url }
 * @param {function} [opts.onCompiled] - memory.md 更新后的回调
 * @param {string} opts.sessionDir
 * @param {string} opts.memoryMdPath
 * @param {string} opts.todayMdPath
 * @param {string} opts.weekMdPath
 * @param {string} opts.longtermMdPath
 * @param {string} opts.factsMdPath
  * */
export function createMemoryTicker(opts) {
  const {
    agentId,
    agentDir,
    summaryManager,
      factStore,
    getResolvedMemoryModel,
    onCompiled,
    sessionDir,
    memoryMdPath,
    todayMdPath,
    weekMdPath,
      longtermMdPath,
      factsMdPath,
      getMemoryMasterEnabled,
      isSessionMemoryEnabled,
    getSessionMemoryEnabledFrom,
      getTimezone,
      getEditableMemoryEnabled,
      memoryReflectionRunner,
      buildSessionCacheSnapshot,
      getSessionStreamFn,
      getSessionIdForPath,
      memoryDir = path.dirname(memoryMdPath),
    } = opts;
  const _memoryReflectionRunner = memoryReflectionRunner || { runMemoryReflection: defaultRunMemoryReflection };

  /** */
  const _isMemoryMasterOn = () => !getMemoryMasterEnabled || getMemoryMasterEnabled();
 /** 指定 session 是否允许进入记忆流水-*/
  const _isSessionMemoryOn = (sessionPath) =>
    !isAgentPhoneSessionPath(sessionPath)
    && _isMemoryMasterOn()
    && (!isSessionMemoryEnabled || isSessionMemoryEnabled(sessionPath));
  const _getSessionMemoryEnabledFrom = (sessionPath) =>
    getSessionMemoryEnabledFrom ? getSessionMemoryEnabledFrom(sessionPath) : null;
  const _getCompiledResetAt = () => readCompiledResetAt(memoryDir);
  const _getEffectiveSince = (sessionPath) =>
    latestIsoTimestamp(_getCompiledResetAt(), _getSessionMemoryEnabledFrom(sessionPath));
  const _getTimezone = () => getTimezone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const _sessionIdentityForPath = (sessionPath) => {
    try {
      const sessionId = getSessionIdForPath?.(sessionPath);
      if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
    } catch {}
    return sessionIdFromFilename(path.basename(sessionPath));
  };
  const _getCacheSnapshotReflectionMode = () => {
    return "off";
  };
  const _isEditableMemoryOn = () => getEditableMemoryEnabled?.() === true;
  const _factsSourcePath = () => {
    if (!_isEditableMemoryOn()) return factsMdPath;
    ensureEditableFactsBaseline(memoryDir, summaryManager, {
      seedFactsPath: factsMdPath,
    });
    return editableFactsPath(memoryDir);
  };
  const _createSourceTimeRangeResolver = () => {
    const filesById = new Map(
      listAllSessions(sessionDir).map((entry) => [_sessionIdentityForPath(entry.filePath), entry.filePath]),
    );
    return (sessionId) => {
      const filePath = filesById.get(sessionId);
      if (!filePath) return null;
      const { messages } = readSessionMessages(filePath);
      return buildSourceTimeRange(messages, { timeZone: _getTimezone() });
    };
  };
  const _readMemoryReflectionSnapshot = (sessionPath) => {
    try {
      const metaPath = path.join(path.dirname(sessionPath), "session-meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const snapshot = meta[path.basename(sessionPath)]?.memoryReflectionSnapshot;
      return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? snapshot
        : null;
    } catch {
      return null;
    }
  };

 //
  const DAILY_CHECK_INTERVAL = 60 * 60 * 1000;

  let _timer = null;
  let _tickInFlight = null;
  let _stopped = false;
  const _activeJobs = new Set();
  let _dailyRunning = false;
  let _lastDailyJobDate = null;
  let _dailyStepsDate = null;
  let _dailyStepsContextKey = null;
  let _dailyCompletedAt = null;
  const _dailyStepsCompleted = new Set();
  const _dailyStepCompletedAt = new Map();
  const _turnCounts = new Map();
  const _summaryInProgress = new Set();      // 正在跑滚动摘要的 session

  function _trackJob(promise) {
    _activeJobs.add(promise);
    promise.then(
      () => _activeJobs.delete(promise),
      () => _activeJobs.delete(promise),
    );
    return promise;
  }

  function _dailyStatePath() {
    return path.join(memoryDir, DAILY_STATE_FILE);
  }

  function _normalizeResetAt(value) {
    if (!value || Number.isNaN(Date.parse(value))) return null;
    return new Date(value).toISOString();
  }

  function _dailyFactsMode() {
    return _isEditableMemoryOn() ? "editable" : "legacy";
  }

  function _dailyContext(logicalDate = getLogicalDay().logicalDate) {
    return {
      logicalDate,
      resetAt: _normalizeResetAt(_getCompiledResetAt()),
      factsMode: _dailyFactsMode(),
    };
  }

  function _dailyContextKey(context) {
    return [context.logicalDate, context.resetAt || "", context.factsMode].join("\n");
  }

  function _isValidIso(value) {
    return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
  }

  function _readDailyState() {
    try {
      const raw = JSON.parse(fs.readFileSync(_dailyStatePath(), "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (raw.schemaVersion !== DAILY_STATE_SCHEMA_VERSION) return null;
      const completedSteps = raw.completedSteps && typeof raw.completedSteps === "object" && !Array.isArray(raw.completedSteps)
        ? raw.completedSteps
        : {};
      return {
        logicalDate: typeof raw.logicalDate === "string" ? raw.logicalDate : "",
        resetAt: _normalizeResetAt(raw.resetAt),
        factsMode: raw.factsMode === "editable" ? "editable" : "legacy",
        completedSteps,
        dailyCompletedAt: _isValidIso(raw.dailyCompletedAt) ? new Date(raw.dailyCompletedAt).toISOString() : null,
      };
    } catch (err) {
      if (err?.code !== "ENOENT") {
        debugLog()?.error("memory", `daily state read failed: ${err?.message || err}`);
      }
      return null;
    }
  }

  function _stateMatchesContext(state, context) {
    return Boolean(state)
      && state.logicalDate === context.logicalDate
      && state.resetAt === context.resetAt
      && state.factsMode === context.factsMode;
  }

  function _allDailyStepsCompleted() {
    return DAILY_STEP_KEYS.every((stepKey) => _dailyStepsCompleted.has(stepKey));
  }

  function _resetDailyProgressForContext(context) {
    _dailyStepsCompleted.clear();
    _dailyStepCompletedAt.clear();
    _dailyCompletedAt = null;
    _dailyStepsDate = context.logicalDate;
    _dailyStepsContextKey = _dailyContextKey(context);
    if (_lastDailyJobDate === context.logicalDate) _lastDailyJobDate = null;
  }

  function _restoreDailyProgress(context = _dailyContext()) {
    const contextKey = _dailyContextKey(context);
    if (_dailyStepsContextKey !== contextKey) {
      _resetDailyProgressForContext(context);
    }

    const state = _readDailyState();
    if (!_stateMatchesContext(state, context)) return context;

    for (const stepKey of DAILY_STEP_KEYS) {
      const completedAt = state.completedSteps?.[stepKey];
      if (!_isValidIso(completedAt)) continue;
      _dailyStepsCompleted.add(stepKey);
      _dailyStepCompletedAt.set(stepKey, new Date(completedAt).toISOString());
    }
    _dailyCompletedAt = state.dailyCompletedAt;
    _dailyStepsDate = context.logicalDate;
    _dailyStepsContextKey = contextKey;
    if (_dailyCompletedAt && _allDailyStepsCompleted()) {
      _lastDailyJobDate = context.logicalDate;
    }
    return context;
  }

  function _writeDailyState(context) {
    const completedSteps = {};
    for (const stepKey of DAILY_STEP_KEYS) {
      const completedAt = _dailyStepCompletedAt.get(stepKey);
      if (completedAt) completedSteps[stepKey] = completedAt;
    }
    const state = {
      schemaVersion: DAILY_STATE_SCHEMA_VERSION,
      logicalDate: context.logicalDate,
      resetAt: context.resetAt,
      factsMode: context.factsMode,
      completedSteps,
      dailyCompletedAt: _dailyCompletedAt,
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(memoryDir, { recursive: true });
    atomicWriteSync(_dailyStatePath(), JSON.stringify(state, null, 2) + "\n");
  }

  function _markDailyStepCompleted(stepKey, context) {
    _dailyStepsCompleted.add(stepKey);
    _dailyStepCompletedAt.set(stepKey, new Date().toISOString());
    try {
      _writeDailyState(context);
    } catch (err) {
      debugLog()?.error("memory", `daily state write failed after ${stepKey}: ${err?.message || err}`);
    }
  }

  function _clearPersistedDailyProgress(context, reason) {
    _resetDailyProgressForContext(context);
    try {
      _writeDailyState(context);
    } catch (err) {
      debugLog()?.error("memory", `daily state clear failed (${reason}): ${err?.message || err}`);
    }
  }

 //
  let _lastErrorSig = null;
  function _logStepError(label, err) {
    const msg = err?.message || String(err);
    const sig = `${label}|${msg}`;
    if (sig === _lastErrorSig) {
 // 同一根因重复 -只写 debug 文件，不-console
      debugLog()?.error("memory", `${label} (dup suppressed): ${msg}`);
      return;
    }
    _lastErrorSig = sig;
    console.error(`\x1b[90m[memory-ticker] ${label} 失败: ${msg}\x1b[0m`);
    debugLog()?.error("memory", `${label} failed: ${msg}`);
  }
  function _markStepRecovered(label) {
    if (!_lastErrorSig) return;
    const prev = _lastErrorSig;
    _lastErrorSig = null;
    console.log(`\x1b[90m[memory-ticker] ${label} recovered (previously ${prev})\x1b[0m`);
    debugLog()?.log("memory", `${label} recovered (was: ${prev})`);
  }

 //

  const _stepKeys = ["rollingSummary", "cacheSnapshotReflection", "compileToday", "compileWeek", "compileLongterm", "compileFacts", "deepMemory"];
  const _health = {};
  for (const key of _stepKeys) {
    _health[key] = { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 };
  }

  function _markSuccess(stepKey) {
    const h = _health[stepKey];
    if (!h) return;
    h.lastSuccessAt = new Date().toISOString();
    h.lastErrorAt = null;
    h.lastErrorMsg = null;
    h.failCount = 0;
  }

  function _markFailure(stepKey, err) {
    const h = _health[stepKey];
    if (!h) return;
    h.lastErrorAt = new Date().toISOString();
    h.lastErrorMsg = err?.message || String(err);
    h.failCount += 1;
  }

  function _textPreview(text) {
    const value = String(text || "");
    return value.length > CACHE_SNAPSHOT_PREVIEW_LIMIT
      ? value.slice(0, CACHE_SNAPSHOT_PREVIEW_LIMIT)
      : value;
  }

  function _sha256(text) {
    if (!text) return "";
    return crypto.createHash("sha256").update(String(text)).digest("hex");
  }

  function _readMemoryMdPreview() {
    try {
      return _textPreview(fs.readFileSync(memoryMdPath, "utf-8"));
    } catch (err) {
      if (err?.code === "ENOENT") return "";
      throw err;
    }
  }

  function _firstNumber(...values) {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  function _observationUsage(usage, resolvedModel, latencyMs) {
    return {
      model: String(modelIdFromModelLike(resolvedModel)),
      cachedTokens: _firstNumber(
        usage?.cachedTokens,
        usage?.cacheReadTokens,
        usage?.cache?.readTokens,
      ),
      missTokens: _firstNumber(
        usage?.missTokens,
        usage?.cacheMissTokens,
        usage?.cache?.missTokens,
        usage?.input?.uncachedTokens,
      ),
      latencyMs,
    };
  }

  function modelIdFromModelLike(model) {
    if (!model) return "";
    if (typeof model === "string") return model;
    return model.model?.id || model.model || model.id || "";
  }

  function _requestModelDiagnostics(model) {
    if (!model || typeof model !== "object" || Array.isArray(model)) return null;
    return {
      id: String(model.id || model.model?.id || model.model || ""),
      provider: String(model.provider || model.model?.provider || ""),
      api: String(model.api || ""),
      hasBaseUrl: Boolean(model.baseUrl || model.base_url),
      hasQuirks: Array.isArray(model.quirks || model.model?.quirks),
    };
  }

  function _errorDiagnostics(err, requestModel) {
    return {
      errorName: String(err?.name || ""),
      stack: typeof err?.stack === "string" ? err.stack.split("\n").slice(0, 4) : [],
      requestModel: _requestModelDiagnostics(requestModel),
    };
  }

  async function _runSessionSnapshotMemoryReflection({
    sessionPath,
    sessionId,
    messages,
    resolvedModel,
    rollingOptions,
    mode,
    trigger,
  }) {
    const startedAt = Date.now();
    let baseMemoryMd = "";
    let requestModel = null;
    let diagnosticModel = null;
    try {
      baseMemoryMd = _readMemoryMdPreview();
    } catch (err) {
      debugLog()?.error("memory", `cache snapshot memory.md preview failed: ${err?.message || err}`);
    }
    try {
      if (!agentDir) {
        throw new Error("agentDir is required for cache snapshot reflection observation");
      }
      if (typeof _memoryReflectionRunner.runMemoryReflection !== "function") {
        throw new Error("memoryReflectionRunner.runMemoryReflection is required for session snapshot reflection");
      }
      if (typeof buildSessionCacheSnapshot !== "function") {
        throw new Error("buildSessionCacheSnapshot is required for session snapshot reflection");
      }

      const snapshot = buildSessionCacheSnapshot(sessionPath, {
        reason: "memory.reflection",
        messages,
      });
      const previousSummary = summaryManager.getSummary?.(sessionId)?.summary || "";
      requestModel = snapshot.requestModel || snapshot.model || resolvedModel?.model || resolvedModel;
      diagnosticModel = snapshot.requestModel || snapshot.model || resolvedModel;
      const reflection = await _memoryReflectionRunner.runMemoryReflection({
        snapshot,
        model: requestModel,
        cacheKeyParams: snapshot.cacheKeyParams || {},
        previousSummary,
        sessionId,
        messages,
        sourceTimeRange: buildSourceTimeRange(messages, { timeZone: rollingOptions.timeZone }),
        timeZone: rollingOptions.timeZone,
        streamFn: getSessionStreamFn?.(sessionPath),
        options: {
          ...(snapshot.cacheKeyParams?.thinkingLevel && snapshot.cacheKeyParams.thinkingLevel !== "off"
            ? { reasoning: snapshot.cacheKeyParams.thinkingLevel }
            : {}),
          toolChoice: "none",
        },
        usageLedger: resolvedModel?.usageLedger,
        usageContext: {
          source: {
            subsystem: "memory",
            operation: "cache_snapshot_reflection",
            surface: "system",
            trigger,
          },
          attribution: {
            kind: "session",
            agentId: agentId || resolvedModel?.usageAgentId || null,
            sessionPath,
          },
        },
      });
      const metadata = reflection?.metadata || {};
      const strictSessionSnapshot = metadata.cacheStrategy === CACHE_STRATEGIES.SESSION_SNAPSHOT
        && metadata.strict === true;

      if (!strictSessionSnapshot) {
        const err = new Error("Cache snapshot memory write requires a strict session_snapshot result");
        err.cacheMetadata = metadata;
        throw err;
      }

      if (mode === "write" && reflection?.data) {
        summaryManager.saveSummary(sessionId, reflection.data);
      }

      const observation = writeCacheSnapshotObservation(agentDir, {
        agentId: agentId || resolvedModel?.usageAgentId || path.basename(agentDir),
        sessionPath,
        trigger,
        mode,
        status: "success",
        reason: reflection?.reason || "",
        usage: _observationUsage(reflection?.usage, requestModel || resolvedModel, Date.now() - startedAt),
        summaryPreview: _textPreview(reflection?.summary || ""),
        memoryMdPreview: baseMemoryMd,
        baseMemoryMdHash: _sha256(baseMemoryMd),
        cacheStrategy: metadata.cacheStrategy,
        strict: metadata.strict === true,
        cachePrefixHash: metadata.cachePrefixHash || "",
        parentCachePrefixHash: metadata.parentCachePrefixHash || "",
        contractDiffs: metadata.contractDiffs || [],
        degradeReason: metadata.degradeReason || "",
      });
      _markSuccess("cacheSnapshotReflection");
      return observation.summaryPreview;
    } catch (err) {
      const metadata = err?.cacheMetadata || {};
      _markFailure("cacheSnapshotReflection", err);
      if (err?.stack) {
        debugLog()?.error("memory", `cache snapshot reflection stack: ${err.stack}`);
      }
      try {
        if (agentDir) {
          writeCacheSnapshotObservation(agentDir, {
            agentId: agentId || resolvedModel?.usageAgentId || path.basename(agentDir),
            sessionPath,
            trigger,
            mode,
            status: "failed",
            reason: err?.message || String(err),
            usage: _observationUsage(null, resolvedModel, Date.now() - startedAt),
            summaryPreview: "",
            memoryMdPreview: baseMemoryMd,
            baseMemoryMdHash: _sha256(baseMemoryMd),
            cacheStrategy: metadata.cacheStrategy || CACHE_STRATEGIES.CACHE_RECOVERY,
            strict: metadata.strict === true,
            cachePrefixHash: metadata.cachePrefixHash || "",
            parentCachePrefixHash: metadata.parentCachePrefixHash || "",
            contractDiffs: metadata.contractDiffs || [],
            degradeReason: metadata.degradeReason || err?.message || String(err),
            diagnostics: _errorDiagnostics(err, diagnosticModel || requestModel || resolvedModel),
          });
        }
      } catch (writeErr) {
        debugLog()?.error("memory", `cache snapshot observation write failed: ${writeErr?.message || writeErr}`);
      }
      _logStepError(`cache snapshot reflection (${path.basename(sessionPath)})`, err);
      if (mode === "write") throw err;
      return "";
    }
  }

  async function _doRollingSummary(sessionPath, trigger = "threshold") {
    if (_summaryInProgress.has(sessionPath)) return; // 并发保护
    _summaryInProgress.add(sessionPath);
    try {
      const resetAt = _getCompiledResetAt();
      const since = _getEffectiveSince(sessionPath);
      const { messages } = readSessionMessages(sessionPath, { since });
      if (messages.length === 0) return;

      const sessionId = _sessionIdentityForPath(sessionPath);
      const rollingOptions = {
        resetAt: since || resetAt,
        timeZone: _getTimezone(),
      };
      const memoryReflectionSnapshot = _readMemoryReflectionSnapshot(sessionPath);
      if (memoryReflectionSnapshot) {
        rollingOptions.memoryReflectionSnapshot = memoryReflectionSnapshot;
      }
      const resolvedModel = getResolvedMemoryModel();
      const cacheSnapshotMode = _getCacheSnapshotReflectionMode();
      if (cacheSnapshotMode === "write") {
        await _runSessionSnapshotMemoryReflection({
          sessionPath,
          sessionId,
          messages,
          resolvedModel,
          rollingOptions,
          mode: "write",
          trigger,
        });
      } else {
        await summaryManager.rollingSummary(sessionId, messages, resolvedModel, rollingOptions);
        if (cacheSnapshotMode === "shadow") {
          await _runSessionSnapshotMemoryReflection({
            sessionPath,
            sessionId,
            messages,
            resolvedModel,
            rollingOptions,
            mode: "shadow",
            trigger,
          });
        }
      }
      debugLog()?.log("memory", `rolling summary updated: ${sessionId.slice(0, 8)}...`);
      _markSuccess("rollingSummary");
      _markStepRecovered("滚动摘要");
    } catch (err) {
      _logStepError(`滚动摘要 (${path.basename(sessionPath)})`, err);
      _markFailure("rollingSummary", err);
      if (trigger === "manual" && _getCacheSnapshotReflectionMode() === "write") {
        throw err;
      }
    } finally {
      _summaryInProgress.delete(sessionPath);
    }
  }

 //

  async function _doCompileTodayAndAssemble() {
    try {
      const resetAt = _getCompiledResetAt();
      await compileToday(summaryManager, todayMdPath, getResolvedMemoryModel(), { since: resetAt });
      assemble(_factsSourcePath(), todayMdPath, weekMdPath, longtermMdPath, memoryMdPath);
      onCompiled?.();
      debugLog()?.log("memory", "today compiled + assembled");
      _markSuccess("compileToday");
      _markStepRecovered("compileToday");
    } catch (err) {
      _markFailure("compileToday", err);
      _logStepError("compileToday", err);
    }
  }

 //

  async function _doDaily() {
    if (_dailyRunning) return;
    _dailyRunning = true;
    try {
      const todayStr = getLogicalDay().logicalDate;
      const context = _restoreDailyProgress(_dailyContext(todayStr));
      const resetAt = context.resetAt;

 // 日期变化时重置步骤跟-
      console.log(`\x1b[90m[memory-ticker] 每日任务开始 (${todayStr})\x1b[0m`);
      let hasFailed = false;

 //
      if (!_dailyStepsCompleted.has("compileToday")) {
        try {
          await compileToday(summaryManager, todayMdPath, getResolvedMemoryModel(), { since: resetAt });
          _markDailyStepCompleted("compileToday", context);
          _markSuccess("compileToday");
          _markStepRecovered("compileToday(daily)");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileToday", err);
          _logStepError("compileToday(daily)", err);
        }
      }

      // Step 1: compileWeek
      if (!_dailyStepsCompleted.has("compileWeek")) {
        try {
          await compileWeek(summaryManager, weekMdPath, getResolvedMemoryModel(), { since: resetAt });
          _markDailyStepCompleted("compileWeek", context);
          _markSuccess("compileWeek");
          _markStepRecovered("compileWeek");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileWeek", err);
          _logStepError("compileWeek", err);
        }
      }

 //
      if (!_dailyStepsCompleted.has("compileLongterm") && _dailyStepsCompleted.has("compileWeek")) {
        try {
          await compileLongterm(weekMdPath, longtermMdPath, getResolvedMemoryModel());
          _markDailyStepCompleted("compileLongterm", context);
          _markSuccess("compileLongterm");
          _markStepRecovered("compileLongterm");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileLongterm", err);
          _logStepError("compileLongterm", err);
        }
      }

 //
      if (!_dailyStepsCompleted.has("compileFacts")) {
        try {
          if (_isEditableMemoryOn()) {
            await compileEditableFacts(summaryManager, editableFactsPath(memoryDir), getResolvedMemoryModel(), {
              since: resetAt,
              seedFactsPath: factsMdPath,
            });
          } else {
            await compileFacts(summaryManager, factsMdPath, getResolvedMemoryModel(), { since: resetAt });
          }
          _markDailyStepCompleted("compileFacts", context);
          _markSuccess("compileFacts");
          _markStepRecovered("compileFacts");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileFacts", err);
          _logStepError("compileFacts", err);
        }
      }

 //
      try {
        assemble(_factsSourcePath(), todayMdPath, weekMdPath, longtermMdPath, memoryMdPath);
        onCompiled?.();
      } catch (err) {
        hasFailed = true;
        console.error(`\x1b[90m[memory-ticker] assemble 失败: ${err.message}\x1b[0m`);
      }

 //
      if (!_dailyStepsCompleted.has("deepMemory")) {
        try {
          const { processed, factsAdded } = await processDirtySessions(
            summaryManager,
            factStore,
            getResolvedMemoryModel(),
            {
              since: resetAt,
              timeZone: _getTimezone(),
              getSourceTimeRange: _createSourceTimeRangeResolver(),
            },
          );
          _markDailyStepCompleted("deepMemory", context);
          if (processed > 0) {
            console.log(`\x1b[90m[memory-ticker] deep-memory: ${processed} session, ${factsAdded} 条新事实\x1b[0m`);
          }
          _markSuccess("deepMemory");
          _markStepRecovered("deep-memory");
        } catch (err) {
          hasFailed = true;
          _markFailure("deepMemory", err);
          _logStepError("deep-memory", err);
        }
      }

      if (hasFailed) {
        const done = [..._dailyStepsCompleted].join(", ");
        console.error(`\x1b[90m[memory-ticker] daily job partially failed; completed: [${done}], retrying unfinished steps in 1 hour\x1b[0m`);
        debugLog()?.error("memory", `daily job partial failure, completed: [${done}]`);
      } else {
        _lastDailyJobDate = todayStr;
        _dailyCompletedAt = new Date().toISOString();
        try {
          _writeDailyState(context);
        } catch (err) {
          debugLog()?.error("memory", `daily state final write failed: ${err?.message || err}`);
        }
        console.log(`\x1b[90m[memory-ticker] 每日任务完成\x1b[0m`);
      }
    } finally {
      _dailyRunning = false;
    }
  }

  function _checkDailyJob() {
    if (_stopped) return;
    if (!_isMemoryMasterOn()) return;
    const context = _restoreDailyProgress();
    if (_lastDailyJobDate !== context.logicalDate) {
      _trackJob(_doDaily());
    }
  }

  //

  /**
 * 每轮对话结束后调用（-engine.js -prompt() 返回后调用）
 * @param {string} sessionPath - 当前 session -.jsonl 文件路径
   */
  function notifyTurn(sessionPath) {
    if (_stopped) return;
    const sessionKey = _sessionIdentityForPath(sessionPath);
    const count = (_turnCounts.get(sessionKey) || 0) + 1;
    _turnCounts.set(sessionKey, count);

    const memoryOn = _isSessionMemoryOn(sessionPath);

    if (count % TURNS_PER_SUMMARY === 0 && memoryOn) {
      _trackJob(_doRollingSummary(sessionPath, "threshold")
        .then(() => _doCompileTodayAndAssemble())
        .catch(() => {}));
    }

    // Keep foreground chat turns lightweight. Daily maintenance is handled by the
    // hourly timer and explicit maintenance ticks, not by user-facing turns.
  }

  /**
  *
   */
  async function notifySessionEnd(sessionPath) {
    if (_stopped) return;
    if (!sessionPath) return;
    const sessionKey = _sessionIdentityForPath(sessionPath);
    const count = _turnCounts.get(sessionKey) || 0;
    _turnCounts.delete(sessionKey);
    if (count === 0) return; // 没有新轮次，无需更新摘要
    if (!_isSessionMemoryOn(sessionPath)) return;
    try {
      await _doRollingSummary(sessionPath, "session_end");
      await _doCompileTodayAndAssemble();
    } catch (err) {
      console.error(`\x1b[90m[memory-ticker] notifySessionEnd 失败: ${err.message}\x1b[0m`);
    }
  }

  /**
 * 启动每小时的日期棢-timer（备用触发，不依赖用户对话）
   */
  function start() {
    if (_stopped) return;
    if (_timer) return;
    _timer = setInterval(() => _checkDailyJob(), DAILY_CHECK_INTERVAL);
    if (_timer.unref) _timer.unref();
    console.log(`\x1b[90m[memory-ticker] v3 started (turn-based, daily fallback timer 1h)\x1b[0m`);
  }

  async function stop() {
    _stopped = true;
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    if (_tickInFlight) await _tickInFlight.catch(() => {});
    while (_activeJobs.size > 0) {
      await Promise.allSettled([..._activeJobs]);
    }
  }

  /**
  * */
  async function _recoverUnsummarized() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const resetAt = _getCompiledResetAt();
    const resetMs = resetAt ? Date.parse(resetAt) : null;
    const sessions = listAllSessions(sessionDir);
    let recovered = 0;
    for (const { filePath, mtime } of sessions) {
      if (mtime.getTime() < cutoff) continue;
      if (resetMs && mtime.getTime() <= resetMs) continue;
      if (!_isSessionMemoryOn(filePath)) continue;
      const sessionId = _sessionIdentityForPath(filePath);
      const existing = summaryManager.getSummary(sessionId);
      const existingSummaryAt = existing?.updated_at ? new Date(existing.updated_at).getTime() : 0;
      const enabledFrom = _getSessionMemoryEnabledFrom(filePath);
      const enabledFromTime = enabledFrom ? new Date(enabledFrom).getTime() : 0;
      const effectiveSummaryAt = Math.max(existingSummaryAt, enabledFromTime, resetMs || 0);
      if (mtime.getTime() > effectiveSummaryAt + 5000) { // 5s 宽限，避免极近时间戳误判
        await _doRollingSummary(filePath, "recovery");
        recovered += 1;
      }
    }
    const context = _restoreDailyProgress();
    if (recovered > 0) {
      _clearPersistedDailyProgress(context, "summary recovery");
    }
    return recovered;
  }

  /**
  *
   */
  async function tick() {
    if (_stopped) return;
    const p = _tickCore();
    _tickInFlight = p;
    try { await p; } finally { if (_tickInFlight === p) _tickInFlight = null; }
  }

  async function _tickCore() {
    if (!_isMemoryMasterOn()) return;
    await _recoverUnsummarized(); // 补偿崩溃/重启前未收尾的 session
    const todayStr = getLogicalDay().logicalDate;
    if (_lastDailyJobDate !== todayStr) {
      await _doDaily(); // 启动时 await，确保中间文件就绪后再 assemble
    }
    await _doCompileTodayAndAssemble();
  }

  /**
  * */
  function triggerNow() {
    if (_stopped) return;
    tick().catch(() => {});
  }

  /**
 * Session promote 后调用（心跳/cron session -activity/ 移到 sessions/ 后）
  *
   */
  async function notifyPromoted(sessionPath) {
    if (_stopped) return;
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    try {
      await _doRollingSummary(sessionPath, "promoted");
      await _doCompileTodayAndAssemble();
      debugLog()?.log("memory", `promoted session summarized: ${path.basename(sessionPath).slice(0, 20)}...`);
    } catch (err) {
      console.error(`\x1b[90m[memory-ticker] notifyPromoted 失败: ${err.message}\x1b[0m`);
    }
 //
    _turnCounts.set(sessionPath, 1);
  }

  /**
 * 强制刷新指定 session 的摘要（日记等功能调用前确保摘要最新）
   * @param {string} sessionPath
   */
  async function flushSession(sessionPath) {
    if (_stopped) return;
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    await _doRollingSummary(sessionPath, "manual");
  }

  /**
   * Force one session into the compiled memory view before an external compact
   * consumes it. Bridge sessions do not always have a clean "session end" event.
   * @param {string} sessionPath
   */
  async function flushSessionAndCompile(sessionPath) {
    if (_stopped) return;
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    await _doRollingSummary(sessionPath, "manual");
    await _doCompileTodayAndAssemble();
    _turnCounts.delete(sessionPath);
  }

  function getHealthStatus() {
    const snapshot = {};
    for (const key of _stepKeys) snapshot[key] = { ..._health[key] };
    return snapshot;
  }

  return {
    start,
    stop,
    tick,
    triggerNow,
    notifyTurn,
    notifySessionEnd,
    notifyPromoted,
    flushSession,
    flushSessionAndCompile,
    getHealthStatus,
  };
}
