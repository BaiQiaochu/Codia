// @ts-nocheck
/**
  *
 *
  *
 *
  *
  * */

import fs from "fs";
import path from "path";
import { normalizeAutomationJob, normalizeAutomationJobs } from "./automation-normalizer.ts";
import { parseModelRef } from "../../shared/model-ref.ts";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

export function normalizeCronModelRef(model) {
  const parsed = parseModelRef(model);
  if (!parsed?.id) return "";
  if (parsed.provider) return { id: parsed.id, provider: parsed.provider };
  return parsed.id;
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(JSON.stringify(value));
}

function deriveJobLabel({ label, prompt, executor }) {
  if (typeof label === "string" && label.trim()) return label;
  if (typeof prompt === "string" && prompt.trim()) return prompt.slice(0, 30);
  const params = executor && typeof executor === "object" && !Array.isArray(executor) ? executor.params : null;
  if (typeof params?.title === "string" && params.title.trim()) return params.title.slice(0, 30);
  return "";
}

function validateAutomationExecutorForWrite(executor) {
  if (!executor) return;
  if (!executor.kind || executor.kind === "agent_session") return;
  throw new Error(`unsupported automation executor: ${executor.kind}`);
}

function isAgentSessionAutomation(job) {
  const normalized = normalizeAutomationJob(job);
  return !normalized.executor || normalized.executor.kind === "agent_session";
}

function assertCanEnableAutomationJob(job) {
  if (!job?.enabled) return;
  if (!isAgentSessionAutomation(job)) return;
  if (typeof job.prompt === "string" && job.prompt.trim()) return;
  throw new Error("prompt required to enable agent automation");
}

export class CronStore {
 /** */
  static BACKOFF = [0, 60_000, 300_000, 900_000, 3_600_000];

  /**
 * @param {string} jobsPath - cron-jobs.json 路径
 * @param {string} runsDir - cron-runs/ 目录路径
   */
  constructor(jobsPath, runsDir, options = {}) {
    this._jobsPath = jobsPath;
    this._runsDir = runsDir;
    this._idPrefix = options.idPrefix || "job";
    this._jobs = [];
    this._nextNum = 1;
    this._runLineCounts = new Map();
    this._load();
  }

  // ════════════════════════════
  //

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this._jobsPath, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") {
 // 首次启动，文件不存在，静默处-
        this._jobs = [];
        this._nextNum = 1;
        return;
      }
      console.error("[CronStore] 读取 jobs 文件失败:", err.message);
      this._jobs = [];
      this._nextNum = 1;
      return;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
 // JSON 损坏，尝试从 .tmp 恢复
      const tmpPath = this._jobsPath + ".tmp";
      try {
        const tmpRaw = fs.readFileSync(tmpPath, "utf-8");
        data = JSON.parse(tmpRaw);
        console.error("[CronStore] 主 JSON 损坏，已从 .tmp 恢复");
      } catch {
        console.error("[CronStore] JSON parse failed and no usable .tmp file exists; resetting to empty state");
        this._jobs = [];
        this._nextNum = 1;
        return;
      }
    }

    this._jobs = Array.isArray(data.jobs) ? data.jobs : [];
    this._nextNum = data.nextNum ?? (this._jobs.length + 1);

 // 旧数据清-
    let dirty = false;
    for (const job of this._jobs) {
      //
      const normalizedModel = normalizeCronModelRef(job.model);
      if (JSON.stringify(job.model ?? "") !== JSON.stringify(normalizedModel)) {
        job.model = normalizedModel;
        dirty = true;
      }
 //
      if (job.type === "every" && typeof job.schedule === "number" && job.schedule < 60000) {
        job.schedule = 60000;
        dirty = true;
      }
 //
      if (job.consecutiveErrors === undefined) {
        job.consecutiveErrors = 0;
        dirty = true;
      }
    }
    const normalizedJobs = normalizeAutomationJobs(this._jobs);
    if (JSON.stringify(this._jobs) !== JSON.stringify(normalizedJobs)) {
      dirty = true;
    }
    this._jobs = normalizedJobs;

    if (dirty) {
      this._save();
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this._jobsPath), { recursive: true });
    const data = JSON.stringify({
      jobs: this._jobs,
      nextNum: this._nextNum,
    }, null, 2) + "\n";
 //
    atomicWriteSync(this._jobsPath, data);
  }

  // ════════════════════════════
  //  Job CRUD
  // ════════════════════════════

  /**
   * Add a scheduled job.
   * @param {object} opts
   * @param {"at"|"every"|"cron"} opts.type - 调度类型
   * @param {string|number} opts.schedule - 调度参数
   * @param {string} opts.prompt - 执行时的 prompt
   * @param {string} [opts.mode="isolated"] - 执行模式
   */
  addJob({
    type,
    schedule,
    prompt,
    mode = "isolated",
    label = "",
    model = "",
    actorAgentId = null,
    executionContext = null,
    legacyRef = null,
    executor = null,
    createdBy = null,
    enabled = true,
  }) {
    // type 枚举校验
    const VALID_TYPES = new Set(["at", "every", "cron"]);
    if (!VALID_TYPES.has(type)) {
      throw new Error(`无效的 job type: "${type}"; expected at, every, or cron`);
    }

    schedule = this._normalizeAndValidateSchedule(type, schedule);

    const now = new Date().toISOString();
    validateAutomationExecutorForWrite(executor);

    const job = {
      id: this._nextJobId(),
      type,
      schedule,
      prompt: typeof prompt === "string" ? prompt : "",
      mode,
      label: deriveJobLabel({ label, prompt, executor }),
      model: normalizeCronModelRef(model),
      enabled: enabled !== false,
      consecutiveErrors: 0,
      createdAt: now,
      lastRunAt: null,
      nextRunAt: this._calcNextRun(type, schedule, now),
    };
    this._attachOwnershipFields(job, { actorAgentId, executionContext, legacyRef });
    this._attachAutomationFields(job, { executor, createdBy });

    const normalized = normalizeAutomationJob(job);
    assertCanEnableAutomationJob(normalized);
    this._jobs.push(normalized);
    this._save();
    return normalized;
  }

  addImportedJob(input) {
    const VALID_TYPES = new Set(["at", "every", "cron"]);
    const type = input?.type;
    if (!VALID_TYPES.has(type)) {
      throw new Error(`无效的 job type: "${type}"; expected at, every, or cron`);
    }
    if (typeof input.prompt !== "string" || !input.prompt.trim()) {
      const explicitExecutor = clonePlainObject(input.executor);
      if (!explicitExecutor) throw new Error("cron import requires prompt");
    }
    validateAutomationExecutorForWrite(input.executor);

    let schedule = input.schedule;
    if (type === "every") {
      const ms = typeof schedule === "number" ? schedule : parseInt(schedule, 10);
      if (Number.isFinite(ms) && ms < 60000) schedule = 60000;
    }

    const now = new Date().toISOString();
    const job = {
      id: this._nextJobId(),
      type,
      schedule,
      prompt: typeof input.prompt === "string" ? input.prompt : "",
      mode: input.mode || "isolated",
      label: deriveJobLabel({ label: input.label, prompt: input.prompt, executor: input.executor }),
      model: normalizeCronModelRef(input.model),
      enabled: input.enabled !== false,
      consecutiveErrors: Number.isFinite(input.consecutiveErrors) ? input.consecutiveErrors : 0,
      createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
      lastRunAt: typeof input.lastRunAt === "string" ? input.lastRunAt : null,
      nextRunAt: typeof input.nextRunAt === "string" || input.nextRunAt === null
        ? input.nextRunAt
        : this._calcNextRun(type, schedule, now),
    };
    this._attachOwnershipFields(job, input);
    this._attachAutomationFields(job, input);

    const normalized = normalizeAutomationJob(job);
    assertCanEnableAutomationJob(normalized);
    this._jobs.push(normalized);
    this._save();
    return normalized;
  }

  _nextJobId() {
    return `${this._idPrefix}_${this._nextNum++}`;
  }

  _attachOwnershipFields(job, { actorAgentId = null, executionContext = null, legacyRef = null } = {}) {
    if (typeof actorAgentId === "string" && actorAgentId.trim()) {
      job.actorAgentId = actorAgentId.trim();
    }
    const clonedExecutionContext = clonePlainObject(executionContext);
    if (clonedExecutionContext) job.executionContext = clonedExecutionContext;
    const clonedLegacyRef = clonePlainObject(legacyRef);
    if (clonedLegacyRef) job.legacyRef = clonedLegacyRef;
  }

  _attachAutomationFields(job, { executor = null, createdBy = null } = {}) {
    const clonedExecutor = clonePlainObject(executor);
    if (clonedExecutor) job.executor = clonedExecutor;
    const clonedCreatedBy = clonePlainObject(createdBy);
    if (clonedCreatedBy) job.createdBy = clonedCreatedBy;
  }

  /**
   * 删除任务
   * @param {string} id
   * @returns {boolean}
   */
  removeJob(id) {
    const idx = this._jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this._jobs.splice(idx, 1);
    this._save();
    return true;
  }

  /**
   * 获取单个任务
   * @param {string} id
   * @returns {object|null}
   */
  getJob(id) {
    const job = this._jobs.find(j => j.id === id) || null;
    return job ? normalizeAutomationJob(job) : null;
  }

  /**
 * 列出所有任务（每次从磁盘重读，确保跨实例的写入都能被感知）
   * @returns {object[]}
   */
  listJobs() {
    this._load();
    return this._jobs.map((job) => normalizeAutomationJob(job));
  }

  /**
    *
   * @param {string} id
   * @param {object} partial
   * @returns {object|null}
   */
  updateJob(id, partial) {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return null;

    const ALLOWED = new Set([
      "type",
      "label",
      "model",
      "schedule",
      "prompt",
      "enabled",
      "actorAgentId",
      "executionContext",
      "executor",
      "createdBy",
    ]);

    const next = { ...job };
    for (const key of Object.keys(partial)) {
      if (!ALLOWED.has(key)) continue;
      let value = partial[key];

      if (key === "model") value = normalizeCronModelRef(value);
      if (key === "executor") validateAutomationExecutorForWrite(value);

      next[key] = value;
    }

 // schedule 变更时重新计-nextRunAt
    if ("schedule" in partial || "type" in partial) {
      next.schedule = this._normalizeAndValidateSchedule(next.type, next.schedule);
      next.nextRunAt = this._calcNextRun(next.type, next.schedule, new Date().toISOString());
    }

    Object.assign(job, next);
    const normalized = normalizeAutomationJob(job);
    assertCanEnableAutomationJob(normalized);
    Object.assign(job, normalized);
    this._save();
    return normalized;
  }

  /**
 * 切换任务启用/禁用
   * @param {string} id
   * @returns {object|null}
   */
  toggleJob(id) {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return null;
    job.enabled = !job.enabled;
    if (job.enabled) {
 // 重新计算下次执行时间
      job.nextRunAt = this._calcNextRun(job.type, job.schedule, new Date().toISOString());
    }
    const normalized = normalizeAutomationJob(job);
    assertCanEnableAutomationJob(normalized);
    Object.assign(job, normalized);
    this._save();
    return normalized;
  }

  /**
    *
   * @param {string} id
   * @param {object} [opts]
 * @param {boolean} [opts.success=true] - 是否执行成功
   */
  markRun(id, { success = true } = {}) {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return;
    const now = new Date().toISOString();
    job.lastRunAt = now;

    if (success) {
      job.consecutiveErrors = 0;
      job.nextRunAt = this._calcNextRun(job.type, job.schedule, now);
    } else {
      job.consecutiveErrors = (job.consecutiveErrors || 0) + 1;
      const normalNext = this._calcNextRun(job.type, job.schedule, now);
      const backoffIdx = Math.min(job.consecutiveErrors, CronStore.BACKOFF.length - 1);
      const backoffMs = CronStore.BACKOFF[backoffIdx];
      const backoffNext = new Date(Date.now() + backoffMs).toISOString();
      job.nextRunAt = normalNext && normalNext > backoffNext ? normalNext : backoffNext;
    }

 // "at" 类型执行丢次后自动禁用
    if (job.type === "at") {
      job.enabled = false;
    }

    this._save();
  }

  // ════════════════════════════
 // 运行历史
  // ════════════════════════════

  /**
  *
    *
   */
  logRun(jobId, run) {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    const line = JSON.stringify({ ...run, timestamp: new Date().toISOString() }) + "\n";
    fs.mkdirSync(this._runsDir, { recursive: true });
    let lineCount = this._runLineCounts.get(filePath);
    if (lineCount === undefined) {
      lineCount = this._countRunLines(filePath);
    }
    fs.appendFileSync(filePath, line, "utf-8");
    lineCount += 1;

 //
    try {
      if (lineCount > 500) {
        lineCount = this._trimRunFile(filePath);
      }
    } catch { /* 修剪失败不影响主流程 */ }
    this._runLineCounts.set(filePath, lineCount);
  }

  _countRunLines(filePath) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      return raw ? raw.split("\n").length : 0;
    } catch {
      return 0;
    }
  }

  _trimRunFile(filePath) {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length <= 500) return lines.length;
    const kept = lines.slice(-300);
    atomicWriteSync(filePath, kept.join("\n") + "\n");
    return kept.length;
  }

  /**
 * 读取运行历史
   * @param {string} jobId
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  getRunHistory(jobId, limit = 20) {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  调度计算
  // ════════════════════════════

  /**
 * 计算下次执行时间
   * @param {"at"|"every"|"cron"} type
   * @param {string|number} schedule
  *
   */
  _calcNextRun(type, schedule, fromISO) {
    const from = new Date(fromISO);

    switch (type) {
      case "at": {
 //
        const target = new Date(schedule);
        if (isNaN(target.getTime())) return null;
        return target > from ? target.toISOString() : null;
      }

      case "every": {
 // 间隔：从现在-schedule 毫秒-
        const ms = typeof schedule === "number" ? schedule : parseInt(schedule, 10);
        if (isNaN(ms) || ms <= 0) return null;
        return new Date(from.getTime() + ms).toISOString();
      }

      case "cron": {
 // 完整 5 字段 cron 解析
        return this._parseSimpleCron(schedule, from);
      }

      default:
        return null;
    }
  }

  _normalizeAndValidateSchedule(type, schedule) {
    if (type === "every") {
      const ms = typeof schedule === "number" ? schedule : parseInt(schedule, 10);
      if (isNaN(ms) || ms <= 0) {
        throw new Error(`invalid every schedule: "${schedule}"; expected a positive number`);
      }
      return Math.max(ms, 60000);
    }

    if (type === "at") {
      const target = new Date(schedule);
      if (isNaN(target.getTime())) {
        throw new Error(`无法解析为日期: "${schedule}"; expected a parseable date`);
      }
      if (target <= new Date()) {
        throw new Error(`必须是未来时间: "${schedule}"; expected a future time`);
      }
      return schedule;
    }

    if (type === "cron") {
      const nextRun = this._calcNextRun(type, schedule, new Date().toISOString());
      if (!nextRun) {
        throw new Error(`无效的 cron schedule: "${schedule}"`);
      }
      return schedule;
    }

    return schedule;
  }

  /**
  *
 * 语法：数-| * | *\/N | N-M | N-M/S | N,M,...
   *
  *
   * @returns {string|null}
   */
  _parseSimpleCron(expr, from) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const ranges = [
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12],
      [0, 6],
    ];

    const fields = [];
    for (let i = 0; i < 5; i++) {
      const set = this._parseCronField(parts[i], ranges[i][0], ranges[i][1], i === 4);
      if (!set) return null;
      fields.push(set);
    }

    const [minutes, hours, days, months, weekdays] = fields;
    const dayOfMonthRestricted = parts[2] !== "*";
    const dayOfWeekRestricted = parts[4] !== "*";

 //
    const start = new Date(from);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    const limit = 366 * 24 * 60;
    for (let i = 0; i < limit; i++) {
      const t = new Date(start.getTime() + i * 60_000);
      if (!months.has(t.getMonth() + 1)) continue;
      const matchesDayOfMonth = days.has(t.getDate());
      const matchesDayOfWeek = weekdays.has(t.getDay());
      const matchesDay =
        dayOfMonthRestricted && dayOfWeekRestricted
          ? (matchesDayOfMonth || matchesDayOfWeek)
          : (matchesDayOfMonth && matchesDayOfWeek);
      if (!matchesDay) continue;
      if (!hours.has(t.getHours())) continue;
      if (!minutes.has(t.getMinutes())) continue;
      return t.toISOString();
    }

    return null;
  }

  /** Parse one cron field into an allowed value set. */
  _parseCronField(field, min, max, isWeekday = false) {
    const values = new Set();

    for (const segment of field.split(",")) {
      // Step expression: */N.
      if (segment.startsWith("*/")) {
        const step = parseInt(segment.slice(2), 10);
        if (isNaN(step) || step <= 0) return null;
        for (let v = min; v <= max; v += step) values.add(v);
        continue;
      }

      // Wildcard expression.
      if (segment === "*") {
        for (let v = min; v <= max; v++) values.add(v);
        continue;
      }

      // Range expression: N-M or N-M/S.
      const rangeMatch = segment.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1], 10);
        const hi = parseInt(rangeMatch[2], 10);
        const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
        if (isNaN(lo) || isNaN(hi) || isNaN(step) || step <= 0) return null;
        if (lo > hi) return null;  // Reversed range.
        const effectiveMax = isWeekday ? 7 : max;
        if (lo < min || hi > effectiveMax) return null;  // Out of bounds.
        for (let v = lo; v <= hi; v += step) values.add(isWeekday && v === 7 ? 0 : v);
        continue;
      }

      //
      const num = parseInt(segment, 10);
      if (isNaN(num)) return null;
      const effectiveMax = isWeekday ? 7 : max;
      if (num < min || num > effectiveMax) return null;  // Out of bounds.
      values.add(isWeekday && num === 7 ? 0 : num);
    }

    return values.size > 0 ? values : null;
  }

  /** Number of jobs. */
  get size() {
    return this._jobs.length;
  }

  /** Number of enabled jobs. */
  get enabledCount() {
    return this._jobs.filter(j => j.enabled).length;
  }
}
