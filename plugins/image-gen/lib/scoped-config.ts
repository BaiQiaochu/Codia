import fs from "fs";
import path from "path";

function getScopedConfigPath(dataDir, agentId = null) {
  return agentId
    ? path.join(dataDir, "agents", agentId, "config.json")
    : path.join(dataDir, "config.json");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function isPluginConfigState(data) {
  return data
    && typeof data === "object"
    && !Array.isArray(data)
    && ("global" in data || "agents" in data || "sessions" in data || "schemaVersion" in data);
}

function normalizeBucket(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const MEDIA_DEFAULT_KEYS = new Set([
  "defaultImageModel",
  "defaultAudioModel",
  "defaultMusicModel",
  "defaultVideoModel",
]);

function stripMediaDefaults(bucket) {
  const result = { ...normalizeBucket(bucket) };
  for (const key of MEDIA_DEFAULT_KEYS) delete result[key];
  return result;
}

function clearLegacyMediaDefault(dataDir, agentId, key) {
  if (!agentId || !MEDIA_DEFAULT_KEYS.has(key)) return;
  const filePath = getScopedConfigPath(dataDir, agentId);
  if (!fs.existsSync(filePath)) return;
  const data = normalizeBucket(readJson(filePath));
  if (!(key in data)) return;
  delete data[key];
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function readScopedConfig(ctx, resolvedAgentId) {
  const rootPath = getScopedConfigPath(ctx.dataDir, null);
  const root = readJson(rootPath);

  if (isPluginConfigState(root)) {
    const globalBucket = normalizeBucket(root.global);
    const agentBucket = resolvedAgentId ? normalizeBucket(root.agents?.[resolvedAgentId]) : {};
    const legacyAgent = resolvedAgentId
      ? stripMediaDefaults(readJson(getScopedConfigPath(ctx.dataDir, resolvedAgentId)))
      : {};
    return {
      mode: "plugin-state",
      rootPath,
      data: { ...globalBucket, ...legacyAgent, ...agentBucket },
    };
  }

  const scoped = resolvedAgentId ? readJson(getScopedConfigPath(ctx.dataDir, resolvedAgentId)) : null;
  const fallback = resolvedAgentId ? root : null;
  return {
    mode: "legacy-flat",
    rootPath,
    data: normalizeBucket(scoped || fallback || root),
  };
}

function writeScopedConfig(ctx, resolvedAgentId, key, value) {
  const rootPath = getScopedConfigPath(ctx.dataDir, null);
  const root = readJson(rootPath);

  if (isPluginConfigState(root)) {
    const state = {
      schemaVersion: 1,
      global: normalizeBucket(root.global),
      agents: normalizeBucket(root.agents),
      sessions: normalizeBucket(root.sessions),
    };
    const bucket = resolvedAgentId
      ? (state.agents[resolvedAgentId] = normalizeBucket(state.agents[resolvedAgentId]))
      : state.global;
    bucket[key] = value;
    fs.mkdirSync(path.dirname(rootPath), { recursive: true });
    fs.writeFileSync(rootPath, JSON.stringify(state, null, 2), "utf-8");
    clearLegacyMediaDefault(ctx.dataDir, resolvedAgentId, key);
    return;
  }

  const filePath = getScopedConfigPath(ctx.dataDir, resolvedAgentId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data = normalizeBucket(readJson(filePath));
  data[key] = value;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function createScopedConfigAccessor(ctx, agentId = null) {
  const resolvedAgentId = String(agentId || "").trim() || null;

  return {
    get(key) {
      const { data } = readScopedConfig(ctx, resolvedAgentId);
      return key ? data[key] : data;
    },
    set(key, value) {
      writeScopedConfig(ctx, resolvedAgentId, key, value);
    },
  };
}
