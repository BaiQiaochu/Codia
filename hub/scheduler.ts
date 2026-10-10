// @ts-nocheck


import fs from "fs";
import path from "path";
import { createHeartbeat } from "../lib/desk/heartbeat.ts";
import { createCronScheduler } from "../lib/desk/cron-scheduler.ts";
import { getLocale } from "../lib/i18n.ts";
import { createFreshCompactDailyScheduler } from "../lib/fresh-compact/daily-scheduler.ts";
import { FreshCompactMaintainer } from "./fresh-compact-maintainer.ts";
import { WORKSPACE_OUTPUT_ROOT_DIRNAME } from "../shared/workspace-output.ts";
import { getAutomationExecutor } from "../lib/desk/automation-executors.ts";

function normalizeCronExecutionContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      kind: "missing",
      cwd: null,
      workspaceFolders: [],
      sourceSessionPath: null,
    };
  }
  return {
    kind: typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : "session_workspace",
    cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd : null,
    workspaceFolders: Array.isArray(value.workspaceFolders)
      ? value.workspaceFolders.filter(p => typeof p === "string" && p.trim())
      : [],
    sourceSessionPath: typeof value.sourceSessionPath === "string" && value.sourceSessionPath.trim()
      ? value.sourceSessionPath
      : null,
  };
}

export class Scheduler {
  /**
   * @param {object} opts
   * @param {import('./index.ts').Hub} opts.hub
   */
  constructor({ hub }) {
    this._hub = hub;
    this._heartbeats = new Map(); // agentId -> heartbeat instance
    this._agentCrons = new Map(); // agentId -> CronScheduler
    this._cronStores = new Map(); // agentId -> CronStore
    this._cronScheduler = null; // Studio CronScheduler
    this._cronStore = null;
    this._executingJobs = new Map(); // jobId -> AbortController
    this._freshCompactMaintainer = new FreshCompactMaintainer({ hub });
    this._freshCompactScheduler = createFreshCompactDailyScheduler({
      runDaily: (opts) => this._freshCompactMaintainer.runDaily(opts),
      warn: (msg) => console.warn(msg),
    });
  }

  /** @returns {import('../core/engine.ts').CodiaEngine} */
  get _engine() { return this._hub.engine; }

  /** Get one agent's heartbeat instance. */
  getHeartbeat(agentId) {
    if (!agentId) return null;
    return this._heartbeats.get(agentId) ?? null;
  }

  /** Expose the scheduler for a cron job owner. */
  getCronScheduler(agentId) {
    if (!agentId) return null;
    return this._cronScheduler ?? this._agentCrons.get(agentId) ?? null;
  }

  async runAgentCronNow(agentId, jobId) {
    if (this._cronScheduler && this._cronStore) {
      const job = this._cronStore.getJob(jobId);
      if (!job) throw new Error(`cron job "${jobId}" not found`);
      const owner = job.actorAgentId || job.legacyRef?.agentId || null;
      if (owner && agentId && owner !== agentId) {
        throw new Error(`cron job "${jobId}" belongs to agent "${owner}"`);
      }
      return this._cronScheduler.runNow(job);
    }
    const sched = this._agentCrons.get(agentId);
    if (!sched) throw new Error(`cron scheduler not initialized for agent "${agentId}"`);
    const store = this._cronStores.get(agentId);
    const job = store?.getJob(jobId);
    if (!job) throw new Error(`cron job "${jobId}" not found`);
    return sched.runNow(job);
  }

  _canRunAgentJobs(agentId, explicitModel) {
    if (typeof this._engine.canRunBackgroundTask !== "function") return true;
    return this._engine.canRunBackgroundTask(agentId, explicitModel);
  }

 //

  start() {
    void this.syncAvailability();
    this._startStudioCron();
    this._freshCompactScheduler.start();
  }

  async stop() {
    this._freshCompactScheduler.stop();
    await this.stopHeartbeat();
    if (this._cronScheduler) {
      await this._cronScheduler.stop();
      this._cronScheduler = null;
      this._cronStore = null;
    }
    for (const sched of this._agentCrons.values()) {
      await sched.stop();
    }
    this._agentCrons.clear();
    this._cronStores.clear();
  }

  /** Ensure cron scheduling is started. */
  startAgentCron(_agentId) {
    this._startStudioCron();
  }

  /** Start heartbeat for an agent. */
  startAgentHeartbeat(agentId, agent) {
    if (this._canRunAgentJobs(agentId)) this._startAgentHeartbeat(agentId, agent);
  }

  /** Stop and remove one agent's cron scheduler. */
  async removeAgentCron(agentId) {
    const sched = this._agentCrons.get(agentId);
    if (sched) {
      await sched.stop();
      this._agentCrons.delete(agentId);
    }
    this._cronStores.delete(agentId);
  }

  /** Rebuild heartbeat for one agent or all agents. */
  async reloadHeartbeat(agentId) {
    if (agentId) {
      await this.stopHeartbeat(agentId);
      const agent = this._engine.getAgent(agentId);
      if (agent && this._canRunAgentJobs(agentId)) this._startAgentHeartbeat(agentId, agent);
      return;
    }
    await this.stopHeartbeat();
    this.startHeartbeat();
  }

  startHeartbeat() {
    for (const [agentId, agent] of this._engine.agents || []) {
      if (!this._canRunAgentJobs(agentId)) continue;
      this._startAgentHeartbeat(agentId, agent);
    }
  }

  async syncAvailability() {
    for (const [agentId, hb] of this._heartbeats) {
      if (this._canRunAgentJobs(agentId)) continue;
      await hb.stop();
      this._heartbeats.delete(agentId);
    }

    for (const [agentId, sched] of this._agentCrons) {
      await sched.stop();
      this._agentCrons.delete(agentId);
      this._cronStores.delete(agentId);
    }
    this._startStudioCron();

    for (const [agentId, agent] of this._engine.agents || []) {
      if (!this._canRunAgentJobs(agentId)) continue;
      this._startAgentHeartbeat(agentId, agent);
    }
  }

  _startAgentHeartbeat(agentId, agent) {
    if (this._heartbeats.has(agentId)) return; // idempotent

    const engine = this._engine;
    const hbInterval = agent.config?.desk?.heartbeat_interval;
    const masterEnabled = engine.getHeartbeatMaster() !== false;
    const hbEnabled = masterEnabled && agent.config?.desk?.heartbeat_enabled === true;
    // Per-agent workspace fallback.
    const getWorkspace = () => engine.getHomeCwd(agentId);
    const hb = createHeartbeat({
      getDeskFiles: async () => {
        try {
          const dir = getWorkspace();
          if (!dir) return [];
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
          catch { return []; }
          const items = await Promise.all(
            entries
              .filter(e => !e.name.startsWith(".") && e.name !== WORKSPACE_OUTPUT_ROOT_DIRNAME)
              .map(async (e) => {
                const fp = path.join(dir, e.name);
                let mtime = 0;
                try { mtime = (await fs.promises.stat(fp)).mtimeMs; } catch {}
                return { name: e.name, isDir: e.isDirectory(), mtime };
              })
          );
          return items;
        } catch { return []; }
      },
      getWorkspacePath: getWorkspace,
      getAgentName: () => agent.agentName,
      registryPath: path.join(agent.deskDir, "jian-registry.json"),
      overwatchPath: path.join(agent.deskDir, "overwatch.md"),
      onBeat: (prompt) => this._executeActivityForAgent(agentId, prompt, "heartbeat", null, { withMemory: true }),
      onJianBeat: (prompt, cwd, options = {}) => {
        const isZh = getLocale().startsWith("zh");
        const extraCustomTools = Array.isArray(options?.customTools) ? options.customTools : [];
        this._executeActivityForAgent(agentId, prompt, "heartbeat", `${isZh ? "剪" : "jian"}:${path.basename(cwd)}`, { cwd, withMemory: true, extraCustomTools });
      },
      intervalMinutes: hbInterval,
      emitDevLog: (text, level) => engine.emitDevLog(text, level),
      locale: agent.config?.locale,
    });
    this._heartbeats.set(agentId, hb);
    if (hbEnabled) hb.start();
  }

  async stopHeartbeat(agentId) {
    if (agentId) {
      const hb = this._heartbeats.get(agentId);
      if (hb) { await hb.stop(); this._heartbeats.delete(agentId); }
      return;
    }
    // Stop all heartbeats in parallel.
    await Promise.all([...this._heartbeats.values()].map(hb => hb.stop()));
    this._heartbeats.clear();
  }

  // ──────────── Per-agent Cron ────────────

  _startAllCrons() {
    this._startStudioCron();
  }

  _startAgentCron(_agentId) {
    this._startStudioCron();
  }

  _startStudioCron() {
    if (this._cronScheduler) return;
    const engine = this._engine;
    const cronStore = engine.getStudioCronStore?.();
    if (!cronStore) return;

    const sched = createCronScheduler({
      cronStore,
      executeJob: (job) => this._executeCronJob(job),
      abortJob: (jobId) => {
        const ac = this._executingJobs.get(jobId);
        if (ac) { ac.abort(); console.log(`\x1b[90m[scheduler] cron abort ${jobId} (timeout)\x1b[0m`); }
      },
      onJobDone: (job, result) => {
        this._hub.eventBus.emit(
          {
            type: "cron_job_done",
            jobId: job.id,
            label: job.label,
            agentId: job.actorAgentId,
            actorAgentId: job.actorAgentId,
            result,
          },
          null,
        );
      },
    });
    this._cronScheduler = sched;
    this._cronStore = cronStore;
    sched.start();
    console.log("\x1b[90m[scheduler] studio cron started\x1b[0m");
  }

  // Execution

  async _executeCronJob(job) {
    const executor = getAutomationExecutor(job);
    if (executor.kind !== "agent_session") {
      throw new Error(`unsupported automation executor: ${executor.kind}`);
    }

    const actorAgentId = executor.agentId || job.actorAgentId || job.legacyRef?.agentId || null;
    if (!actorAgentId) {
      throw new Error(`cron job ${job.id} missing actorAgentId`);
    }
    return this._executeCronJobForAgent(actorAgentId, {
      ...job,
      prompt: typeof executor.prompt === "string" ? executor.prompt : job.prompt,
      model: executor.model ?? job.model,
      executionContext: executor.executionContext || job.executionContext || null,
    });
  }

  /**
   * Run a cron job for an agent. The per-job lock below prevents duplicate
   * runs of the same job while allowing different jobs to run concurrently.
   */
  async _executeCronJobForAgent(agentId, job) {
    if (!this._canRunAgentJobs(agentId, job.model || undefined)) {
      const err = new Error(`cron job ${job.id} skipped: no runnable model`);
      err.skipped = true;
      throw err;
    }
    // Per-job lock: the same job cannot run concurrently.
    if (this._executingJobs.has(job.id)) {
      console.log(`\x1b[90m[scheduler] cron skipped ${job.id}: previous run still active\x1b[0m`);
      const err = new Error(`cron job ${job.id} is already running`);
      err.skipped = true;
      throw err;
    }
    const ac = new AbortController();
    this._executingJobs.set(job.id, ac);
    try {
      const isZh = getLocale().startsWith("zh");
      const prompt = isZh
        ? [
            `[定时任务 ${job.id}: ${job.label}]`,
            "",
            "**注意：这是系统自动触发的定时任务，不是用户消息。**",
            "**不要在执行过程中创建新的定时任务。**",
            "",
            job.prompt,
          ].join("\n")
        : [
            `[Cron job ${job.id}: ${job.label}]`,
            "",
            "**Note: This is an automated cron job, NOT a user message.**",
            "**Do not create new cron jobs during execution.**",
            "",
            job.prompt,
          ].join("\n");
      await this._executeActivityForAgent(agentId, prompt, "cron", job.label, {
        model: job.model || undefined,
        signal: ac.signal,
        ...this._cronExecutionOptions(job),
      });
    } finally {
      this._executingJobs.delete(job.id);
    }
  }

  _cronExecutionOptions(job) {
    const ctx = normalizeCronExecutionContext(job.executionContext);
    const opts = {};
    if (ctx.cwd) opts.cwd = ctx.cwd;
    opts.workspaceFolders = ctx.workspaceFolders;
    if (ctx.sourceSessionPath) opts.parentSessionPath = ctx.sourceSessionPath;
    return opts;
  }

  /**
   * Run background activity through the isolated-agent path.
   */
  async _executeActivityForAgent(agentId, prompt, type, label, opts = {}) {
    const engine = this._engine;
    await engine.ensureAgentRuntime?.(agentId, {
      priority: "background",
      reason: type,
    });
    const agentDir = path.join(engine.agentsDir, agentId);
    const activityDir = path.join(agentDir, "activity");
    const startedAt = Date.now();
    const id = `${type === "heartbeat" ? "hb" : "cron"}_${startedAt}`;

    // Execute through the isolated-agent path.
    const { signal, ...restOpts } = opts;
    const result = await engine.executeIsolated(prompt, {
      agentId,
      persist: activityDir,
      signal,
      activityType: type,
      ...restOpts,
    });
    const { sessionPath, error } = result;

    const finishedAt = Date.now();
    const failed = !!error;

    // Resolve display name from the long-lived agent.
    const ag = engine.getAgent(agentId);
    const agentName = ag?.agentName || agentId;

    // Generate an activity summary when a session file was produced.
    let summary = null;
    if (typeof sessionPath === "string" && sessionPath) {
      try {
        summary = await engine.summarizeActivity(sessionPath, undefined, { agentId });
      } catch {}
    }

    const entry = {
      id,
      type,
      label: label || null,
      agentId,
      agentName,
      startedAt,
      finishedAt,
      summary: (() => {
        const isZhS = getLocale().startsWith("zh");
        const hbLabel = isZhS ? "日常巡检" : "routine patrol";
        const cronLabel = isZhS ? "定时任务" : "cron job";
        const failSuffix = isZhS ? "执行失败" : "execution failed";
        if (failed) return `${label || (type === "heartbeat" ? hbLabel : cronLabel)} ${failSuffix}`;
        return summary || (type === "heartbeat" ? hbLabel : (label || cronLabel));
      })(),
      sessionFile: typeof sessionPath === "string" ? path.basename(sessionPath) : null,
      status: failed ? "error" : "done",
      error: error || null,
    };

    // Persist to the agent activity store.
    engine.getActivityStore(agentId).add(entry);

    // Broadcast activity changes to desktop and PWA clients.
    this._hub.eventBus.emit({ type: "activity_update", activity: entry }, null);

    if (failed) {
      const isZhR = getLocale().startsWith("zh");
      const reason = error || (isZhR ? "后台任务未生成 session" : "background task produced no session");
      engine.emitDevLog(`[${type}] ${label || "后台任务"} 失败: ${reason}`, "error");
      throw new Error(reason);
    }

    engine.emitDevLog(`活动记录: ${entry.summary}`, "heartbeat");
  }

}
