// @ts-nocheck
/**
 * 数据迁移 runner。
 */
import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { atomicWriteSync, safeReadYAMLSync } from "../shared/safe-fs.ts";
import { ensureLocalIdentityRegistries } from "./server-identity.ts";
import { saveConfig } from "../lib/memory/config-loader.ts";
import {
  getSubagentSessionMetaPath,
  mergeExecutorMetadata,
  normalizeExecutorMetadata,
  readSubagentSessionMetaSync,
} from "../lib/subagent-executor-metadata.ts";
import { SubagentRunStore } from "../lib/subagent-run-store.ts";
import { SubagentThreadStore } from "../lib/subagent-thread-store.ts";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";
import { persistBrowserScreenshotFileSync } from "../lib/session-files/browser-screenshot-file.ts";
import { migrateLegacyApiKeyAuthToProviders } from "./provider-auth-migration.ts";
import { patchAutomationJobForMigration } from "../lib/desk/automation-normalizer.ts";
import { safeConversationStem } from "../lib/conversations/agent-phone-projection.ts";
import { DEFAULT_DISABLED_TOOL_NAMES } from "../shared/tool-categories.ts";
import {
  legacyAccessModeFromPermissionMode,
  normalizeSessionPermissionMode,
  SESSION_PERMISSION_MODES,
} from "./session-permission-mode.ts";
import {
  collectAgentSessionMetaPaths,
  collectLegacySessionJsonlPaths,
  legacyBrowserScreenshot,
  legacySessionFileRefs,
  migrateOneBridgeSessionIndex,
  normalizeLegacyMemoryMasterDefaults,
  promoteAgentVideoOverrides,
  registerLegacySessionFile,
  repairLegacyDeepSeekProviderModelIds,
  repairModelsJsonVideoInputs,
  repairSessionMetaThinkingLevels,
  writeYamlFile,
} from "./migration-compat-helpers.ts";

//

const migrations = {
  1: cleanDanglingProviderRefs,
 // #356: 清理悬空 provider 引用（agent config + preferences- 1: cleanDanglingProviderRefs,
  //
  2: migrateBridgeToPerAgent,
  // workspace (home_folder) 从全局 preferences 迁移到主 agent config.yaml
  3: migrateWorkspaceToPerAgent,
 // subagent executor metadata 显式化，避免历史回放依赖目录推断
  4: migrateSubagentExecutorMetadata,
  5: migrateModelRefsToCompositeKey,
  6: migrateChannelsToGlobalDefaultOff,
  7: migrateVisionToImage,
  8: repairPostMigrationModelRefs,
  9: migrateBridgeReadOnlyToGlobal,
  10: cleanupSummarizerCompilerRemnants,
  11: repairCronJobModelRefs,
  12: backfillLegacySessionFiles,
  13: normalizeRecentLegacyCompatibilityState,
  14: migrateGeminiOpenAICompatToNative,
  15: repairLegacySessionSidecarThinkingLevels,
  16: migrateVideoCapabilityProjection,
  17: migrateBridgeSessionKeysToAgentScoped,
  18: migrateLocalIdentityRegistries,
  19: migrateLegacyApiKeyAuthEntriesToProviders,
  20: migratePiInputSchemaVideoCompat,
  21: refreshVideoCapabilityProjection,
  22: migrateChannelPhoneSettingsDefaults,
  23: removeAgentPhoneReplyInstructions,
  24: migrateChannelPhoneGuardLimitDefaults,
  25: migrateChannelPhoneProactiveDefaults,
  28: migrateDurableSubagentRunRegistry,
  30: migrateCronJobsToAutomationReadModel,
  32: migrateAgentPhoneRuntimeOutOfProjection,
  33: migrateBeautifyDefaultExplicitOff,
  34: migrateWorkflowDefaultExplicitOff,
  36: migrateSubagentThreadRegistry,
  37: migrateSubagentDirectThreadSemantics,
  38: migrateDirectNotifyAutomationsToAgentRuns,
  39: repairAutomationOwnershipAfterAgentRunConsolidation,
  40: migrateSessionPermissionModeSidecars,
};

export const LATEST_DATA_VERSION = Math.max(...Object.keys(migrations).map(Number));

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {string}   ctx.codiaHome
 * @param {string}   ctx.agentsDir
 * @param {import('./preferences-manager.ts').PreferencesManager} ctx.prefs
 * @param {import('./provider-registry.ts').ProviderRegistry}     ctx.providerRegistry
 * @param {Function} ctx.log
 */
export function runMigrations(ctx) {
  const { prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const currentVersion = preferences._dataVersion || 0;

  const pending = Object.keys(migrations)
    .map(Number)
    .filter(v => v > currentVersion)
    .sort((a, b) => a - b);

  if (!pending.length) return;

  log(`[migrations] _dataVersion=${currentVersion}; pending ${pending.length} migrations`);

  for (const v of pending) {
    try {
      migrations[v](ctx);
      log(`[migrations] #${v} 完成`);
    } catch (err) {
      console.error(`[migrations] #${v} 失败: ${err.message}`);
      break;
 // 失败则停在当前版本，不继续后续迁- break;
    }
 // 每跑完一条就持久化版本号，防止中途崩溃导致重跑已成功的迁-
    const fresh = prefs.getPreferences();
    fresh._dataVersion = v;
    prefs.savePreferences(fresh);
  }
}

function backfillLegacySessionFiles(ctx) {
  const { codiaHome, agentsDir, log } = ctx;
  if (!codiaHome || !agentsDir) return;

  const registry = new SessionFileRegistry({
    managedCacheRoot: path.join(codiaHome, "session-files"),
  });
  const sessionPaths = collectLegacySessionJsonlPaths(agentsDir);
  let registered = 0;
  let materialized = 0;
  let skipped = 0;

  for (const sessionPath of sessionPaths) {
    let lines;
    try {
      lines = fs.readFileSync(sessionPath, "utf-8").split("\n").filter(Boolean);
    } catch (err) {
      skipped++;
      log?.(`[migrations] #12: skipped unreadable session ${sessionPath} (${err.message})`);
      continue;
    }

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      const msg = entry?.message;
      if (entry?.type !== "message" || msg?.role !== "toolResult") continue;

      for (const ref of legacySessionFileRefs(msg)) {
        const ok = registerLegacySessionFile({ registry, sessionPath, ref, codiaHome, log });
        if (ok) registered++;
        else skipped++;
      }

      const screenshot = legacyBrowserScreenshot(msg);
      if (screenshot?.base64) {
        try {
          persistBrowserScreenshotFileSync({
            codiaHome,
            sessionPath,
            base64: screenshot.base64,
            mimeType: screenshot.mimeType || "image/png",
            registerSessionFile: (record) => registry.registerFile(record),
          });
          materialized++;
        } catch (err) {
          skipped++;
          log?.(`[migrations] #12: skipped browser screenshot in ${sessionPath} (${err.message})`);
        }
      }
    }
  }

  log?.(`[migrations] #12: session file sidecars backfilled (files=${registered}, screenshots=${materialized}, skipped=${skipped})`);
}

function normalizeRecentLegacyCompatibilityState(ctx) {
  const deepseekPatched = repairLegacyDeepSeekProviderModelIds(ctx);
  const memoryPatched = normalizeLegacyMemoryMasterDefaults(ctx);
  ctx.log?.(`[migrations] #13: recent compatibility normalized (deepseek=${deepseekPatched}, memory=${memoryPatched})`);
}

const GEMINI_NATIVE_API = "google-generative-ai";
const GEMINI_OPENAI_COMPAT_API = "openai-completions";
const GEMINI_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function geminiBaseUrlMode(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return null;
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname === "/v1beta/openai") return "openai";
    if (pathname === "/v1beta") return "native";
  } catch {
    return null;
  }
  return null;
}

function migrateGeminiOpenAICompatToNative(ctx) {
  const { codiaHome, log } = ctx;
  const ymlPath = path.join(codiaHome, "added-models.yaml");
  const raw = safeReadYAMLSync(ymlPath, null, YAML);
  if (!raw?.providers || typeof raw.providers !== "object") {
    log?.("[migrations] #14: Gemini native API migration skipped (no providers)");
    return;
  }

  let patched = 0;
  for (const provider of Object.values(raw.providers)) {
    if (!provider || typeof provider !== "object") continue;
    const api = String(provider.api || "");
    const baseUrl = String(provider.base_url || "");
    const baseMode = geminiBaseUrlMode(baseUrl);
    const isGeminiOpenAICompat = api === GEMINI_OPENAI_COMPAT_API && baseMode === "openai";
    const isGeminiNativeButOldUrl = api === GEMINI_NATIVE_API && baseMode === "openai";
    if (!isGeminiOpenAICompat && !isGeminiNativeButOldUrl) continue;

    provider.api = GEMINI_NATIVE_API;
    provider.base_url = GEMINI_NATIVE_BASE_URL;
    patched++;
  }

  if (patched > 0) {
    writeYamlFile(ymlPath, raw);
    if (ctx.providerRegistry) {
      ctx.providerRegistry._addedModelsCache = null;
      ctx.providerRegistry._addedModelsMtime = 0;
    }
  }

  log?.(`[migrations] #14: Gemini OpenAI compatibility configs migrated to native API (${patched})`);
}

function repairLegacySessionSidecarThinkingLevels(ctx) {
  const metaPaths = collectAgentSessionMetaPaths(ctx.agentsDir);
  let filesPatched = 0;
  let entriesPatched = 0;

  for (const metaPath of metaPaths) {
    const patched = repairSessionMetaThinkingLevels(metaPath, ctx.log);
    if (patched > 0) {
      filesPatched++;
      entriesPatched += patched;
    }
  }

  ctx.log?.(`[migrations] #15: legacy session sidecars repaired (files=${filesPatched}, entries=${entriesPatched})`);
}

function migrateVideoCapabilityProjection(ctx) {
  const modelsPatched = repairModelsJsonVideoInputs(ctx);
  const overridesPatched = promoteAgentVideoOverrides(ctx);
  ctx.log?.(`[migrations] #16: video capability projected (models=${modelsPatched}, overrides=${overridesPatched})`);
}

function migrateBridgeSessionKeysToAgentScoped(ctx) {
  const { agentsDir, log } = ctx;
  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    return;
  }

  let migrated = 0;
  let merged = 0;
  let collisions = 0;

  for (const dir of agentDirs) {
    const agentId = dir.name;
    const cfgPath = path.join(agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(cfgPath)) continue;

    const indexPath = path.join(agentsDir, agentId, "sessions", "bridge", "bridge-sessions.json");
    const result = migrateOneBridgeSessionIndex(indexPath, agentId, log);
    migrated += result.migrated;
    merged += result.merged;
    collisions += result.collisions;
  }

  log?.(`[migrations] #17: bridge session keys scoped (migrated=${migrated}, merged=${merged}, collisions=${collisions})`);
}

function migrateLocalIdentityRegistries(ctx) {
  const { codiaHome, log } = ctx;
  const { created } = ensureLocalIdentityRegistries(codiaHome);
  log?.(`[migrations] #18: local identity registries ready${created.length ? ` (created=${created.join(",")})` : ""}`);
}

function collectAgentParentSessionJsonlPaths(agentsDir) {
  let agents = [];
  try {
    agents = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    collectJsonlRecursive(path.join(agentsDir, agent.name, "sessions"), out);
  }
  return out;
}

function collectJsonlRecursive(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsonlRecursive(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

function mapSubagentRunStatus(streamStatus) {
  if (streamStatus === "done") return "resolved";
  if (streamStatus === "failed") return "failed";
  if (streamStatus === "aborted") return "aborted";
  return "pending";
}

function mapDeferredSubagentRunStatus(status) {
  if (status === "resolved") return "resolved";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "pending";
}

function summarizeDeferredSubagentTask(task) {
  if (typeof task?.result === "string" && task.result) return task.result;
  if (typeof task?.reason === "string" && task.reason) return task.reason;
  if (typeof task?.meta?.summary === "string" && task.meta.summary) return task.meta.summary;
  return null;
}

function migrateDurableSubagentRunRegistry(ctx) {
  const { codiaHome, agentsDir, log } = ctx;
  const store = new SubagentRunStore(path.join(codiaHome, "subagent-runs.json"));
  let imported = 0;

  for (const sessionPath of collectAgentParentSessionJsonlPaths(agentsDir)) {
    let raw = "";
    try {
      raw = fs.readFileSync(sessionPath, "utf-8");
    } catch {
      continue;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = entry?.message;
      if (entry?.type !== "message" || msg?.role !== "toolResult" || msg?.toolName !== "subagent") continue;
      const details = msg.details || {};
      const taskId = typeof details.taskId === "string" ? details.taskId : null;
      const childSessionPath = typeof details.sessionPath === "string" && details.sessionPath
        ? details.sessionPath
        : (typeof details.streamKey === "string" && details.streamKey ? details.streamKey : null);
      if (!taskId || !childSessionPath) continue;

      store.upsert(taskId, {
        parentSessionPath: sessionPath,
        childSessionPath,
        status: mapSubagentRunStatus(details.streamStatus),
        summary: typeof details.summary === "string" && details.summary
          ? details.summary
          : (typeof details.taskTitle === "string" && details.taskTitle ? details.taskTitle : null),
        requestedAgentId: details.requestedAgentId || null,
        requestedAgentNameSnapshot: details.requestedAgentNameSnapshot || details.requestedAgentName || null,
        executorAgentId: details.executorAgentId || details.agentId || null,
        executorAgentNameSnapshot: details.executorAgentNameSnapshot || details.agentName || null,
        executorMetaVersion: details.executorMetaVersion || null,
      });
      imported++;
    }
  }

  const deferredTasksPath = path.join(codiaHome, ".ephemeral", "deferred-tasks.json");
  try {
    if (fs.existsSync(deferredTasksPath)) {
      const deferredTasks = JSON.parse(fs.readFileSync(deferredTasksPath, "utf-8"));
      for (const [taskId, task] of Object.entries(deferredTasks || {})) {
        if (task?.meta?.type !== "subagent") continue;
        const childSessionPath = typeof task.meta.sessionPath === "string" && task.meta.sessionPath
          ? task.meta.sessionPath
          : null;
        if (!childSessionPath) continue;

        store.upsert(taskId, {
          parentSessionPath: typeof task.sessionPath === "string" ? task.sessionPath : null,
          childSessionPath,
          status: mapDeferredSubagentRunStatus(task.status),
          summary: summarizeDeferredSubagentTask(task),
          reason: typeof task.reason === "string" ? task.reason : null,
          requestedAgentId: task.meta.requestedAgentId || null,
          requestedAgentNameSnapshot: task.meta.requestedAgentNameSnapshot || null,
          executorAgentId: task.meta.executorAgentId || null,
          executorAgentNameSnapshot: task.meta.executorAgentNameSnapshot || null,
          executorMetaVersion: task.meta.executorMetaVersion || null,
          createdAt: task.deferredAt ? new Date(task.deferredAt).toISOString() : null,
        });
        imported++;
      }
    }
  } catch (err) {
    log?.(`[migrations] #28: deferred subagent run import skipped (${err.message})`);
  }

  log?.(`[migrations] #28: durable subagent run registry backfilled (${imported})`);
}

function readJsonForMigration(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeMigratedRunStatus(status) {
  if (status === "resolved" || status === "failed" || status === "aborted") return status;
  return "failed";
}

function migrateSubagentThreadRegistry(ctx) {
  const { codiaHome, log } = ctx;
  const threadStore = new SubagentThreadStore(path.join(codiaHome, "subagent-threads.json"));
  const runStore = new SubagentRunStore(path.join(codiaHome, "subagent-runs.json"));
  let importedRuns = 0;
  let importedReusable = 0;

  for (const run of runStore.list()) {
    if (!run?.taskId || !String(run.taskId).startsWith("subagent-")) continue;
    if (!run.childSessionPath) continue;
    const threadId = run.threadId || run.taskId;
    const status = normalizeMigratedRunStatus(run.status);
    threadStore.beginRun(threadId, {
      kind: "direct",
      parentSessionPath: run.parentSessionPath || null,
      agentId: run.executorAgentId || run.requestedAgentId || null,
      agentName: run.executorAgentNameSnapshot || run.requestedAgentNameSnapshot || null,
      summary: run.summary || null,
    });
    threadStore.attachSession(threadId, run.childSessionPath, {
      parentSessionPath: run.parentSessionPath || null,
      agentId: run.executorAgentId || run.requestedAgentId || null,
      agentName: run.executorAgentNameSnapshot || run.requestedAgentNameSnapshot || null,
    });
    threadStore.finishRun(threadId, {
      status,
      summary: run.summary || run.reason || null,
      close: true,
    });
    runStore.upsert(run.taskId, { threadId, threadKind: "direct" });
    importedRuns += 1;
  }

  const reusableRaw = readJsonForMigration(path.join(codiaHome, "reusable-subagents.json"));
  const instances = reusableRaw?.instances && typeof reusableRaw.instances === "object"
    ? reusableRaw.instances
    : {};
  for (const [reuseKey, rec] of Object.entries(instances)) {
    if (!reuseKey || !rec || typeof rec !== "object") continue;
    const threadId = `reusable::${reuseKey}`;
    threadStore.upsert(threadId, {
      kind: "direct",
      status: "open",
      lastRunStatus: normalizeMigratedRunStatus(rec.lastStatus),
      parentSessionPath: rec.parentSessionPath || null,
      agentId: rec.agentId || null,
      childSessionPath: rec.childSessionPath || null,
      label: rec.taskSuffix || null,
      summary: rec.summary || null,
      runCount: rec.runCount || 0,
      createdAt: rec.createdAt || null,
      lastRunAt: rec.lastRunAt || null,
    });
    importedReusable += 1;
  }

  log?.(`[migrations] #36: subagent thread registry backfilled (runs=${importedRuns}, reusable=${importedReusable})`);
}

function pickLegacySubagentLabel(rec) {
  if (typeof rec?.label === "string" && rec.label.trim()) return rec.label.trim();
  if (typeof rec?.instance === "string" && rec.instance.trim()) return rec.instance.trim();
  if (typeof rec?.taskSuffix === "string" && rec.taskSuffix.trim()) return rec.taskSuffix.trim();
  if (typeof rec?.reuseKey === "string" && rec.reuseKey.trim()) {
    const parts = rec.reuseKey.split("::").map((part) => part.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }
  return null;
}

function migrateSubagentDirectThreadSemantics(ctx) {
  const { codiaHome, log } = ctx;
  const threadsPath = path.join(codiaHome, "subagent-threads.json");
  const runsPath = path.join(codiaHome, "subagent-runs.json");
  let threadCount = 0;
  let runCount = 0;

  const rawThreads = readJsonForMigration(threadsPath);
  const threads = rawThreads?.threads && typeof rawThreads.threads === "object" ? rawThreads.threads : null;
  if (threads) {
    for (const rec of Object.values(threads)) {
      if (!rec || typeof rec !== "object") continue;
      if (rec.kind === "ephemeral" || rec.kind === "reusable") {
        rec.kind = "direct";
        threadCount += 1;
      }
      const label = pickLegacySubagentLabel(rec);
      if (label && !(typeof rec.label === "string" && rec.label.trim())) {
        rec.label = label;
        threadCount += 1;
      }
      for (const key of ["instance", "reuseKey", "taskSuffix"]) {
        if (Object.prototype.hasOwnProperty.call(rec, key)) {
          delete rec[key];
          threadCount += 1;
        }
      }
    }
    if (threadCount > 0) {
      atomicWriteSync(threadsPath, JSON.stringify(rawThreads, null, 2) + "\n");
    }
  }

  const rawRuns = readJsonForMigration(runsPath);
  const runs = rawRuns?.runs && typeof rawRuns.runs === "object" ? rawRuns.runs : null;
  if (runs) {
    for (const rec of Object.values(runs)) {
      if (!rec || typeof rec !== "object") continue;
      if (rec.threadKind === "ephemeral" || rec.threadKind === "reusable") {
        rec.threadKind = "direct";
        runCount += 1;
      }
    }
    if (runCount > 0) {
      atomicWriteSync(runsPath, JSON.stringify(rawRuns, null, 2) + "\n");
    }
  }

  log?.(`[migrations] #37: subagent direct semantics normalized (threads=${threadCount}, runs=${runCount})`);
}

function migrateLegacyApiKeyAuthEntriesToProviders(ctx) {
  const result = migrateLegacyApiKeyAuthToProviders(ctx);
  ctx.log?.(`[migrations] #19: legacy API-key auth migrated (${result.providers.join(", ") || "none"})`);
}

function migratePiInputSchemaVideoCompat(ctx) {
  const modelsPatched = repairModelsJsonVideoInputs(ctx);
  ctx.log?.(`[migrations] #20: Pi input schema video compatibility repaired (models=${modelsPatched})`);
}

function refreshVideoCapabilityProjection(ctx) {
  const modelsPatched = repairModelsJsonVideoInputs(ctx);
  ctx.log?.(`[migrations] #21: video capability projection refreshed (models=${modelsPatched})`);
}

function migrateChannelPhoneSettingsDefaults(ctx) {
  const { codiaHome, log } = ctx;
  const channelsDir = path.join(codiaHome, "channels");
  if (!fs.existsSync(channelsDir)) {
    log?.("[migrations] #22: no channels dir");
    return;
  }

  let patched = 0;
  for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(channelsDir, entry.name);
    const raw = fs.readFileSync(filePath, "utf-8");
    const next = patchChannelPhoneSettingsFrontmatter(raw);
    if (next === raw) continue;
    writeTextFileAtomic(filePath, next);
    patched++;
  }

  log?.(`[migrations] #22: channel phone settings defaults patched (${patched})`);
}

function removeAgentPhoneReplyInstructions(ctx) {
  const { codiaHome, agentsDir, log } = ctx;
  let channelPatched = 0;
  let projectionPatched = 0;

  const patchFile = (filePath, keys) => {
    const raw = fs.readFileSync(filePath, "utf-8");
    const next = removeFrontmatterKeys(raw, keys);
    if (next === raw) return false;
    writeTextFileAtomic(filePath, next);
    return true;
  };

  const channelsDir = path.join(codiaHome, "channels");
  if (fs.existsSync(channelsDir)) {
    for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (patchFile(path.join(channelsDir, entry.name), new Set(["agentPhoneReplyInstructions"]))) {
        channelPatched++;
      }
    }
  }

  if (fs.existsSync(agentsDir)) {
    for (const agentEntry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const conversationsDir = path.join(agentsDir, agentEntry.name, "phone", "conversations");
      if (!fs.existsSync(conversationsDir)) continue;
      for (const entry of fs.readdirSync(conversationsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        if (patchFile(path.join(conversationsDir, entry.name), new Set(["replyInstructions"]))) {
          projectionPatched++;
        }
      }
    }
  }

  log?.(`[migrations] #23: deprecated reply-scope settings removed (channels=${channelPatched}, projections=${projectionPatched})`);
}

function migrateChannelPhoneGuardLimitDefaults(ctx) {
  const { codiaHome, log } = ctx;
  const channelsDir = path.join(codiaHome, "channels");
  if (!fs.existsSync(channelsDir)) {
    log?.("[migrations] #24: no channels dir");
    return;
  }

  let patched = 0;
  for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(channelsDir, entry.name);
    const raw = fs.readFileSync(filePath, "utf-8");
    const next = patchChannelGuardLimitFrontmatter(raw);
    if (next === raw) continue;
    writeTextFileAtomic(filePath, next);
    patched++;
  }

  log?.(`[migrations] #24: channel phone guard limits patched (${patched})`);
}

function migrateChannelPhoneProactiveDefaults(ctx) {
  const { codiaHome, log } = ctx;
  const channelsDir = path.join(codiaHome, "channels");
  if (!fs.existsSync(channelsDir)) {
    log?.("[migrations] #25: no channels dir");
    return;
  }

  let patched = 0;
  for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(channelsDir, entry.name);
    const raw = fs.readFileSync(filePath, "utf-8");
    const next = patchChannelProactiveFrontmatter(raw);
    if (next === raw) continue;
    writeTextFileAtomic(filePath, next);
    patched++;
  }

  log?.(`[migrations] #25: channel phone proactive defaults patched (${patched})`);
}

function writeTextFileAtomic(filePath, text) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, filePath);
}

function removeFrontmatterKeys(raw, keys) {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return raw;

  let changed = false;
  for (const key of keys) {
    if (parsed.meta.delete(key)) changed = true;
  }
  return changed ? serializeFrontmatter(parsed) : raw;
}

function parseFrontmatter(raw) {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  const fmLines = lines.slice(1, end);
  const meta = new Map();
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    meta.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return { lines, end, fmLines, meta };
}

function serializeFrontmatter(parsed) {
  const originalKeys = [];
  for (const line of parsed.fmLines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    originalKeys.push(line.slice(0, idx).trim());
  }
  const orderedKeys = [
    ...originalKeys.filter((key) => parsed.meta.has(key)),
    ...[...parsed.meta.keys()].filter((key) => !originalKeys.includes(key)),
  ];
  const nextFm = orderedKeys.map((key) => `${key}: ${parsed.meta.get(key)}`);
  return ["---", ...nextFm, "---", ...parsed.lines.slice(parsed.end + 1)].join("\n");
}

const AGENT_PHONE_RUNTIME_KEYS = new Set([
  "phoneSessionFile",
  "lastPhoneSessionUsedAt",
  "phoneSessionStartedAt",
  "promptSnapshot",
]);

const AGENT_PHONE_PROJECTION_RUNTIME_KEYS = new Set([
  ...AGENT_PHONE_RUNTIME_KEYS,
  "toolNames",
  "lastRefreshedDate",
]);

function parseEncodedFrontmatterJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidates = [value.trim()];
  try {
    const decoded = decodeURIComponent(value.trim());
    if (decoded !== value.trim()) candidates.unshift(decoded);
  } catch {
    // Raw JSON remains a valid candidate.
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

function agentPhoneRuntimePatchFromMeta(meta) {
  const patch = {};
  for (const key of AGENT_PHONE_RUNTIME_KEYS) {
    if (!meta.has(key)) continue;
    const value = meta.get(key);
    if (key === "promptSnapshot") {
      const parsed = parseEncodedFrontmatterJson(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        patch.promptSnapshot = parsed;
      }
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      patch[key] = value.trim();
    }
  }
  return patch;
}

function migrateAgentPhoneRuntimeOutOfProjection(ctx) {
  const { agentsDir, log } = ctx;
  let moved = 0;
  let cleaned = 0;

  let agentEntries;
  try {
    agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    log?.("[migrations] #32: no agents dir");
    return;
  }

  for (const agentEntry of agentEntries) {
    const agentDir = path.join(agentsDir, agentEntry.name);
    const conversationsDir = path.join(agentDir, "phone", "conversations");
    let projectionEntries;
    try {
      projectionEntries = fs.readdirSync(conversationsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
    } catch {
      continue;
    }

    for (const projectionEntry of projectionEntries) {
      const projectionPath = path.join(conversationsDir, projectionEntry.name);
      let raw;
      try {
        raw = fs.readFileSync(projectionPath, "utf-8");
      } catch {
        continue;
      }
      const frontmatter = parseFrontmatter(raw);
      if (!frontmatter) continue;

      const runtimePatch = agentPhoneRuntimePatchFromMeta(frontmatter.meta);
      const nextProjection = removeFrontmatterKeys(raw, AGENT_PHONE_PROJECTION_RUNTIME_KEYS);
      if (nextProjection !== raw) {
        atomicWriteSync(projectionPath, nextProjection);
        cleaned += 1;
      }

      if (!Object.keys(runtimePatch).length) continue;
      const conversationId = frontmatter.meta.get("conversationId");
      if (!conversationId || typeof conversationId !== "string") continue;

      const runtimeDir = path.join(agentDir, "phone", "session-runtime");
      const runtimePath = path.join(runtimeDir, `${safeConversationStem(conversationId)}.json`);
      fs.mkdirSync(runtimeDir, { recursive: true });

      let existing = {};
      try {
        const parsed = fs.existsSync(runtimePath)
          ? JSON.parse(fs.readFileSync(runtimePath, "utf-8"))
          : {};
        existing = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        existing = {};
      }

      const nextRuntime = {
        ...existing,
        agentId: frontmatter.meta.get("agentId") || existing.agentId || agentEntry.name,
        conversationId,
        conversationType: frontmatter.meta.get("conversationType")
          || existing.conversationType
          || (conversationId.startsWith("dm:") ? "dm" : "channel"),
        ...runtimePatch,
        updatedAt: existing.updatedAt || new Date().toISOString(),
      };
      delete nextRuntime.toolNames;
      atomicWriteSync(runtimePath, JSON.stringify(nextRuntime, null, 2) + "\n");
      moved += 1;
    }
  }

  log?.(`[migrations] #32: agent phone runtime moved (runtime=${moved}, projections=${cleaned})`);
}

function migrateBeautifyDefaultExplicitOff(ctx) {
  const { agentsDir, log } = ctx;
  let dirs;
  try {
    dirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
  } catch {
    return;
  }

  for (const dir of dirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    if (!fs.existsSync(cfgPath)) continue;
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config) continue;
    const existing = Array.isArray(config.tools?.disabled)
      ? config.tools.disabled
      : DEFAULT_DISABLED_TOOL_NAMES.filter(name => name !== "beautify");
    if (existing.includes("beautify")) continue;
    saveConfig(cfgPath, { tools: { disabled: [...existing, "beautify"] } });
    log?.(`[migrations] #33: beautify defaulted to disabled for "${dir.name}"`);
  }
}

function migrateWorkflowDefaultExplicitOff(ctx) {
  const { agentsDir, log } = ctx;
  let dirs;
  try {
    dirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
  } catch {
    return;
  }

  for (const dir of dirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    if (!fs.existsSync(cfgPath)) continue;
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config) continue;
    const existing = Array.isArray(config.tools?.disabled)
      ? config.tools.disabled
      : DEFAULT_DISABLED_TOOL_NAMES.filter(name => name !== "workflow");
    if (existing.includes("workflow")) continue;
    saveConfig(cfgPath, { tools: { disabled: [...existing, "workflow"] } });
    log?.(`[migrations] #34: workflow defaulted to disabled for "${dir.name}"`);
  }
}

function patchChannelPhoneSettingsFrontmatter(raw) {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return raw;
  const { meta } = parsed;

  let changed = false;
  const setKey = (key, value) => {
    const str = String(value);
    if (meta.get(key) === str) return;
    meta.set(key, str);
    changed = true;
  };

  const interval = Number(meta.get("agentPhoneReminderIntervalMinutes"));
  if (!Number.isFinite(interval) || interval <= 0) {
    setKey("agentPhoneReminderIntervalMinutes", "31");
  }
  if (!["true", "false"].includes(meta.get("agentPhoneProactiveEnabled"))) {
    setKey("agentPhoneProactiveEnabled", "true");
  }

  const overrideEnabled = meta.get("agentPhoneModelOverrideEnabled") === "true";
  const overrideId = meta.get("agentPhoneModelOverrideId") || "";
  const overrideProvider = meta.get("agentPhoneModelOverrideProvider") || "";
  if (!meta.has("agentPhoneModelOverrideEnabled")) {
    setKey("agentPhoneModelOverrideEnabled", "false");
  }
  if (overrideEnabled && (!overrideId || !overrideProvider)) {
    setKey("agentPhoneModelOverrideEnabled", "false");
    setKey("agentPhoneModelOverrideId", "");
    setKey("agentPhoneModelOverrideProvider", "");
  }

  return changed ? serializeFrontmatter(parsed) : raw;
}

function patchChannelGuardLimitFrontmatter(raw) {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return raw;

  const current = Number(parsed.meta.get("agentPhoneGuardLimit"));
  if (Number.isFinite(current) && current > 0) return raw;

  const memberCount = parseFrontmatterMemberCount(parsed.meta.get("members"));
  parsed.meta.set("agentPhoneGuardLimit", String(memberCount * 12));
  return serializeFrontmatter(parsed);
}

function patchChannelProactiveFrontmatter(raw) {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return raw;

  const current = parsed.meta.get("agentPhoneProactiveEnabled");
  if (current === "true" || current === "false") return raw;
  parsed.meta.set("agentPhoneProactiveEnabled", "true");
  return serializeFrontmatter(parsed);
}

function parseFrontmatterMemberCount(value) {
  if (typeof value !== "string") return 3;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return 3;
  const count = trimmed
    .slice(1, -1)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .length;
  return count > 0 ? count : 3;
}

//

/**
 * #1 -清理悬空 provider 引用
 *
  * */
function cleanDanglingProviderRefs(ctx) {
  const { agentsDir, prefs, providerRegistry, log } = ctx;

  const providerExists = (id) => !!providerRegistry.get(id);

  // ── 1. Agent config.yaml ──

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch { return; }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config) continue;

    let changed = false;

    // api.provider / embedding_api.provider / utility_api.provider
    for (const block of ["api", "embedding_api", "utility_api"]) {
      const provider = config[block]?.provider;
      if (provider && !providerExists(provider)) {
        config[block].provider = "";
        changed = true;
        log(`[migrations] ${dir.name}: ${block}.provider "${provider}" does not exist; cleared`);
      }
    }

 //
    if (config.models) {
      for (const role of ["chat", "utility", "utility_large", "summarizer", "compiler", "embedding"]) {
        const ref = config.models[role];
        if (!ref) continue;

        if (typeof ref === "object" && ref.provider && !providerExists(ref.provider)) {
          config.models[role] = "";
          changed = true;
          log(`[migrations] ${dir.name}: models.${role}.provider "${ref.provider}" does not exist; cleared`);
        } else if (typeof ref === "string" && ref.includes("/")) {
          const provider = ref.slice(0, ref.indexOf("/"));
          if (!providerExists(provider)) {
            config.models[role] = "";
            changed = true;
            log(`[migrations] ${dir.name}: models.${role} "${ref}" provider does not exist; cleared`);
          }
        }
      }
    }

    if (changed) {
      const tmp = cfgPath + ".tmp";
      fs.writeFileSync(tmp, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");
      fs.renameSync(tmp, cfgPath);
    }
  }

  // ── 2. Preferences ──

  const preferences = prefs.getPreferences();
  let prefsChanged = false;

 // 共享模型字段：utility_model, utility_large_model, summarizer_model, compiler_model
  for (const key of ["utility_model", "utility_large_model", "summarizer_model", "compiler_model"]) {
    const val = preferences[key];
    if (!val) continue;

    if (typeof val === "object" && val.provider && !providerExists(val.provider)) {
      preferences[key] = null;
      prefsChanged = true;
      log(`[migrations] preferences.${key}.provider "${val.provider}" does not exist; cleared`);
    } else if (typeof val === "string" && val.includes("/")) {
      const provider = val.slice(0, val.indexOf("/"));
      if (!providerExists(provider)) {
        preferences[key] = null;
        prefsChanged = true;
        log(`[migrations] preferences.${key} "${val}" provider does not exist; cleared`);
      }
    }
  }

  // utility_api_provider
  if (preferences.utility_api_provider && !providerExists(preferences.utility_api_provider)) {
    log(`[migrations] preferences.utility_api_provider "${preferences.utility_api_provider}" does not exist; cleared`);
    preferences.utility_api_provider = null;
    prefsChanged = true;
  }

  if (prefsChanged) {
    prefs.savePreferences(preferences);
  }
}

/**
  *
 *
 * preferences.json 中的 bridge.telegram / feishu / qq / wechat / whatsapp
 * 各自可能-agentId 字段指定归属 agent。迁移后每个 platform config
  *
  * */
function migrateBridgeToPerAgent(ctx) {
  const { agentsDir, prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const bridge = preferences.bridge;
  if (!bridge) return; // nothing to migrate

  const primaryAgentId = preferences.primaryAgent || null;
  const ownerDict = bridge.owner || {};
  const readOnly = bridge.readOnly === true;
  const receiptEnabled = bridge.receiptEnabled === false ? false : undefined;

  const PLATFORMS = ["telegram", "feishu", "qq", "wechat", "whatsapp"];
  const agentConfigs = new Map(); // agentId -> { platform: config }

  // Find fallback agent: primary if it exists, otherwise first available
  let fallbackAgentId = null;
  if (primaryAgentId) {
    const primaryDir = path.join(agentsDir, primaryAgentId);
    if (fs.existsSync(path.join(primaryDir, "config.yaml"))) {
      fallbackAgentId = primaryAgentId;
    } else {
      log(`[migrations] primaryAgent "${primaryAgentId}" dir/config.yaml not found, scanning for fallback`);
    }
  }
  if (!fallbackAgentId) {
    try {
      const dirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const d of dirs) {
        if (fs.existsSync(path.join(agentsDir, d.name, "config.yaml"))) {
          fallbackAgentId = d.name;
          break;
        }
      }
    } catch {}
  }

  for (const platform of PLATFORMS) {
    const cfg = bridge[platform];
    if (!cfg) continue;

    // Determine target agent
    let targetAgentId = cfg.agentId || null;
    if (targetAgentId) {
      const agentCfg = path.join(agentsDir, targetAgentId, "config.yaml");
      if (!fs.existsSync(agentCfg)) {
        log(`[migrations] bridge.${platform}.agentId "${targetAgentId}" not found, using fallback`);
        targetAgentId = null;
      }
    }
    if (!targetAgentId) targetAgentId = fallbackAgentId;
    if (!targetAgentId) {
      log(`[migrations] no agent available for bridge.${platform}, skipping`);
      continue;
    }

    if (!agentConfigs.has(targetAgentId)) agentConfigs.set(targetAgentId, {});
    const ac = agentConfigs.get(targetAgentId);

    // Clean config: strip agentId field (now implicit by location)
    const cleanCfg = { ...cfg };
    delete cleanCfg.agentId;

    // Resolve owner: composite key "platform:agentId" > legacy "platform"
    const compositeKey = `${platform}:${targetAgentId}`;
    const owner = ownerDict[compositeKey] || ownerDict[platform] || null;
    if (owner) cleanCfg.owner = owner;

    ac[platform] = cleanCfg;
  }

  // Write to each agent's config.yaml
  for (const [agentId, bridgeConfig] of agentConfigs) {
    const cfgPath = path.join(agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(cfgPath)) {
      log(`[migrations] agent ${agentId} config.yaml not found, skipping`);
      continue;
    }
    saveConfig(cfgPath, { bridge: { ...bridgeConfig } });
    log(`[migrations] migrated bridge config -> agent ${agentId} (${Object.keys(bridgeConfig).join(", ")})`);
  }

  const nextBridgePrefs = {};
  if (readOnly) nextBridgePrefs.readOnly = true;
  if (receiptEnabled === false) nextBridgePrefs.receiptEnabled = false;
  if (Object.keys(nextBridgePrefs).length > 0) preferences.bridge = nextBridgePrefs;
  else delete preferences.bridge;
  prefs.savePreferences(preferences);
  log(`[migrations] migrated prefs.bridge platform config to agents`);
}

function migrateSubagentExecutorMetadata(ctx) {
  const { agentsDir, codiaHome, log } = ctx;
  const agentSnapshots = new Map();
  const childSessionCandidates = new Map();

  const agentDirs = (() => {
    try {
      return fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(agentsDir, d.name, "config.yaml")));
    } catch {
      return [];
    }
  })();

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const cfg = safeReadYAMLSync(cfgPath, {}, YAML);
    agentSnapshots.set(dir.name, cfg?.agent?.name || dir.name);
  }

  function ownerIdentityFor(agentId) {
    if (!agentId) return null;
    return normalizeExecutorMetadata({
      agentId,
      agentName: agentSnapshots.get(agentId) || agentId,
    });
  }

  function rememberChildSessionIdentity(sessionPath, identity, priority) {
    if (!sessionPath || !identity) return;
    const current = childSessionCandidates.get(sessionPath);
    if (!current || priority > current.priority) {
      childSessionCandidates.set(sessionPath, { identity, priority });
    }
  }

  function inferOwnerAgentId(sessionPath) {
    const rel = path.relative(agentsDir, sessionPath);
    if (rel.startsWith("..")) return null;
    return rel.split(path.sep)[0] || null;
  }

  for (const dir of agentDirs) {
    const agentId = dir.name;
    const sessionDir = path.join(agentsDir, agentId, "sessions");
    let sessionFiles = [];
    try {
      sessionFiles = fs.readdirSync(sessionDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(sessionDir, name));
    } catch {
      sessionFiles = [];
    }

    for (const sessionFile of sessionFiles) {
      let changed = false;
      const outputLines = [];
      let raw = "";
      try {
        raw = fs.readFileSync(sessionFile, "utf-8");
      } catch {
        continue;
      }

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;

        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          outputLines.push(line);
          continue;
        }

        const msg = entry?.message;
        if (entry?.type !== "message" || msg?.role !== "toolResult" || msg?.toolName !== "subagent" || !msg?.details) {
          outputLines.push(JSON.stringify(entry));
          continue;
        }

        const details = msg.details;
        const explicitIdentity = normalizeExecutorMetadata(details);
        const childSessionPath = details.sessionPath || null;
        const ownerIdentity = ownerIdentityFor(agentId);
        const inferredOwnerIdentity = childSessionPath
          ? ownerIdentityFor(inferOwnerAgentId(childSessionPath))
          : null;
        const identity = explicitIdentity || ownerIdentity || inferredOwnerIdentity;

        if (identity) {
          const before = JSON.stringify(details);
          mergeExecutorMetadata(details, identity);
          if (JSON.stringify(details) !== before) changed = true;
          if (childSessionPath) {
            rememberChildSessionIdentity(childSessionPath, identity, explicitIdentity ? 2 : 1);
          }
        }

        outputLines.push(JSON.stringify(entry));
      }

      if (changed) {
        fs.writeFileSync(sessionFile, outputLines.join("\n") + "\n", "utf-8");
        log(`[migrations] subagent executor metadata patched: ${sessionFile}`);
      }
    }
  }

  for (const dir of agentDirs) {
    const agentId = dir.name;
    const subagentDir = path.join(agentsDir, agentId, "subagent-sessions");
    let childFiles = [];
    try {
      childFiles = fs.readdirSync(subagentDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(subagentDir, name));
    } catch {
      childFiles = [];
    }

    for (const childFile of childFiles) {
      if (!childSessionCandidates.has(childFile)) {
        const sessionMeta = readSubagentSessionMetaSync(childFile);
        const identity = sessionMeta || ownerIdentityFor(agentId);
        rememberChildSessionIdentity(childFile, identity, sessionMeta ? 3 : 0);
      }
    }
  }

  const sidecarWrites = new Map();
  for (const [childSessionPath, { identity }] of childSessionCandidates) {
    if (!identity) continue;
    const metaPath = getSubagentSessionMetaPath(childSessionPath);
    if (!metaPath) continue;
    let meta = sidecarWrites.get(metaPath);
    if (!meta) {
      try {
        meta = fs.existsSync(metaPath)
          ? JSON.parse(fs.readFileSync(metaPath, "utf-8"))
          : {};
      } catch {
        meta = {};
      }
      sidecarWrites.set(metaPath, meta);
    }

    const sessKey = path.basename(childSessionPath);
    meta[sessKey] = {
      ...meta[sessKey],
      ...identity,
    };
  }

  for (const [metaPath, meta] of sidecarWrites) {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
    log(`[migrations] subagent session sidecar patched: ${metaPath}`);
  }

  const deferredTasksPath = path.join(codiaHome, ".ephemeral", "deferred-tasks.json");
  try {
    if (!fs.existsSync(deferredTasksPath)) return;
    const deferredTasks = JSON.parse(fs.readFileSync(deferredTasksPath, "utf-8"));
    let changed = false;
    for (const task of Object.values(deferredTasks)) {
      if (task?.meta?.type !== "subagent") continue;
      const sessionPath = task.meta.sessionPath || null;
      const candidate =
        normalizeExecutorMetadata(task.meta)
        || (sessionPath ? childSessionCandidates.get(sessionPath)?.identity || readSubagentSessionMetaSync(sessionPath) : null)
        || (sessionPath ? ownerIdentityFor(inferOwnerAgentId(sessionPath)) : null);
      if (!candidate) continue;
      const before = JSON.stringify(task.meta);
      mergeExecutorMetadata(task.meta, candidate);
      if (JSON.stringify(task.meta) !== before) changed = true;
    }
    if (changed) {
      fs.mkdirSync(path.dirname(deferredTasksPath), { recursive: true });
      fs.writeFileSync(deferredTasksPath, JSON.stringify(deferredTasks, null, 2) + "\n", "utf-8");
      log(`[migrations] subagent deferred metadata patched: ${deferredTasksPath}`);
    }
  } catch (err) {
    log(`[migrations] deferred task patch skipped: ${err.message}`);
  }
}

/**
 * #3 -workspace 迁移 + 非主 agent 巡检默认关闭
 *
 * 两件事：
  *
  * */
function migrateModelRefsToCompositeKey(ctx) {
  const { agentsDir, prefs, providerRegistry, log } = ctx;

  const idToProvider = new Map();
  const rawProviders = providerRegistry.getAllProvidersRaw?.() || {};
  for (const [providerId, p] of Object.entries(rawProviders)) {
    for (const m of p.models || []) {
      const id = typeof m === "object" ? m.id : m;
      if (id && !idToProvider.has(id)) idToProvider.set(id, providerId);
    }
  }

  function normalize(ref) {
    if (!ref) return { value: ref, changed: false };

    if (typeof ref === "object") {
      if (ref.id && ref.provider) return { value: ref, changed: false };
      if (ref.id && !ref.provider) {
        const guess = idToProvider.get(ref.id);
        if (guess) return { value: { id: ref.id, provider: guess }, changed: true };
        return { value: ref, changed: false };
      }
      return { value: ref, changed: false };
    }

    if (typeof ref !== "string") return { value: ref, changed: false };

    const slashIdx = ref.indexOf("/");
    if (slashIdx > 0 && slashIdx < ref.length - 1) {
      return {
        value: { provider: ref.slice(0, slashIdx), id: ref.slice(slashIdx + 1) },
        changed: true,
      };
    }

    const guess = idToProvider.get(ref);
    if (guess) return { value: { id: ref, provider: guess }, changed: true };
    return { value: ref, changed: false };
  }

  const ROLES = ["chat", "utility", "utility_large", "summarizer", "compiler"];

  let agentDirs = [];
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    agentDirs = [];
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.models) continue;

    let changed = false;
    const next = { ...config.models };
    for (const role of ROLES) {
      const { value, changed: ch } = normalize(config.models[role]);
      if (ch) {
        next[role] = value;
        changed = true;
        log?.(`[migrations] #5 ${dir.name}: models.${role} -> ${value.provider}/${value.id}`);
      }
    }

    if (changed) {
      saveConfig(cfgPath, { models: next });
    }
  }

  const preferences = prefs.getPreferences();
  let prefsChanged = false;
  const prefKeys = ["utility_model", "utility_large_model", "summarizer_model", "compiler_model"];
  for (const key of prefKeys) {
    const { value, changed } = normalize(preferences[key]);
    if (changed) {
      preferences[key] = value;
      prefsChanged = true;
      log?.(`[migrations] #5 preferences.${key} -> ${value.provider}/${value.id}`);
    }
  }
  if (prefsChanged) prefs.savePreferences(preferences);
}

function repairPostMigrationModelRefs(ctx) {
  migrateModelRefsToCompositeKey(ctx);
}

function buildModelProviderIndex(providerRegistry) {
  const idToProvider = new Map();
  const providerModelIds = new Map();
  const rawProviders = providerRegistry.getAllProvidersRaw?.() || {};

  for (const [providerId, provider] of Object.entries(rawProviders || {})) {
    const ids = new Set();
    for (const model of provider?.models || []) {
      const id = typeof model === "object" ? model.id : model;
      if (!id) continue;
      ids.add(id);
      if (!idToProvider.has(id)) idToProvider.set(id, providerId);
    }
    providerModelIds.set(providerId, ids);
  }

  return { idToProvider, providerModelIds };
}

function normalizeCronModelRefForMigration(ref, index) {
  if (!ref) return { value: "", changed: ref !== "" };

  if (typeof ref === "object") {
    if (!ref.id) return { value: ref, changed: false };
    if (ref.provider) return { value: ref, changed: false };
    const provider = index.idToProvider.get(ref.id);
    if (provider) return { value: { id: ref.id, provider }, changed: true };
    return { value: ref, changed: false };
  }

  if (typeof ref !== "string") return { value: ref, changed: false };

  const text = ref.trim();
  if (!text) return { value: "", changed: ref !== "" };

  const exactProvider = index.idToProvider.get(text);
  if (exactProvider) return { value: { id: text, provider: exactProvider }, changed: true };

  const slashIdx = text.indexOf("/");
  if (slashIdx > 0 && slashIdx < text.length - 1) {
    const provider = text.slice(0, slashIdx);
    const id = text.slice(slashIdx + 1);
    const knownIds = index.providerModelIds.get(provider);
    if (knownIds?.has(id) || index.providerModelIds.has(provider)) {
      return { value: { id, provider }, changed: true };
    }
  }

  return { value: ref, changed: false };
}

function repairCronJobModelRefs(ctx) {
  const { agentsDir, providerRegistry, log } = ctx;
  const index = buildModelProviderIndex(providerRegistry);

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    return;
  }

  let patched = 0;
  for (const dir of agentDirs) {
    const jobsPath = path.join(agentsDir, dir.name, "desk", "cron-jobs.json");
    if (!fs.existsSync(jobsPath)) continue;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));
    } catch (err) {
      log?.(`[migrations] #11 ${dir.name}: skipped invalid cron-jobs.json (${err.message})`);
      continue;
    }
    if (!Array.isArray(data.jobs)) continue;

    let changed = false;
    for (const job of data.jobs) {
      const { value, changed: modelChanged } = normalizeCronModelRefForMigration(job.model, index);
      if (!modelChanged) continue;
      job.model = value;
      changed = true;
      patched++;
    }

    if (changed) {
      const tmp = `${jobsPath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
      fs.renameSync(tmp, jobsPath);
      log?.(`[migrations] #11 ${dir.name}: repaired cron model refs`);
    }
  }

  log?.(`[migrations] #11: cron model refs repaired (${patched})`);
}

function migrateCronJobsToAutomationReadModel(ctx) {
  const { codiaHome, agentsDir, log } = ctx;
  const paths = [];

  const studiosDir = path.join(codiaHome, "studios");
  try {
    for (const entry of fs.readdirSync(studiosDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.push(path.join(studiosDir, entry.name, "desk", "cron-jobs.json"));
    }
  } catch {}

  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.push(path.join(agentsDir, entry.name, "desk", "cron-jobs.json"));
    }
  } catch {}

  let patchedFiles = 0;
  let patchedJobs = 0;
  for (const jobsPath of paths) {
    const result = patchCronJobsFileForAutomation(jobsPath, log);
    if (!result.changed) continue;
    patchedFiles++;
    patchedJobs += result.patchedJobs;
  }

  log?.(`[migrations] #30: cron automation fields patched (${patchedJobs} jobs in ${patchedFiles} files)`);
}

function patchCronJobsFileForAutomation(jobsPath, log) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      log?.(`[migrations] #30 skipped invalid cron-jobs.json at ${jobsPath} (${err.message})`);
    }
    return { changed: false, patchedJobs: 0 };
  }
  if (!Array.isArray(data.jobs)) return { changed: false, patchedJobs: 0 };

  let patchedJobs = 0;
  const jobs = data.jobs.map((job) => {
    const next = patchAutomationJobForMigration(job);
    if (JSON.stringify(next) !== JSON.stringify(job)) patchedJobs++;
    return next;
  });
  if (!patchedJobs) return { changed: false, patchedJobs: 0 };

  atomicWriteSync(jobsPath, `${JSON.stringify({ ...data, jobs }, null, 2)}\n`);
  return { changed: true, patchedJobs };
}

function migrateDirectNotifyAutomationsToAgentRuns(ctx) {
  const { codiaHome, agentsDir, log } = ctx;
  const paths = [];

  const studiosDir = path.join(codiaHome, "studios");
  try {
    for (const entry of fs.readdirSync(studiosDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.push(path.join(studiosDir, entry.name, "desk", "cron-jobs.json"));
    }
  } catch {}

  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.push(path.join(agentsDir, entry.name, "desk", "cron-jobs.json"));
    }
  } catch {}

  let patchedFiles = 0;
  let patchedJobs = 0;
  for (const jobsPath of paths) {
    const result = patchCronJobsFileForAutomation(jobsPath, log);
    if (!result.changed) continue;
    patchedFiles++;
    patchedJobs += result.patchedJobs;
  }

  log?.(`[migrations] #38: direct notify automations rewritten as Agent runs (${patchedJobs} jobs in ${patchedFiles} files)`);
}

function repairAutomationOwnershipAfterAgentRunConsolidation(ctx) {
  const { codiaHome, agentsDir, log } = ctx;
  const stores = [];

  const studiosDir = path.join(codiaHome, "studios");
  try {
    for (const entry of fs.readdirSync(studiosDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      stores.push({
        jobsPath: path.join(studiosDir, entry.name, "desk", "cron-jobs.json"),
        fallbackAgentId: null,
      });
    }
  } catch {}

  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      stores.push({
        jobsPath: path.join(agentsDir, entry.name, "desk", "cron-jobs.json"),
        fallbackAgentId: entry.name,
      });
    }
  } catch {}

  let patchedFiles = 0;
  let patchedJobs = 0;
  for (const store of stores) {
    const result = repairAutomationOwnershipFile(store.jobsPath, store.fallbackAgentId, log);
    if (!result.changed) continue;
    patchedFiles++;
    patchedJobs += result.patchedJobs;
  }

  log?.(`[migrations] #39: automation ownership repaired (${patchedJobs} jobs in ${patchedFiles} files)`);
}

const AUTOMATION_OWNER_WARNING = {
  code: "missing_automation_owner",
  message: "需要选择执行助手后再启用",
};

const AUTOMATION_EXECUTOR_WARNING = {
  code: "unsupported_automation_executor",
  message: "需要重新保存为 Agent Run 后再启用",
};

function migrationOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function migrationClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function migrationRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function inferAutomationOwner(job, fallbackAgentId) {
  return migrationOptionalString(job?.actorAgentId)
    || migrationOptionalString(job?.executor?.agentId)
    || migrationOptionalString(job?.legacyRef?.agentId)
    || migrationOptionalString(fallbackAgentId);
}

function migrationExecutionContext(job, actorAgentId, fallbackAgentId) {
  const executorContext = migrationRecord(job?.executor?.executionContext);
  const sourceContext = migrationRecord(job?.executionContext) || executorContext;
  const source = sourceContext ? migrationClone(sourceContext) : {};
  const legacyLike = !!migrationOptionalString(job?.legacyRef?.agentId) || !!migrationOptionalString(fallbackAgentId);
  return {
    kind: migrationOptionalString(source.kind) || (legacyLike ? "legacy_agent_home" : "migration_repaired"),
    cwd: migrationOptionalString(source.cwd),
    workspaceFolders: Array.isArray(source.workspaceFolders)
      ? source.workspaceFolders.filter((item) => typeof item === "string" && item.trim())
      : [],
    sourceSessionPath: migrationOptionalString(source.sourceSessionPath),
    createdByAgentId: migrationOptionalString(source.createdByAgentId) || actorAgentId,
  };
}

function repairAutomationJobForOwnership(job, fallbackAgentId) {
  const next = patchAutomationJobForMigration(job);
  const owner = inferAutomationOwner(next, fallbackAgentId);
  const executor = migrationRecord(next.executor);
  const unsupportedExecutor = executor?.kind && executor.kind !== "agent_session";

  if (unsupportedExecutor) {
    return {
      ...next,
      enabled: false,
      migrationWarning: AUTOMATION_EXECUTOR_WARNING,
    };
  }

  if (!owner) {
    const nextExecutor = executor?.kind === "agent_session"
      ? { ...executor, agentId: null }
      : executor;
    return {
      ...next,
      enabled: false,
      executor: nextExecutor,
      createdBy: migrationRecord(next.createdBy) || { kind: "unknown" },
      migrationWarning: AUTOMATION_OWNER_WARNING,
    };
  }

  const executionContext = migrationExecutionContext(next, owner, fallbackAgentId);
  const prompt = typeof next.prompt === "string"
    ? next.prompt
    : typeof executor?.prompt === "string"
      ? executor.prompt
      : "";
  return {
    ...next,
    prompt,
    actorAgentId: owner,
    executionContext,
    executor: {
      ...(executor || {}),
      kind: "agent_session",
      agentId: owner,
      prompt,
      model: Object.prototype.hasOwnProperty.call(next, "model")
        ? migrationClone(next.model ?? "")
        : migrationClone(executor?.model ?? ""),
      executionContext,
    },
    createdBy: migrationRecord(next.createdBy) && next.createdBy.kind !== "unknown"
      ? next.createdBy
      : { kind: "agent", agentId: owner },
    ...(next.migrationWarning?.code === AUTOMATION_OWNER_WARNING.code ? { migrationWarning: undefined } : {}),
  };
}

function repairAutomationOwnershipFile(jobsPath, fallbackAgentId, log) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      log?.(`[migrations] #39 skipped invalid cron-jobs.json at ${jobsPath} (${err.message})`);
    }
    return { changed: false, patchedJobs: 0 };
  }
  if (!Array.isArray(data.jobs)) return { changed: false, patchedJobs: 0 };

  let patchedJobs = 0;
  const jobs = data.jobs.map((job) => {
    const next = repairAutomationJobForOwnership(job, fallbackAgentId);
    if (Object.prototype.hasOwnProperty.call(next, "migrationWarning") && next.migrationWarning === undefined) {
      delete next.migrationWarning;
    }
    if (JSON.stringify(next) !== JSON.stringify(job)) patchedJobs++;
    return next;
  });
  if (!patchedJobs) return { changed: false, patchedJobs: 0 };

  atomicWriteSync(jobsPath, JSON.stringify({ ...data, jobs }, null, 2) + "\n");
  return { changed: true, patchedJobs };
}

function migrateSessionPermissionModeSidecars(ctx) {
  const { agentsDir, log } = ctx;
  const metaPaths = collectAgentSessionMetaPaths(agentsDir);
  let patched = 0;
  for (const metaPath of metaPaths) {
    patched += repairSessionMetaPermissionModes(metaPath, log);
  }
  log?.(`[migrations] #40: session permission sidecars canonicalized (${patched})`);
}

function repairSessionMetaPermissionModes(metaPath, log) {
  let raw;
  try {
    raw = fs.readFileSync(metaPath, "utf-8");
  } catch {
    return 0;
  }

  let meta;
  try {
    meta = JSON.parse(raw);
  } catch (err) {
    log?.(`[migrations] #40: skipped unreadable session-meta ${metaPath}: ${err.message}`);
    return 0;
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return 0;

  let patched = 0;
  for (const [sessionFile, entry] of Object.entries(meta)) {
    if (!shouldCanonicalizeSessionPermissionMode(entry)) continue;
    const permissionMode = normalizeSessionPermissionMode(entry);
    const accessMode = legacyAccessModeFromPermissionMode(permissionMode);
    const planMode = permissionMode === SESSION_PERMISSION_MODES.READ_ONLY;
    if (
      entry.permissionMode === permissionMode
      && entry.accessMode === accessMode
      && entry.planMode === planMode
    ) {
      continue;
    }
    meta[sessionFile] = {
      ...entry,
      permissionMode,
      accessMode,
      planMode,
    };
    patched++;
  }

  if (patched === 0) return 0;
  backupSessionMetaBeforeV40(metaPath, raw, log);
  atomicWriteSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return patched;
}

function shouldCanonicalizeSessionPermissionMode(entry) {
  return entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && (
      typeof entry.permissionMode === "string"
      || typeof entry.accessMode === "string"
      || typeof entry.planMode === "boolean"
    );
}

function backupSessionMetaBeforeV40(metaPath, raw, log) {
  const backupPath = `${metaPath}.pre-v40.bak`;
  try {
    fs.writeFileSync(backupPath, raw, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") return;
    log?.(`[migrations] #40: failed to write session-meta backup ${backupPath}: ${err.message}`);
    throw err;
  }
}

function migrateChannelsToGlobalDefaultOff(ctx) {
  const { agentsDir, prefs, log } = ctx;

  let agentDirs = [];
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    agentDirs = [];
  }

  let anyEnabledTrue = false;
  let anyExplicit = false;

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.channels || typeof config.channels !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(config.channels, "enabled")) continue;
    anyExplicit = true;
    if (config.channels.enabled === true) anyEnabledTrue = true;
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.channels || typeof config.channels !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(config.channels, "enabled")) continue;

    delete config.channels.enabled;
    if (Object.keys(config.channels).length === 0) delete config.channels;

    const tmp = cfgPath + ".tmp";
    fs.writeFileSync(tmp, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");
    fs.renameSync(tmp, cfgPath);
    log?.(`[migrations] #6 ${dir.name}: removed agent-level channels.enabled`);
  }

  const preferences = prefs.getPreferences();
  preferences.channels_enabled = anyEnabledTrue;
  prefs.savePreferences(preferences);

  if (anyEnabledTrue) log?.("[migrations] #6: preferences.channels_enabled = true");
  else if (anyExplicit) log?.("[migrations] #6: preferences.channels_enabled = false");
  else log?.("[migrations] #6: preferences.channels_enabled = false (default)");
}

function migrateVisionToImage(ctx) {
  const { codiaHome, agentsDir, log } = ctx;
  let ymlCount = 0;
  let overrideCount = 0;

  const ymlPath = path.join(codiaHome, "added-models.yaml");
  const raw = safeReadYAMLSync(ymlPath, null, YAML);
  if (raw?.providers && typeof raw.providers === "object") {
    let changed = false;
    for (const prov of Object.values(raw.providers)) {
      if (!prov || !Array.isArray(prov.models)) continue;
      for (const model of prov.models) {
        if (!model || typeof model !== "object") continue;
        if (!Object.prototype.hasOwnProperty.call(model, "vision")) continue;
        if (model.image === undefined) model.image = model.vision;
        delete model.vision;
        changed = true;
        ymlCount++;
      }
    }
    if (changed) {
      const tmp = ymlPath + ".tmp";
      fs.writeFileSync(
        tmp,
        YAML.dump(raw, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }),
        "utf-8",
      );
      fs.renameSync(tmp, ymlPath);
    }
  }

  let agentDirs = [];
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    agentDirs = [];
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.models?.overrides || typeof config.models.overrides !== "object") continue;

    let changed = false;
    for (const override of Object.values(config.models.overrides)) {
      if (!override || typeof override !== "object") continue;
      if (!Object.prototype.hasOwnProperty.call(override, "vision")) continue;
      if (override.image === undefined) override.image = override.vision;
      delete override.vision;
      changed = true;
      overrideCount++;
    }

    if (changed) {
      const tmp = cfgPath + ".tmp";
      fs.writeFileSync(tmp, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");
      fs.renameSync(tmp, cfgPath);
    }
  }

  log?.(`[migrations] #7: vision->image renamed (added-models.yaml=${ymlCount}, agent overrides=${overrideCount})`);
}

function migrateBridgeReadOnlyToGlobal(ctx) {
  const { agentsDir, prefs, log } = ctx;

  let agentDirs = [];
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    agentDirs = [];
  }

  let anyReadOnlyTrue = false;

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.bridge || typeof config.bridge !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(config.bridge, "readOnly")) continue;
    if (config.bridge.readOnly === true) anyReadOnlyTrue = true;
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.bridge || typeof config.bridge !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(config.bridge, "readOnly")) continue;

    delete config.bridge.readOnly;
    if (Object.keys(config.bridge).length === 0) delete config.bridge;

    const tmp = cfgPath + ".tmp";
    fs.writeFileSync(tmp, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");
    fs.renameSync(tmp, cfgPath);
    log?.(`[migrations] #9 ${dir.name}: removed agent-level bridge.readOnly`);
  }

  const preferences = prefs.getPreferences();
  const hadPrefsValue = typeof preferences.bridge?.readOnly === "boolean";
  const finalValue = hadPrefsValue ? preferences.bridge.readOnly : anyReadOnlyTrue;
  const bridgePrefs = { ...(preferences.bridge || {}) };
  if (finalValue) bridgePrefs.readOnly = true;
  else delete bridgePrefs.readOnly;
  if (Object.keys(bridgePrefs).length === 0) delete preferences.bridge;
  else preferences.bridge = bridgePrefs;
  prefs.savePreferences(preferences);
  log?.(`[migrations] #9: preferences.bridge.readOnly = ${!!finalValue}`);
}

function cleanupSummarizerCompilerRemnants(ctx) {
  const { agentsDir, prefs, log } = ctx;

  const preferences = prefs.getPreferences();
  let prefsChanged = false;
  for (const key of ["summarizer_model", "compiler_model"]) {
    if (Object.prototype.hasOwnProperty.call(preferences, key)) {
      delete preferences[key];
      prefsChanged = true;
      log?.(`[migrations] #10: removed preferences.${key}`);
    }
  }
  if (prefsChanged) prefs.savePreferences(preferences);

  let agentDirs = [];
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    agentDirs = [];
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.models || typeof config.models !== "object") continue;

    let changed = false;
    for (const role of ["summarizer", "compiler"]) {
      if (Object.prototype.hasOwnProperty.call(config.models, role)) {
        delete config.models[role];
        changed = true;
        log?.(`[migrations] #10 ${dir.name}: removed models.${role}`);
      }
    }

    if (changed) {
      const tmp = cfgPath + ".tmp";
      fs.writeFileSync(tmp, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");
      fs.renameSync(tmp, cfgPath);
    }
  }
}

function migrateWorkspaceToPerAgent(ctx) {
  const { agentsDir, prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const homeFolder = preferences.home_folder;
  const primaryAgentId = preferences.primaryAgent || null;

 //

  let targetAgentId = null;

  if (primaryAgentId) {
    const cfgPath = path.join(agentsDir, primaryAgentId, "config.yaml");
    if (fs.existsSync(cfgPath)) {
      targetAgentId = primaryAgentId;
    } else {
      log(`[migrations] #3: primaryAgent "${primaryAgentId}" config.yaml not found, scanning`);
    }
  }

  if (!targetAgentId) {
    try {
      const dirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const d of dirs) {
        if (fs.existsSync(path.join(agentsDir, d.name, "config.yaml"))) {
          targetAgentId = d.name;
          break;
        }
      }
    } catch {}
  }

  // ── 2. 迁移 home_folder ──

  if (homeFolder) {
    if (!targetAgentId) {
      throw new Error("no agent with config.yaml found, home_folder preserved in preferences");
    }

    const cfgPath = path.join(agentsDir, targetAgentId, "config.yaml");
    saveConfig(cfgPath, { desk: { home_folder: homeFolder } });

    // Verify write
    const verify = safeReadYAMLSync(cfgPath, null, YAML);
    if (verify?.desk?.home_folder !== homeFolder) {
      throw new Error(`write verification failed for agent ${targetAgentId}, home_folder preserved in preferences`);
    }

    delete preferences.home_folder;
    prefs.savePreferences(preferences);
    log(`[migrations] #3: migrated home_folder "${homeFolder}" -> agent ${targetAgentId}`);
  }

// -- 3. 非主 agent 的巡检默认关闭 --

  try {
    const dirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      if (d.name === targetAgentId) continue; // 目标 agent 保持原状
      const cfgPath = path.join(agentsDir, d.name, "config.yaml");
      if (!fs.existsSync(cfgPath)) continue;

      const config = safeReadYAMLSync(cfgPath, null, YAML);
      if (!config) continue;
 // 只在未显式设置过时关闭（如果用户已经手动设了，尊重他的择-
      if (config.desk?.heartbeat_enabled !== undefined) continue;

      saveConfig(cfgPath, { desk: { heartbeat_enabled: false } });
      log(`[migrations] #3: disabled heartbeat for non-primary agent "${d.name}"`);
    }
  } catch (err) {
    log(`[migrations] #3: warning - failed to disable non-primary heartbeats: ${err.message}`);
  }
}
