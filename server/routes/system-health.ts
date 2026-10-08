// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { createStartupHealthSnapshot } from "../startup-health.ts";

const EMPTY_DEFERRED_SUMMARY = Object.freeze({
  total: 0,
  pending: 0,
  resolved: 0,
  failed: 0,
  aborted: 0,
  delivered: 0,
  undelivered: 0,
});

const EMPTY_RECOVERY_SUMMARY = Object.freeze({
  attention: 0,
  failed: 0,
  aborted: 0,
  undelivered: 0,
});

export function createSystemHealthRoute(engine = {}, options = {}) {
  const route = new Hono();
  const localHealthPath = options.localHealthPath
    || path.join(process.cwd(), "artifacts", "program-review-local-health.json");

  route.get("/system/health", (c) => {
    const localHealth = readLocalHealth(localHealthPath);
    const plugins = summarizePlugins(engine.pluginManager);
    const tasks = summarizeTasks(engine.taskRegistry);
    const deferred = typeof engine.deferredResults?.summary === "function"
      ? { ...EMPTY_DEFERRED_SUMMARY, ...engine.deferredResults.summary() }
      : { ...EMPTY_DEFERRED_SUMMARY };
    const recovery = summarizeRecovery(engine.taskRegistry, engine.deferredResults);
    const media = summarizeMedia(engine.providerRegistry);
    const models = summarizeModels(engine.availableModels);
    const startup = createStartupHealthSnapshot({
      projectRoot: options.projectRoot || process.cwd(),
      artifactsDir: options.artifactsDir || path.join(process.cwd(), "artifacts"),
      bridgeManager: options.bridgeManager || null,
      resourcesPath: options.resourcesPath || process.resourcesPath || "",
      platform: options.platform || process.platform,
    });

    return c.json({
      generatedAt: new Date().toISOString(),
      localHealth,
      startup,
      plugins,
      tasks,
      deferred,
      recovery: recovery.summary,
      media,
      models,
    });
  });

  route.get("/system/ops-overview", (c) => {
    const projectRoot = options.projectRoot || process.cwd();
    const artifactsDir = options.artifactsDir || path.join(projectRoot, "artifacts");
    const startup = createStartupHealthSnapshot({
      projectRoot,
      artifactsDir,
      bridgeManager: options.bridgeManager || null,
      resourcesPath: options.resourcesPath || process.resourcesPath || "",
      platform: options.platform || process.platform,
    });
    const localHealth = readLocalHealth(localHealthPath);
    const localPreflight = readLocalPreflightChecks(localHealthPath);
    const plugins = summarizePlugins(engine.pluginManager);
    const tasks = summarizeTasks(engine.taskRegistry);
    const deferred = typeof engine.deferredResults?.summary === "function"
      ? { ...EMPTY_DEFERRED_SUMMARY, ...engine.deferredResults.summary() }
      : { ...EMPTY_DEFERRED_SUMMARY };
    const recovery = summarizeRecovery(engine.taskRegistry, engine.deferredResults);
    const media = summarizeMedia(engine.providerRegistry);
    const models = summarizeModels(engine.availableModels);

    return c.json({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      modules: [
        buildSystemHealthCenterModule({ localHealth, startup, plugins, tasks, deferred, recovery: recovery.summary, media, models, engine }),
        buildProviderDebuggerModule(engine),
        buildWorkflowAuditModule(engine, recovery.items),
        buildReleasePreflightModule(localPreflight),
      ],
    });
  });

  route.post("/system/diagnostic-package", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const projectRoot = options.projectRoot || process.cwd();
    const artifactsDir = options.artifactsDir || path.join(projectRoot, "artifacts");
    const runtimeSnapshot = typeof engine.runtimeDiagnostics?.snapshot === "function"
      ? engine.runtimeDiagnostics.snapshot()
      : {};
    const recentErrors = Array.isArray(body?.recentErrors)
      ? body.recentErrors
      : Array.isArray(body?.runtimeRecords)
        ? body.runtimeRecords
        : Array.isArray(runtimeSnapshot.records)
          ? runtimeSnapshot.records.filter((record) => record?.severity === "error" || record?.severity === "warn").slice(0, 50)
          : [];
    const packageSizeTrend = readJsonFile(path.join(artifactsDir, "package-size-trend.json"));
    const artifactSizes = summarizeArtifactSizes(projectRoot);
    const keyConfig = sanitizeKeyConfig(engine);
    const systemHealth = {
      localHealth: readLocalHealth(localHealthPath),
      startup: createStartupHealthSnapshot({
        projectRoot,
        artifactsDir,
        bridgeManager: options.bridgeManager || null,
        resourcesPath: options.resourcesPath || process.resourcesPath || "",
        platform: options.platform || process.platform,
      }),
      plugins: summarizePlugins(engine.pluginManager),
      tasks: summarizeTasks(engine.taskRegistry),
      media: summarizeMedia(engine.providerRegistry),
      models: summarizeModels(engine.availableModels),
    };
    return c.json({
      schemaVersion: 1,
      app: "BYOUNG",
      generatedAt: new Date().toISOString(),
      ui: {
        screenshot: sanitizePackageValue(body?.uiScreenshot || body?.screenshot || null),
        snapshot: sanitizePackageValue(body?.uiSnapshot || null),
      },
      runtime: {
        recentErrors: sanitizePackageValue(recentErrors),
        diagnostics: sanitizePackageValue(runtimeSnapshot.diagnostics || []),
      },
      artifacts: {
        packageSizeTrend,
        sizes: artifactSizes,
      },
      keyConfig,
      systemHealth,
      uiSnapshot: sanitizePackageValue(body?.uiSnapshot || null),
      recentErrors: sanitizePackageValue(recentErrors),
      packageSizeTrend,
      artifactSizes,
    });
  });

  route.get("/system/task-recovery", (c) => {
    const recovery = summarizeRecovery(engine.taskRegistry, engine.deferredResults);
    return c.json({
      generatedAt: new Date().toISOString(),
      ...recovery,
    });
  });

  route.post("/system/task-recovery/:taskId/retry", (c) => {
    const taskId = c.req.param("taskId");
    if (!engine.taskRegistry || typeof engine.taskRegistry.retry !== "function") {
      return c.json({ error: "task registry unavailable" }, 500);
    }
    const result = engine.taskRegistry.retry(taskId);
    if (result.status === "not_found") return c.json({ error: "task not found" }, 404);
    if (result.status === "unsupported") return c.json({ error: "task type does not support retry" }, 400);
    return c.json({ ok: true, status: result.status });
  });

  return route;
}

function readLocalHealth(localHealthPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(localHealthPath, "utf-8"));
    const checks = Array.isArray(raw.checks) ? raw.checks : [];
    return {
      available: true,
      ok: raw.ok === true,
      startedAt: raw.startedAt || null,
      finishedAt: raw.finishedAt || null,
      skippedBuild: raw.skippedBuild === true,
      checks: {
        total: checks.length,
        failed: checks.filter((check) => Number(check.status) !== 0).length,
      },
    };
  } catch {
    return {
      available: false,
      ok: null,
      startedAt: null,
      finishedAt: null,
      skippedBuild: null,
      checks: { total: 0, failed: 0 },
    };
  }
}

function readLocalPreflightChecks(localHealthPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(localHealthPath, "utf-8"));
    return Array.isArray(raw.checks) ? raw.checks : [];
  } catch {
    return [];
  }
}

function opsItem(id, label, value, status = "ok", detail = "", extra = {}) {
  return { id, label, value: String(value ?? ""), status, detail: detail ? String(detail) : "", ...extra };
}

function statusFromItems(items) {
  if (items.some((item) => item.status === "error")) return "error";
  if (items.some((item) => item.status === "warn")) return "warn";
  return "ok";
}

function buildSystemHealthCenterModule({ localHealth, startup, plugins, tasks, deferred, recovery, media, models, engine }) {
  const items = [
    opsItem(
      "local-health",
      "本地健康检查",
      localHealth.available
        ? `${localHealth.checks.failed || 0}/${localHealth.checks.total || 0} failed`
        : "no local report",
      !localHealth.available ? "warn" : localHealth.ok === false || (localHealth.checks.failed || 0) > 0 ? "error" : "ok",
      localHealth.finishedAt || "",
    ),
    opsItem(
      "plugins",
      "插件",
      `${plugins.summary.ok}/${plugins.summary.total} ok`,
      plugins.summary.error > 0 ? "error" : plugins.summary.warn > 0 ? "warn" : "ok",
      `warn ${plugins.summary.warn}, error ${plugins.summary.error}`,
      { actionTab: "plugins" },
    ),
    opsItem(
      "media-ocr",
      "媒体 / OCR",
      `image ${media.byType?.image?.models || 0}, video ${media.byType?.video?.models || 0}`,
      (media.byType?.image?.models || 0) > 0 ? "ok" : "warn",
      `providers ${media.providers?.length || 0}`,
      { actionTab: "media" },
    ),
    opsItem(
      "models",
      "模型",
      `${models.total || 0} models / ${models.providers || 0} providers`,
      (models.total || 0) > 0 ? "ok" : "warn",
      `vision ${models.vision || 0}, reasoning ${models.reasoning || 0}`,
      { actionTab: "providers" },
    ),
    opsItem(
      "workflow-tasks",
      "工作流 / 子助手",
      `${tasks.total || 0} tasks`,
      (recovery.failed || 0) > 0 || (recovery.aborted || 0) > 0 ? "error" : "ok",
      `attention ${recovery.attention || 0}, deferred ${deferred.total || 0}`,
    ),
    opsItem(
      "source-audits",
      "源树 / UI 审计",
      startup?.audits
        ? `${Object.values(startup.audits).filter((audit) => audit?.status === "ok").length}/${Object.keys(startup.audits).length} ok`
        : "no audit",
      startup?.audits && Object.values(startup.audits).some((audit) => audit?.status === "error") ? "error" : "ok",
    ),
  ];

  const licenseStatus = readLicenseStatus(engine);
  if (licenseStatus) {
    items.unshift(opsItem(
      "license",
      "授权",
      licenseStatus.state || licenseStatus.status || "unknown",
      licenseStatus.valid === false || licenseStatus.state === "invalid" ? "error" : "ok",
      licenseStatus.reason || "",
      { actionTab: "license" },
    ));
  }

  return {
    id: "system-health-center",
    title: "系统健康中心",
    status: statusFromItems(items),
    description: "授权、插件、媒体、模型、任务和源树检查的运行状态。",
    items,
  };
}

function readLicenseStatus(engine) {
  try {
    if (typeof engine.licenseService?.status === "function") return engine.licenseService.status();
    if (typeof engine.licenseService?.getStatus === "function") return engine.licenseService.getStatus();
    if (engine.licenseStatus) return engine.licenseStatus;
  } catch {}
  return null;
}

function buildProviderDebuggerModule(engine) {
  const providers = typeof engine.providerRegistry?.getAll === "function"
    ? [...engine.providerRegistry.getAll().values()]
    : [];
  const models = Array.isArray(engine.availableModels) ? engine.availableModels : [];
  const items = providers.length > 0
    ? providers.slice(0, 80).map((provider) => {
        const id = provider.id || provider.name || "provider";
        const providerModels = Array.isArray(provider.models)
          ? provider.models
          : models.filter((model) => model?.provider === id);
        const keySource = providerKeySource(provider);
        const status = keySource === "missing" ? "error" : "ok";
        return opsItem(
          `provider-${id}`,
          provider.displayName || provider.display_name || provider.name || id,
          `${keySource}; ${providerModels.length} models`,
          status,
          providerCapabilitySummary(providerModels),
          { actionTab: "providers", providerId: id, testModelId: providerTestModelId(providerModels) },
        );
      })
    : [opsItem("provider-empty", "供应商", "未配置", "warn", "没有可调试的供应商", { actionTab: "providers" })];

  return {
    id: "provider-debugger",
    title: "Provider 调试器",
    status: providerModuleStatus(items),
    description: "只显示密钥来源和模型能力，不暴露真实 API Key。",
    items,
  };
}

function providerModuleStatus(items) {
  const errors = items.filter((item) => item.status === "error").length;
  if (errors === 0) return statusFromItems(items);
  return errors >= items.length ? "error" : "warn";
}

function providerKeySource(provider) {
  const key = provider?.api_key || provider?.apiKey || provider?.key || "";
  if (!key) return "missing";
  if (typeof key === "string" && key.startsWith("gsap-runtime-api-key:")) return "runtime secret";
  return "saved secret";
}

function providerTestModelId(models) {
  const list = Array.isArray(models) ? models : [];
  for (const model of list) {
    if (typeof model === "string" && model.trim()) return model.trim();
    if (typeof model?.id === "string" && model.id.trim()) return model.id.trim();
    if (typeof model?.model === "string" && model.model.trim()) return model.model.trim();
    if (typeof model?.modelId === "string" && model.modelId.trim()) return model.modelId.trim();
  }
  return "";
}

function providerCapabilitySummary(models) {
  const list = Array.isArray(models) ? models : [];
  const chat = list.filter((model) => !model?.type || model.type === "chat" || model.type === "language").length;
  const image = list.filter((model) => model?.type === "image" || model?.type === "image_generation" || model?.input?.includes?.("image")).length;
  const video = list.filter((model) => model?.type === "video" || model?.type === "video_generation" || model?.input?.includes?.("video")).length;
  const audio = list.filter((model) => model?.type === "audio" || model?.type === "speech" || model?.input?.includes?.("audio")).length;
  const context = Math.max(0, ...list.map((model) => Number(model?.contextWindow || model?.context_window || 0)).filter(Number.isFinite));
  return `chat ${chat}, image ${image}, video ${video}, audio ${audio}${context ? `, context ${context}` : ""}`;
}

function buildWorkflowAuditModule(engine, recoveryItems = []) {
  const tasks = typeof engine.taskRegistry?.listAll === "function" ? engine.taskRegistry.listAll() : [];
  const workflowTasks = tasks.filter((task) => {
    const type = String(task?.type || task?.meta?.type || "").toLowerCase();
    return type.includes("workflow") || type.includes("subagent");
  });
  const failed = workflowTasks.filter((task) => task?.status === "failed" || task?.aborted === true).length;
  const running = workflowTasks.filter((task) => task?.status === "running" || task?.status === "pending").length;
  const succeeded = workflowTasks.filter((task) => task?.status === "succeeded" || task?.status === "resolved" || task?.status === "done").length;
  const attention = (Array.isArray(recoveryItems) ? recoveryItems : []).filter((item) => {
    const type = String(item?.type || "").toLowerCase();
    return type.includes("workflow") || type.includes("subagent");
  }).length;
  const summaryItems = [
    opsItem("workflow-succeeded", "已完成", succeeded, "ok"),
    opsItem("workflow-running", "运行中", running, "ok"),
    opsItem("workflow-failed", "失败 / 终止", failed, failed > 0 ? "error" : "ok"),
    opsItem("workflow-attention", "需处理", attention, attention > 0 ? "warn" : "ok"),
  ];
  const runItems = workflowTasks.slice(0, 12).map((task, index) => {
    const runId = workflowRunId(task, index);
    const status = String(task?.status || "unknown");
    return opsItem(
      `workflow-run-${runId}`,
      task?.name || task?.title || runId,
      status,
      workflowStatusToOpsStatus(status, task),
      workflowRunDetail(task),
    );
  });
  const items = runItems.length > 0 ? [...runItems, ...summaryItems] : summaryItems;
  return {
    id: "workflow-audit",
    title: "工作流执行审计",
    status: statusFromItems(items),
    description: "汇总工作流、子助手和可恢复任务的执行状态。",
    items,
  };
}

function workflowRunId(task, index) {
  return String(task?.runId || task?.taskId || task?.id || `run-${index + 1}`);
}

function workflowStatusToOpsStatus(status, task) {
  const normalized = String(status || "").toLowerCase();
  if (task?.aborted === true || normalized === "failed" || normalized === "error") return "error";
  if (normalized === "cancelled" || normalized === "aborted") return "warn";
  return "ok";
}

function workflowRunDetail(task) {
  const started = Number(task?.startedAt || task?.createdAt || task?.deferredAt || 0);
  const ended = Number(task?.finishedAt || task?.completedAt || task?.updatedAt || 0);
  const duration = started > 0 && ended >= started ? `${Math.round((ended - started) / 1000)}s` : "";
  const nodeCount = Array.isArray(task?.nodes)
    ? task.nodes.length
    : Array.isArray(task?.steps)
      ? task.steps.length
      : Array.isArray(task?.snapshot?.nodes)
        ? task.snapshot.nodes.length
        : 0;
  const failure = task?.failureReason || task?.error || task?.reason || "";
  const trigger = task?.triggerSource || task?.source || task?.channelId || task?.sessionId || task?.parentSessionPath || "";
  return [
    duration && `耗时 ${duration}`,
    nodeCount > 0 && `节点 ${nodeCount}`,
    trigger && `来源 ${trigger}`,
    failure && `失败原因 ${failure}`,
  ].filter(Boolean).join("；");
}

function buildReleasePreflightModule(checks) {
  const normalized = Array.isArray(checks) ? checks : [];
  const targets = [
    { id: "typecheck", label: "typecheck", patterns: [/typecheck/i, /tsc/i] },
    { id: "lint-quiet", label: "lint --quiet", patterns: [/lint/i] },
    { id: "source-tree-audit", label: "audit:source-tree --strict", patterns: [/source[-:]?tree/i, /audit:source-tree/i] },
    { id: "core-tests", label: "核心测试", patterns: [/test:core/i, /vitest/i, /core test/i] },
  ];
  const preflightChecks = targets.map((target) => {
    const found = normalized.find((check) => {
      const name = String(check?.name || check?.id || check?.command || "");
      return target.patterns.some((pattern) => pattern.test(name));
    });
    if (!found) return { id: target.id, label: target.label, status: "warn", detail: "没有最近结果" };
    const status = Number(found.status ?? found.exitCode ?? found.code ?? 0) === 0 ? "ok" : "error";
    return {
      id: target.id,
      label: target.label,
      status,
      detail: found.durationMs != null ? `${found.durationMs}ms` : String(found.detail || found.message || "最近结果可用"),
    };
  });
  return {
    id: "release-preflight",
    title: "发布前检查面板",
    status: statusFromItems(preflightChecks),
    description: "展示最近一次安全检查结果，不自动打包、不自动提交。",
    checks: preflightChecks,
    items: preflightChecks.map((check) => opsItem(check.id, check.label, check.detail, check.status)),
  };
}

function summarizePlugins(pluginManager) {
  const plugins = typeof pluginManager?.listPlugins === "function"
    ? pluginManager.listPlugins()
    : [];
  const summary = { total: 0, ok: 0, warn: 0, error: 0 };

  for (const plugin of plugins) {
    if (plugin?.hidden) continue;
    summary.total += 1;
    if (plugin.status === "failed" || plugin.status === "incompatible") {
      summary.error += 1;
    } else if (
      plugin.status === "disabled"
      || (Array.isArray(plugin.disabledTools) && plugin.disabledTools.length > 0)
    ) {
      summary.warn += 1;
    } else {
      summary.ok += 1;
    }
  }

  const items = plugins
    .filter((plugin) => !plugin?.hidden)
    .map((plugin) => {
      const reasons = [];
      if (plugin.error) reasons.push(String(plugin.error));
      if (Array.isArray(plugin.missingConfig) && plugin.missingConfig.length > 0) {
        reasons.push(`missing config: ${plugin.missingConfig.join(", ")}`);
      }
      if (Array.isArray(plugin.disabledTools) && plugin.disabledTools.length > 0) {
        reasons.push(`disabled tools: ${plugin.disabledTools.map((tool) => tool.name || tool.file || "unknown").join(", ")}`);
      }
      const health = plugin.status === "failed" || plugin.status === "incompatible"
        ? "error"
        : reasons.length > 0 || plugin.status === "disabled"
          ? "warn"
          : "ok";
      return {
        id: plugin.id,
        name: plugin.name || plugin.displayName || plugin.id,
        status: plugin.status || "unknown",
        health,
        reasons,
      };
    })
    .slice(0, 50);

  return { summary, items };
}

function summarizeTasks(taskRegistry) {
  const tasks = typeof taskRegistry?.listAll === "function" ? taskRegistry.listAll() : [];
  const schedules = typeof taskRegistry?.listSchedules === "function" ? taskRegistry.listSchedules() : [];
  const byType = {};

  for (const task of tasks) {
    const type = task?.type || "unknown";
    byType[type] = (byType[type] || 0) + 1;
  }

  return {
    total: tasks.length,
    aborted: tasks.filter((task) => task?.aborted === true).length,
    schedules: schedules.length,
    byType,
    attention: typeof taskRegistry?.listAttention === "function"
      ? taskRegistry.listAttention(10).map((task) => sanitizeTaskItem(task, taskRegistry))
      : tasks.filter((task) => task?.aborted === true).slice(0, 10).map((task) => sanitizeTaskItem(task, taskRegistry)),
  };
}

function summarizeRecovery(taskRegistry, deferredResults) {
  const activeTasks = typeof taskRegistry?.listAttention === "function" ? taskRegistry.listAttention(20) : [];
  const deferred = typeof deferredResults?.listAttention === "function" ? deferredResults.listAttention(20) : [];
  const items = [
    ...activeTasks.map((task) => ({ source: "task-registry", ...sanitizeTaskItem(task, taskRegistry) })),
    ...deferred.map((task) => ({ source: "deferred-result", ...sanitizeDeferredItem(task) })),
  ].sort((a, b) => (b.updatedAt || b.deferredAt || 0) - (a.updatedAt || a.deferredAt || 0)).slice(0, 30);
  const summary = { ...EMPTY_RECOVERY_SUMMARY };
  for (const item of items) {
    summary.attention += 1;
    if (item.status === "failed") summary.failed += 1;
    if (item.status === "aborted") summary.aborted += 1;
    if (item.delivered === false && item.status !== "pending") summary.undelivered += 1;
  }
  return { summary, items };
}

function summarizeModels(availableModels) {
  const models = Array.isArray(availableModels) ? availableModels : [];
  return {
    total: models.length,
    providers: new Set(models.map((model) => model?.provider).filter(Boolean)).size,
    vision: models.filter((model) => model?.vision === true || model?.input?.includes?.("image")).length,
    reasoning: models.filter((model) => model?.reasoning !== false).length,
  };
}

function summarizeMedia(providerRegistry) {
  const types = ["image", "audio", "music", "video"];
  const byType = {};
  for (const type of types) {
    const models = typeof providerRegistry?.getAllModelsByType === "function"
      ? providerRegistry.getAllModelsByType(type)
      : [];
    byType[type] = {
      models: models.length,
      providers: new Set(models.map((model) => model?.provider).filter(Boolean)).size,
    };
  }
  const providers = typeof providerRegistry?.getAll === "function"
    ? [...providerRegistry.getAll().values()].map((entry) => ({
        id: entry.id,
        name: entry.displayName || entry.display_name || entry.name || entry.id,
        api: entry.api || "",
        authType: entry.authType || entry.auth_type || "",
      })).slice(0, 80)
    : [];
  return { byType, providers };
}

function sanitizeTaskItem(task, taskRegistry) {
  return {
    taskId: task?.taskId || null,
    type: task?.type || "unknown",
    status: task?.status || (task?.aborted ? "aborted" : "running"),
    parentSessionPath: task?.parentSessionPath || null,
    failureReason: stringifyReason(task?.failureReason || task?.error || null),
    registeredAt: task?.registeredAt || null,
    updatedAt: task?.updatedAt || task?.registeredAt || null,
    meta: task?.meta || {},
    retrySupported: typeof taskRegistry?.canRetry === "function" ? taskRegistry.canRetry(task?.taskId) : false,
  };
}

function sanitizeDeferredItem(task) {
  return {
    taskId: task?.taskId || null,
    type: task?.meta?.type || task?.meta?.toolName || "deferred",
    status: task?.status || "unknown",
    sessionPath: task?.sessionPath || null,
    failureReason: stringifyReason(task?.reason || null),
    deferredAt: task?.deferredAt || null,
    delivered: task?.delivered === true,
    meta: task?.meta || {},
    retrySupported: false,
  };
}

function stringifyReason(reason) {
  if (!reason) return "";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  try { return JSON.stringify(reason); } catch { return String(reason); }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function summarizeArtifactSizes(projectRoot) {
  const targets = [
    ["renderer", "desktop/dist-renderer"],
    ["server", "dist-server"],
    ["ocr", "vendor/ocr-runtime"],
    ["wasm", "vendor"],
  ];
  return targets.map(([id, rel]) => {
    const abs = path.join(projectRoot, rel);
    return {
      id,
      path: rel,
      sizeBytes: directorySize(abs, id === "wasm" ? /\.(wasm)$/i : null),
      exists: fs.existsSync(abs),
    };
  });
}

function directorySize(rootDir, filePattern = null) {
  if (!fs.existsSync(rootDir)) return 0;
  let total = 0;
  let visited = 0;
  const walk = (dir) => {
    if (visited > 50000 || total > 5 * 1024 * 1024 * 1024) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      visited += 1;
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && (!filePattern || filePattern.test(entry.name))) total += fs.statSync(full).size;
      } catch {
        // Ignore files that disappear or cannot be read while packaging diagnostics.
      }
    }
  };
  walk(rootDir);
  return total;
}

function sanitizeKeyConfig(engine) {
  const config = engine?.config || {};
  return sanitizePackageValue({
    locale: config.locale || null,
    agent: config.agent ? {
      name: config.agent.name || null,
      yuan: config.agent.yuan || null,
    } : null,
    api: config.api || null,
    models: config.models || null,
    plugins: config.plugins ? {
      allowFullAccess: config.plugins.allow_full_access,
      devTools: config.plugins.plugin_dev_tools_enabled,
    } : null,
    bridge: config.bridge ? Object.keys(config.bridge) : [],
  });
}

function sanitizePackageValue(value, key = "") {
  if (/(api[_-]?key|authorization|bearer|token|password|secret|credential)/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9._-]+/g, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizePackageValue(item, key));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = sanitizePackageValue(entryValue, entryKey);
  }
  return output;
}
