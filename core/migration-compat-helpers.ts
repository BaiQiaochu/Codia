// @ts-nocheck
import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeReadYAMLSync } from "../shared/safe-fs.ts";
import { getInvalidProviderModelIds } from "../shared/provider-model-validation.ts";
import { lookupKnown } from "../shared/known-models.ts";
import { SESSION_PREFIX_MAP } from "../lib/bridge/session-key.ts";
import { normalizeThinkingLevelForModel } from "./session-thinking-level.ts";

export function writeYamlFile(filePath, data) {
  const header =
    "# G-SAP provider configuration (global, shared across agents)\n" +
    "# Managed by Settings.\n\n";
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(
    tmp,
    header + YAML.dump(data, {
      indent: 2,
      lineWidth: -1,
      sortKeys: false,
      quotingType: "\"",
      forceQuotes: false,
    }),
    "utf-8",
  );
  fs.renameSync(tmp, filePath);
}

export function migrateOneBridgeSessionIndex(indexPath, agentId, log) {
  let raw;
  try {
    raw = fs.readFileSync(indexPath, "utf-8");
  } catch {
    return { migrated: 0, merged: 0, collisions: 0 };
  }

  let index;
  try {
    index = JSON.parse(raw);
  } catch (err) {
    log?.(`[migrations] #17: skipped unreadable bridge index ${indexPath}: ${err.message}`);
    return { migrated: 0, merged: 0, collisions: 0 };
  }
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    return { migrated: 0, merged: 0, collisions: 0 };
  }

  let changed = false;
  let migrated = 0;
  let merged = 0;
  let collisions = 0;

  for (const oldKey of Object.keys(index)) {
    const newKey = scopedBridgeSessionKey(oldKey, agentId);
    if (!newKey || newKey === oldKey) continue;

    const oldRaw = index[oldKey];
    const targetRaw = index[newKey];
    if (targetRaw === undefined) {
      index[newKey] = oldRaw;
      delete index[oldKey];
      migrated++;
      changed = true;
      continue;
    }

    const oldEntry = normalizeBridgeIndexEntryForMigration(oldRaw);
    const targetEntry = normalizeBridgeIndexEntryForMigration(targetRaw);
    if (oldEntry.file && targetEntry.file) {
      collisions++;
      continue;
    }

    index[newKey] = serializeBridgeIndexEntryForMigration(targetRaw, {
      ...oldEntry,
      ...targetEntry,
      file: targetEntry.file || oldEntry.file,
    });
    delete index[oldKey];
    merged++;
    changed = true;
  }

  if (changed) {
    const tmp = `${indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, indexPath);
  }

  return { migrated, merged, collisions };
}

function scopedBridgeSessionKey(key, agentId) {
  if (!key || !agentId || String(key).endsWith(`@${agentId}`)) return null;
  if (!SESSION_PREFIX_MAP.some(([prefix]) => String(key).startsWith(prefix))) return null;
  return `${key}@${agentId}`;
}

function normalizeBridgeIndexEntryForMigration(raw) {
  if (!raw) return {};
  return typeof raw === "string" ? { file: raw } : { ...raw };
}

function serializeBridgeIndexEntryForMigration(previousRaw, entry) {
  if (typeof previousRaw === "string" && Object.keys(entry).length === 1 && typeof entry.file === "string") {
    return entry.file;
  }
  return entry;
}

export function repairModelsJsonVideoInputs(ctx) {
  const modelsJsonPath = path.join(ctx.gsapHome, "models.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
  } catch {
    return 0;
  }
  if (!raw?.providers || typeof raw.providers !== "object") return 0;

  let patched = 0;
  for (const [providerId, provider] of Object.entries(raw.providers)) {
    if (!provider || typeof provider !== "object") continue;
    if (Array.isArray(provider.models)) {
      for (const model of provider.models) {
        patched += repairPiModelInputRecord(providerId, model, model?.id);
      }
    }
    if (provider.modelOverrides && typeof provider.modelOverrides === "object" && !Array.isArray(provider.modelOverrides)) {
      for (const [modelId, override] of Object.entries(provider.modelOverrides)) {
        patched += repairPiModelInputRecord(providerId, override, modelId);
      }
    }
  }

  if (patched > 0) {
    const tmp = `${modelsJsonPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 4) + "\n", "utf-8");
    fs.renameSync(tmp, modelsJsonPath);
  }
  return patched;
}

function repairPiModelInputRecord(providerId, record, fallbackModelId) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return 0;

  let patched = 0;
  const hadRuntimeVideoField = Object.prototype.hasOwnProperty.call(record, "video");
  const hadInputVideo = migrationInputIncludes(record.input, "video");
  const shouldEnableVideo = migrationModelHasVideoCapability(providerId, record, fallbackModelId, hadInputVideo);
  const sanitizedInput = sanitizePiInputModalities(record.input);

  if (sanitizedInput.changed) {
    record.input = sanitizedInput.input;
    patched++;
  }
  if (shouldEnableVideo && ensureGsapVideoInputCompat(record)) patched++;
  if (hadRuntimeVideoField) {
    delete record.video;
    patched++;
  }
  return patched;
}

function migrationModelHasVideoCapability(providerId, model, fallbackModelId, hadInputVideo = false) {
  if (model?.video === true) return true;
  if (model?.video === false) return false;
  if (hadInputVideo) return true;
  const modelId = typeof model?.id === "string" ? model.id : fallbackModelId;
  if (!modelId) return false;
  const known = lookupKnown(providerId, modelId);
  return known?.video === true;
}

function migrationInputIncludes(input, modality) {
  return Array.isArray(input) && input.includes(modality);
}

function sanitizePiInputModalities(input) {
  if (input === undefined) return { input, changed: false };

  const source = Array.isArray(input) ? input : [];
  const next = ["text"];
  if (source.includes("image")) next.push("image");

  return {
    input: next,
    changed: !Array.isArray(input)
      || input.length !== next.length
      || input.some((item, index) => item !== next[index]),
  };
}

function ensureGsapVideoInputCompat(record) {
  const compat = record.compat && typeof record.compat === "object" && !Array.isArray(record.compat)
    ? record.compat
    : {};
  const legacyVideoInputCompatKey = ["h", "ana", "VideoInput"].join("");
  if (compat.gsapVideoInput === true && compat[legacyVideoInputCompatKey] !== true && record.compat === compat) return false;
  const nextCompat = { ...compat };
  delete nextCompat[legacyVideoInputCompatKey];
  record.compat = {
    ...nextCompat,
    gsapVideoInput: true,
  };
  return true;
}

export function promoteAgentVideoOverrides(ctx) {
  const { gsapHome, agentsDir } = ctx;
  const ymlPath = path.join(gsapHome, "added-models.yaml");
  const raw = safeReadYAMLSync(ymlPath, null, YAML);
  if (!raw?.providers || typeof raw.providers !== "object") return 0;

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return 0;
  }

  let patched = 0;
  let addedModelsChanged = false;
  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const cfg = safeReadYAMLSync(cfgPath, null, YAML);
    if (!cfg?.models?.overrides || typeof cfg.models.overrides !== "object") continue;

    let cfgChanged = false;
    for (const [modelId, override] of Object.entries(cfg.models.overrides)) {
      if (!override || typeof override !== "object") continue;
      if (!Object.prototype.hasOwnProperty.call(override, "video")) continue;

      const promoted = promoteVideoOverrideIntoAddedModels(raw.providers, modelId, override.video);
      if (promoted) {
        delete override.video;
        patched++;
        cfgChanged = true;
        addedModelsChanged = true;
      }
    }

    if (cfgChanged) {
      for (const [modelId, override] of Object.entries(cfg.models.overrides)) {
        if (override && typeof override === "object" && Object.keys(override).length === 0) {
          delete cfg.models.overrides[modelId];
        }
      }
      if (Object.keys(cfg.models.overrides).length === 0) {
        delete cfg.models.overrides;
      }
      const tmp = `${cfgPath}.tmp`;
      fs.writeFileSync(
        tmp,
        YAML.dump(cfg, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
        "utf-8",
      );
      fs.renameSync(tmp, cfgPath);
    }
  }

  if (addedModelsChanged) writeYamlFile(ymlPath, raw);
  return patched;
}

function promoteVideoOverrideIntoAddedModels(providers, modelId, video) {
  for (const provider of Object.values(providers)) {
    if (!provider || !Array.isArray(provider.models)) continue;
    const idx = provider.models.findIndex((entry) => {
      if (typeof entry === "string") return entry === modelId;
      return entry && typeof entry === "object" && entry.id === modelId;
    });
    if (idx < 0) continue;

    const existing = typeof provider.models[idx] === "object"
      ? provider.models[idx]
      : { id: modelId };
    provider.models[idx] = { ...existing, video };
    return true;
  }
  return false;
}

export function collectAgentSessionMetaPaths(agentsDir) {
  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }

  const out = [];
  for (const dir of agentDirs) {
    const metaPath = path.join(agentsDir, dir.name, "sessions", "session-meta.json");
    try {
      if (fs.statSync(metaPath).isFile()) out.push(metaPath);
    } catch {
      // Most agents will not have a sidecar before their first persisted session.
    }
  }
  return out;
}

export function repairSessionMetaThinkingLevels(metaPath, log) {
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
    log?.(`[migrations] #15: skipped unreadable session-meta ${metaPath}: ${err.message}`);
    return 0;
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return 0;

  let patched = 0;
  for (const [sessionFile, entry] of Object.entries(meta)) {
    if (!shouldRepairLegacyPromptSnapshotThinkingLevel(entry)) continue;
    const nextThinkingLevel = normalizeThinkingLevelForModel(entry.thinkingLevel, legacySessionMetaModelRef(entry));
    if (nextThinkingLevel === entry.thinkingLevel) continue;
    meta[sessionFile] = {
      ...entry,
      thinkingLevel: nextThinkingLevel,
    };
    patched++;
  }

  if (patched === 0) return 0;

  backupSessionMetaBeforeV15(metaPath, raw, log);
  const tmp = `${metaPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, metaPath);
  return patched;
}

function shouldRepairLegacyPromptSnapshotThinkingLevel(entry) {
  return entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && entry.thinkingLevel === "xhigh"
    && entry.promptSnapshot
    && typeof entry.promptSnapshot === "object"
    && !Array.isArray(entry.promptSnapshot);
}

function legacySessionMetaModelRef(entry) {
  const legacyModel = entry?.model;
  if (legacyModel && typeof legacyModel === "object" && !Array.isArray(legacyModel)) {
    const id = typeof legacyModel.id === "string" ? legacyModel.id : "";
    if (id) {
      return {
        id,
        provider: typeof legacyModel.provider === "string" ? legacyModel.provider : undefined,
        xhigh: legacyModel.xhigh === true,
      };
    }
  }
  if (typeof legacyModel === "string" && legacyModel.trim()) {
    const raw = legacyModel.trim();
    const slash = raw.indexOf("/");
    if (slash > 0 && slash < raw.length - 1) {
      return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) };
    }
    return { id: raw };
  }

  const id = typeof entry?.modelId === "string" ? entry.modelId : "";
  if (!id) return null;
  return {
    id,
    provider: typeof entry.modelProvider === "string" ? entry.modelProvider : undefined,
  };
}

function backupSessionMetaBeforeV15(metaPath, raw, log) {
  const backupPath = `${metaPath}.pre-v15.bak`;
  try {
    fs.writeFileSync(backupPath, raw, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") return;
    log?.(`[migrations] #15: failed to write session-meta backup ${backupPath}: ${err.message}`);
    throw err;
  }
}

function modelIdOfMigrationEntry(entry) {
  if (typeof entry === "object" && entry !== null) return typeof entry.id === "string" ? entry.id : "";
  return typeof entry === "string" ? entry : "";
}

function defaultDeepSeekModelsForMigration(ctx, providerId) {
  const direct = ctx.providerRegistry?.getDefaultModels?.(providerId);
  if (Array.isArray(direct) && direct.length > 0) return [...direct];
  const official = ctx.providerRegistry?.getDefaultModels?.("deepseek");
  if (Array.isArray(official) && official.length > 0) return [...official];
  return ["deepseek-v4-pro", "deepseek-v4-flash"];
}

export function repairLegacyDeepSeekProviderModelIds(ctx) {
  const { gsapHome, log } = ctx;
  const ymlPath = path.join(gsapHome, "added-models.yaml");
  const raw = safeReadYAMLSync(ymlPath, null, YAML);
  if (!raw?.providers || typeof raw.providers !== "object") return 0;

  let patched = 0;
  for (const [providerId, provider] of Object.entries(raw.providers)) {
    if (!provider || !Array.isArray(provider.models)) continue;

    const invalid = new Set(
      getInvalidProviderModelIds(providerId, provider.models, { baseUrl: provider.base_url })
        .map((id) => String(id).trim().toLowerCase()),
    );
    if (invalid.size === 0) continue;

    const nextModels = provider.models.filter((entry) => {
      const id = modelIdOfMigrationEntry(entry).trim().toLowerCase();
      return id && !invalid.has(id);
    });

    provider.models = nextModels.length > 0
      ? nextModels
      : defaultDeepSeekModelsForMigration(ctx, providerId);
    patched++;
    log?.(`[migrations] #13 ${providerId}: removed reserved DeepSeek model id(s) ${[...invalid].join(", ")}`);
  }

  if (patched > 0) writeYamlFile(ymlPath, raw);
  return patched;
}

export function normalizeLegacyMemoryMasterDefaults(ctx) {
  const { agentsDir, log } = ctx;
  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return 0;
  }

  let patched = 0;
  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const cfg = safeReadYAMLSync(cfgPath, null, YAML);
    if (!cfg || typeof cfg !== "object") continue;

    const memoryIsObject = cfg.memory && typeof cfg.memory === "object" && !Array.isArray(cfg.memory);
    if (memoryIsObject && Object.prototype.hasOwnProperty.call(cfg.memory, "enabled")) continue;

    cfg.memory = memoryIsObject
      ? { ...cfg.memory, enabled: true }
      : { enabled: true };

    const tmp = `${cfgPath}.tmp`;
    fs.writeFileSync(
      tmp,
      YAML.dump(cfg, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
      "utf-8",
    );
    fs.renameSync(tmp, cfgPath);
    patched++;
    log?.(`[migrations] #13 ${dir.name}: memory.enabled set to true for legacy implicit default`);
  }

  return patched;
}

export function collectLegacySessionJsonlPaths(agentsDir) {
  let agents = [];
  try {
    agents = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const agentDir = path.join(agentsDir, agent.name);
    collectJsonlRecursive(path.join(agentDir, "sessions"), out);
    collectJsonlRecursive(path.join(agentDir, "subagent-sessions"), out);
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
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlRecursive(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(fullPath);
    }
  }
}

export function legacySessionFileRefs(msg) {
  const details = msg?.details;
  if (!details || typeof details !== "object") return [];

  const refs = [];
  const toolName = msg.toolName;

  if (toolName === "stage_files" || toolName === "present_files") {
    if (Array.isArray(details.files)) {
      for (const file of details.files) {
        pushLegacyFileRef(refs, file, {
          origin: file?.origin || "stage_files",
          storageKind: file?.storageKind || "external",
        });
      }
    }
    pushLegacyFileRef(refs, details, {
      origin: details.origin || "stage_files",
      storageKind: details.storageKind || "external",
    });
  }

  if (toolName === "create_artifact") {
    const artifactFile = details.artifactFile || details.sessionFile || details.file;
    pushLegacyFileRef(refs, artifactFile, {
      origin: artifactFile?.origin || "agent_artifact",
      storageKind: artifactFile?.storageKind || "external",
      label: details.title,
    });
  }

  if (toolName === "install_skill") {
    pushLegacyFileRef(refs, details.installedFile || details.sourceFile || details, {
      origin: "skill_install_source",
      storageKind: "install_source",
      label: details.skillName,
    });
  }

  if (toolName === "install_plugin" || toolName === "plugin_install") {
    pushLegacyFileRef(refs, details.installedFile || details.sourceFile || details, {
      origin: "plugin_install_source",
      storageKind: "install_source",
      label: details.pluginName || details.name,
    });
  }

  if (details.card?.file || details.card?.sessionFile || details.card?.sourceFile) {
    pushLegacyFileRef(refs, details.card.file || details.card.sessionFile || details.card.sourceFile, {
      origin: "plugin_output",
      storageKind: "plugin_data",
      label: details.card.title,
    });
  }

  if (Array.isArray(details.media?.items)) {
    for (const item of details.media.items) {
      pushLegacyFileRef(refs, item, {
        origin: item.origin || "agent_output",
        storageKind: item.storageKind || "external",
      });
    }
  }

  return refs;
}

function pushLegacyFileRef(refs, candidate, defaults = {}) {
  if (!candidate || typeof candidate !== "object") return;
  const filePath = candidate.filePath || candidate.path || candidate.realPath || candidate.localPath;
  if (!filePath) return;
  refs.push({
    filePath,
    label: candidate.label || candidate.displayName || candidate.filename || candidate.name || defaults.label,
    origin: candidate.origin || defaults.origin || "unknown",
    storageKind: candidate.storageKind || defaults.storageKind || "external",
  });
}

export function registerLegacySessionFile({ registry, sessionPath, ref, gsapHome, log }) {
  if (!ref?.filePath || !path.isAbsolute(ref.filePath)) return false;
  if (!fs.existsSync(ref.filePath)) return false;

  try {
    registry.registerFile({
      sessionPath,
      filePath: ref.filePath,
      label: ref.label || path.basename(ref.filePath),
      origin: ref.origin || "unknown",
      storageKind: normalizeLegacyStorageKind(ref, gsapHome),
    });
    return true;
  } catch (err) {
    log(`[migrations] #12: skipped file ${ref.filePath} in ${sessionPath} (${err.message})`);
    return false;
  }
}

function normalizeLegacyStorageKind(ref, gsapHome) {
  const storageKind = ref.storageKind || "external";
  if (storageKind !== "managed_cache") return storageKind;

  const managedRoot = path.join(gsapHome, "session-files");
  const resolved = normalizeExistingOrResolvedPathForMigration(ref.filePath);
  const root = normalizeExistingOrResolvedPathForMigration(managedRoot);
  const rel = path.relative(root, resolved);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
    ? "managed_cache"
    : "external";
}

function normalizeExistingOrResolvedPathForMigration(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function legacyBrowserScreenshot(msg) {
  if (msg?.toolName !== "browser" || msg?.details?.action !== "screenshot") return null;
  if (msg.details?.screenshotFile || msg.details?.fileId || msg.details?.id) return null;

  const image = Array.isArray(msg.content)
    ? msg.content.find((block) => block?.type === "image" && block?.data)
    : null;
  const base64 = image?.data || msg.details?.thumbnail || msg.details?.base64;
  if (!base64) return null;
  return {
    base64,
    mimeType: image?.mimeType || msg.details?.mimeType || "image/png",
  };
}
