// @ts-nocheck
/**
  *
 *
  * */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import YAML from "js-yaml";
import { Agent } from "./agent.ts";
import { safeReadYAMLSync } from "../shared/safe-fs.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { clearConfigCache } from "../lib/memory/config-loader.ts";
import { t } from "../lib/i18n.ts";
import { ActivityStore } from "../lib/desk/activity-store.ts";
import { createHash } from "crypto";
import { hasCompiledMemory, writeCompiledMemorySnapshot } from "../lib/memory/compiled-memory-snapshot.ts";
import { detachAgentFromBundles } from "../lib/skill-bundles/store.ts";
import {
  generateAgentId as _generateAgentId,
  generateDescription,
} from "./llm-utils.ts";
import { findModel, parseModelRef } from "../shared/model-ref.ts";
import { DEFAULT_HEARTBEAT_INTERVAL_MINUTES } from "../shared/default-workspace.ts";
import { relativePathInsideBase } from "./message-utils.ts";
import { assertKnownYuan, getAgentConfigRepairState } from "./yuan-registry.ts";
import { readDirectoryLikeDirentsSync } from "../shared/link-aware-fs.ts";

const log = createModuleLogger("agent-mgr");
const DELETED_AGENT_TOMBSTONE = ".deleted-agent.json";

function writeStartupLog(startupLog, message) {
  if (typeof startupLog === "function") {
    startupLog(message);
  } else if (typeof startupLog?.log === "function") {
    startupLog.log(message);
  }
}

function writeStartupError(startupLog, message) {
  if (typeof startupLog?.error === "function") {
    startupLog.error(message);
  } else {
    writeStartupLog(startupLog, message);
  }
}

function normalizeYuanType(yuan) {
  const raw = String(yuan || "").trim();
  if (!raw) return "codia";
  return raw;
}

function statusError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeAgentPluginMeta(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ownerPluginId: null,
      visibility: "public",
    };
  }
  const ownerPluginId = typeof raw.ownerPluginId === "string" && raw.ownerPluginId.trim()
    ? raw.ownerPluginId.trim()
    : null;
  const visibility = typeof raw.visibility === "string" && raw.visibility.trim()
    ? raw.visibility.trim()
    : "public";
  return {
    ownerPluginId,
    visibility,
    ...(typeof raw.kind === "string" && raw.kind.trim() ? { kind: raw.kind.trim() } : {}),
  };
}

function agentMatchesListOptions(agent, options = {}) {
  const ownerPluginId = typeof options.ownerPluginId === "string" && options.ownerPluginId.trim()
    ? options.ownerPluginId.trim()
    : null;
  const includePluginPrivate = options.includePluginPrivate === true;
  const plugin = normalizeAgentPluginMeta(agent?.plugin);
  if (ownerPluginId && plugin.ownerPluginId !== ownerPluginId) return false;
  if (
    (plugin.visibility === "plugin_private" || plugin.visibility === "private")
    && !includePluginPrivate
    && plugin.ownerPluginId !== ownerPluginId
  ) {
    return false;
  }
  return true;
}

function normalizeCreateAgentHomeFolder(value, { strict = false } = {}) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!path.isAbsolute(trimmed)) {
    if (strict) throw statusError("homeFolder must be an absolute path");
    return null;
  }
  const resolved = path.resolve(trimmed);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    if (strict) throw statusError("homeFolder must be an existing directory");
    return null;
  }
  if (!stat.isDirectory()) {
    if (strict) throw statusError("homeFolder must be an existing directory");
    return null;
  }
  return resolved;
}

export class AgentManager {
  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {string} deps.productDir
   * @param {string} deps.userDir
   * @param {string} deps.channelsDir
   * @param {() => import('./preferences-manager.ts').PreferencesManager} deps.getPrefs
   * @param {() => import('./model-manager.ts').ModelManager} deps.getModels
   * @param {() => object|null} deps.getHub
   * @param {() => import('./skill-manager.ts').SkillManager} deps.getSkills
   * @param {() => object} deps.getSearchConfig
   * @param {() => object} deps.resolveUtilityConfig
   * @param {() => object} deps.getSharedModels
   * @param {() => import('./channel-manager.ts').ChannelManager} deps.getChannelManager
   * @param {() => import('./session-coordinator.ts').SessionCoordinator} deps.getSessionCoordinator
   */
  constructor(deps) {
    this._d = deps;
    this._agents = new Map();
    this._activeAgentId = null;
    this._switchQueue = Promise.resolve();
    this._activityStores = new Map();
    this._agentListCache = null;       // { raw: [{id,name,yuan,identity}], ts: number }
    this._descRefreshPending = false;
    this._runtimeInitPromises = new Map();
    this._runtimeInitQueue = [];
    this._runtimeInitRunning = 0;
    this._runtimeInitConcurrency = 2;
    this._memoryMaintenanceQueue = [];
    this._memoryMaintenanceQueued = new Set();
    this._memoryMaintenanceRunning = 0;
    this._memoryMaintenanceConcurrency = 1;
  }

 /** */
  invalidateAgentListCache() { this._agentListCache = null; }

  get agents() { return this._agents; }
  get activeAgentId() { return this._activeAgentId; }
  set activeAgentId(id) { this._activeAgentId = id; }
  get switching() { return this._switchQueue !== Promise.resolve(); }

 /** 当前焦点 agent */
  get agent() { return this._agents.get(this._activeAgentId); }

  /** */
  getAgent(agentId) { return this._agents.get(agentId) || null; }

 //

  _deletedAgentTombstonePath(agentId) {
    return path.join(this._d.agentsDir, agentId, DELETED_AGENT_TOMBSTONE);
  }

  _readDeletedAgentInfo(agentId) {
    const agentDir = path.join(this._d.agentsDir, agentId);
    const tombstonePath = this._deletedAgentTombstonePath(agentId);
    if (!fs.existsSync(tombstonePath)) return null;
    let tombstone = {};
    try {
      tombstone = JSON.parse(fs.readFileSync(tombstonePath, "utf-8"));
    } catch {}
    let cfg = {};
    try {
      cfg = safeReadYAMLSync(path.join(agentDir, "config.yaml"), {}, YAML);
    } catch {}
    const name = tombstone.agentName || cfg.agent?.name || agentId;
    return {
      id: agentId,
      name,
      agentName: name,
      yuan: tombstone.yuan || cfg.agent?.yuan || "codia",
      deletedAt: tombstone.deletedAt || null,
    };
  }

  isAgentDeleted(agentId) {
    if (!agentId) return false;
    return !!this._readDeletedAgentInfo(agentId);
  }

  getDeletedAgentInfo(agentId) {
    if (!agentId) return null;
    return this._readDeletedAgentInfo(agentId);
  }

  get activityStores() { return this._activityStores; }

  getActivityStore(agentId) {
    let store = this._activityStores.get(agentId);
    if (!store) {
      const agDir = path.join(this._d.agentsDir, agentId);
      store = new ActivityStore(
        path.join(agDir, "desk", "activities.json"),
        path.join(agDir, "activity"),
      );
      this._activityStores.set(agentId, store);
    }
    return store;
  }

  // ── Init ──

  async initAllAgents(log, startId) {
    this._activeAgentId = startId;

    const entries = this._scanAgentDirs();
    const ids = new Set([this._activeAgentId, ...entries.map(e => e.name)].filter(Boolean));
    for (const agentId of ids) {
      await this._loadAgentConfigOnly(agentId, { required: agentId === this._activeAgentId });
    }

    let activeRuntimeReady = false;
    try {
      await this.ensureAgentRuntime(this._activeAgentId, {
        log,
        priority: "foreground",
        reason: "startup",
      });
      activeRuntimeReady = true;
    } catch (err) {
      writeStartupError(log, `foreground agent "${this._activeAgentId}" init failed: ${err.message}`);
      if (err.stack) writeStartupError(log, err.stack);
      if (!this._agents.has(this._activeAgentId)) {
        await this._loadAgentConfigOnly(this._activeAgentId, { required: true });
      }
    }

    writeStartupLog(log, `[init] ${this._agents.size} agents loaded, foreground runtime ${activeRuntimeReady ? "ready" : "pending repair"}`);
  }

  async _loadAgentConfigOnly(agentId, { required = false } = {}) {
    if (this._agents.has(agentId)) return this._agents.get(agentId);

    const ag = this._createAgentInstance(agentId, () => ({}));
    ag.setGetOwnerIds(this._makeOwnerIdsFn(ag));
    try {
      ag.loadConfigOnly();
    } catch (err) {
      console.error(`[agent-manager] agent "${agentId}" config load failed: ${err.message}`);
      if (!required) return null;
      throw err;
    }
    this._registerAgent(agentId, ag);
    return ag;
  }

  async ensureAgentRuntime(agentId, options = {}) {
    if (!agentId) throw new Error("ensureAgentRuntime: agentId is required");
    let ag = this._agents.get(agentId);
    if (!ag) {
      ag = await this._loadAgentConfigOnly(agentId, { required: true });
    }
    if (!ag) throw new Error(t("error.agentNotFound", { id: agentId }));
    if (ag.runtimeInitialized === true) return ag;

    const existing = this._runtimeInitPromises.get(agentId);
    if (existing) return existing;

    const promise = new Promise((resolve, reject) => {
      this._runtimeInitQueue.push({
        agentId,
        priority: options.priority === "foreground" ? 0 : 1,
        log: options.log || (() => {}),
        resolve,
        reject,
      });
      this._pumpRuntimeInitQueue();
    });
    this._runtimeInitPromises.set(agentId, promise);
    return promise;
  }

  _pumpRuntimeInitQueue() {
    while (this._runtimeInitRunning < this._runtimeInitConcurrency && this._runtimeInitQueue.length) {
      this._runtimeInitQueue.sort((a, b) => a.priority - b.priority);
      const task = this._runtimeInitQueue.shift();
      this._runtimeInitRunning++;
      this._runRuntimeInitTask(task)
        .then(task.resolve, task.reject)
        .finally(() => {
          this._runtimeInitRunning--;
          this._runtimeInitPromises.delete(task.agentId);
          this._pumpRuntimeInitQueue();
        });
    }
  }

  async _runRuntimeInitTask(task) {
    const ag = this._agents.get(task.agentId);
    if (!ag) throw new Error(t("error.agentNotFound", { id: task.agentId }));
    if (ag.runtimeInitialized === true) return ag;
    if (typeof ag.init !== "function") return ag;

    const sharedModels = this._d.getSharedModels?.() || {};
    const resolveModel = (bareId) =>
      this._d.getModels().resolveModelWithCredentials(bareId);
    await ag.init(task.log, sharedModels, resolveModel);
    this._d.getSkills()?.syncAgentSkills?.(ag);
    this._d.getHub()?.scheduler?.startAgentHeartbeat?.(task.agentId, ag);
    return ag;
  }

  scheduleAgentMemoryMaintenance(agentId, reason = "manual", agentRef = null) {
    if (!agentId || this._memoryMaintenanceQueued.has(agentId)) return;
    this._memoryMaintenanceQueued.add(agentId);
    this._memoryMaintenanceQueue.push({ agentId, reason, agentRef });
    this._pumpMemoryMaintenanceQueue();
  }

  _pumpMemoryMaintenanceQueue() {
    while (this._memoryMaintenanceRunning < this._memoryMaintenanceConcurrency && this._memoryMaintenanceQueue.length) {
      const task = this._memoryMaintenanceQueue.shift();
      this._memoryMaintenanceRunning++;
      this._runMemoryMaintenanceTask(task)
        .catch((err) => {
          console.error(`[memory] background maintenance failed (${task.agentId}, ${task.reason}): ${err.message}`);
        })
        .finally(() => {
          this._memoryMaintenanceQueued.delete(task.agentId);
          this._memoryMaintenanceRunning--;
          this._pumpMemoryMaintenanceQueue();
        });
    }
  }

  async _runMemoryMaintenanceTask({ agentId, agentRef }) {
    const ag = agentRef || this._agents.get(agentId);
    if (ag?.runtimeInitialized !== true || !ag.memoryTicker) return;
    await ag.memoryTicker.tick();
  }

  static AGENT_LIST_TTL = 30_000;
  listAgents(options = {}) {
    const now = Date.now();
    if (!this._agentListCache || now - this._agentListCache.ts > AgentManager.AGENT_LIST_TTL) {
      this._agentListCache = { raw: this._scanAgentList(), ts: now };
    }

    const prefs = this._d.getPrefs();
    const primaryId = prefs.getPrimaryAgent();
    const order = prefs.getPreferences()?.agentOrder || [];

    let agents = this._agentListCache.raw.map(a => ({
      ...a,
      isPrimary: a.id === primaryId,
      isCurrent: a.id === this._activeAgentId,
    }));
    agents = agents.filter((agent) => agentMatchesListOptions(agent, options));

    if (order.length) {
      agents.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    }

 // lazy refresh：在返回列表后，异步刷新缺少 description -agent（每次最-1 个）
    if (!this._descRefreshPending) {
      const needsRefresh = agents.find(a => !this._hasDescription(a.id));
      if (needsRefresh) {
        this._descRefreshPending = true;
        this._refreshDescription(needsRefresh.id)
          .catch(() => {})
          .finally(() => { this._descRefreshPending = false; });
      }
    }

    return agents;
  }

  listDeletedAgents() {
    try {
      return readDirectoryLikeDirentsSync(this._d.agentsDir)
        .map(entry => this._readDeletedAgentInfo(entry.name))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  listActiveAgentsForRoster() {
    return this._scanAgentList().map((agent) => {
      let summary = "";
      try {
        summary = fs.readFileSync(path.join(this._d.agentsDir, agent.id, "description.md"), "utf-8")
          .split(/\r?\n/)
          .filter((line) => !line.trim().startsWith("<!--"))
          .join("\n")
          .trim();
      } catch {}
      const chatModel = agent.chatModel;
      const model = typeof chatModel === "string"
        ? chatModel
        : (chatModel?.id || "");
      return {
        id: agent.id,
        name: agent.name || agent.id,
        summary,
        model,
      };
    });
  }

 /** */
  _scanAgentList() {
    const entries = readDirectoryLikeDirentsSync(this._d.agentsDir);
    const agents = [];
    for (const entry of entries) {
      if (this.isAgentDeleted(entry.name)) continue;
      const configPath = path.join(this._d.agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(configPath)) continue;
      try {
        const cfg = safeReadYAMLSync(configPath, {}, YAML);
        let identity = "";
        try {
          const idMd = fs.readFileSync(path.join(this._d.agentsDir, entry.name, "identity.md"), "utf-8");
          const lines = idMd.split("\n").filter(l => l.trim() && !l.startsWith("#"));
          identity = lines[0]?.trim() || "";
        } catch {}
        const avatarDir = path.join(this._d.agentsDir, entry.name, "avatars");
        let hasAvatar = false;
        try {
          const avatarFiles = fs.readdirSync(avatarDir);
          hasAvatar = avatarFiles.some(f => /\.(png|jpe?g|gif|webp)$/i.test(f));
        } catch {}
        const chatRef = cfg.models?.chat;
        const chatModel = typeof chatRef === "object"
          ? { id: chatRef.id, provider: chatRef.provider }
          : (chatRef ? { id: chatRef } : null);
        const repairState = getAgentConfigRepairState(cfg, this._d.productDir);
        agents.push({
          id: entry.name,
          name: cfg.agent?.name || entry.name,
          yuan: normalizeYuanType(cfg.agent?.yuan),
          plugin: normalizeAgentPluginMeta(cfg.plugin),
          identity,
          hasAvatar,
          chatModel,
          memoryMasterEnabled: cfg.memory?.enabled !== false,
          needsRepair: !!repairState,
          repairState,
        });
      } catch {}
    }
    return agents;
  }

 /** */
  _hasDescription(agentId) {
    try {
      fs.accessSync(path.join(this._d.agentsDir, agentId, "description.md"));
      return true;
    } catch { return false; }
  }

  /**
    *
 * 通过 hash 比对 personality + yuan 类型，变化时调用 LLM 重新生成- */
  async _refreshDescription(agentId) {
    try {
      const ag = this._agents.get(agentId);
      if (!ag) return;

      const personality = ag.personality;
      const yuan = normalizeYuanType(ag.config?.agent?.yuan);
      const hash = createHash("sha256").update(personality + "\n" + yuan).digest("hex");

      const descPath = path.join(this._d.agentsDir, agentId, "description.md");

 // 读取已有 hash
      try {
        const firstLine = fs.readFileSync(descPath, "utf-8").split("\n")[0].trim();
        const match = firstLine.match(/^<!--\s*sourceHash:\s*(\S+)\s*-->$/);
        if (match?.[1] === hash) return; // 没变化，跳过
      } catch {} // 文件不存在，继续生成

      const utilConfig = this._d.resolveUtilityConfig({ agentId });
      const locale = ag.config?.locale || "zh";
      const desc = await generateDescription(utilConfig, personality, locale);
      if (!desc) {
        log.log(`[description] ${agentId}: skipped; no utility model response`);
        return;
      }

      fs.writeFileSync(descPath, `<!-- sourceHash: ${hash} -->\n${desc}`, "utf-8");
      log.log(`[description] ${agentId}: updated`);
    } catch (err) {
      console.warn(`[agent-mgr] _refreshDescription(${agentId}) failed:`, err.message);
    }
  }

  // ── Create ──

  /**
   * Best-effort rollback of createAgent's partial state.
   * Called when any step between fs.mkdirSync and this._agents.set fails.
   * All cleanup is wrapped in try/catch so a cleanup failure doesn't mask
   * the original error.
   */
  async _rollbackAgentCreation(agentDir, agentId) {
    try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch {}
    try { await this._d.getChannelManager().cleanupAgentFromChannels(agentId); } catch {}
  }

  async createAgent(opts = {}) {
    const { name, id, yuan, enabledSkills, initialFiles, avatarPath, initialMemory } = opts;
    if (!name?.trim()) throw new Error(t("error.agentNameEmpty"));
    const explicitHomeFolder = opts.homeFolder ?? opts.home_folder ?? opts.cwd ?? null;
    const implicitHomeFolder = this._d.getEngine?.()?.deskCwd || this._d.getEngine?.()?.homeCwd || null;
    const agentHomeFolder = normalizeCreateAgentHomeFolder(
      explicitHomeFolder || implicitHomeFolder,
      { strict: !!explicitHomeFolder },
    );

    const agentId = id?.trim() || await this._generateAgentId(name);
    if (/[/\\]|\.\./.test(agentId)) throw new Error(t("error.agentIdInvalid"));
    const agentDir = path.join(this._d.agentsDir, agentId);

    if (fs.existsSync(agentDir)) {
      throw new Error(t("error.agentAlreadyExists", { id: agentId }));
    }

    //
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });

    //
    const templateConfig = fs.readFileSync(path.join(this._d.productDir, "config.example.yaml"), "utf-8");
    const currentAgent = this.agent;
    const userName = currentAgent?.userName || "";
    const configSeed = YAML.load(templateConfig);
    if (!configSeed || typeof configSeed !== "object" || Array.isArray(configSeed)) {
      throw new Error("Invalid config.example.yaml");
    }
    const yuanType = assertKnownYuan(this._d.productDir, yuan || "codia");
    const config = configSeed;
    config.agent = { ...(config.agent || {}), name: name.trim(), yuan: yuanType };
    config.desk = {
      ...(config.desk || {}),
      ...(agentHomeFolder ? { home_folder: agentHomeFolder } : {}),
      heartbeat_enabled: false,
      heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
    };
    config.memory = {
      ...(config.memory || {}),
      enabled: config.memory?.enabled !== false,
    };
    if (userName) {
      config.user = { ...(config.user || {}), name: userName };
    }
    const fillTemplate = (content) => content
      .replace(/\{\{agentName\}\}/g, name.trim())
      .replace(/\{\{userName\}\}/g, currentAgent?.userName || t("error.fallbackUserName"));
    const writeFirstTemplate = (sources, destPath) => {
      for (const src of sources) {
        if (!fs.existsSync(src)) continue;
        fs.writeFileSync(destPath, fillTemplate(fs.readFileSync(src, "utf-8")), "utf-8");
        return true;
      }
      return false;
    };
    const isZh = String(currentAgent?.config?.locale || "zh").startsWith("zh");
    const langDir = isZh ? "" : "en/";
    // Inherit the current agent chat model as a structured model reference.
    const chatRef = parseModelRef(currentAgent?.config?.models?.chat);
    const defaultModel = this._d.getModels().defaultModel;
    const inheritedChat = (chatRef?.id && chatRef.provider)
      ? { id: chatRef.id, provider: chatRef.provider }
      : (defaultModel?.id && defaultModel?.provider)
        ? { id: defaultModel.id, provider: defaultModel.provider }
        : null;
    if (inheritedChat) {
      config.models = { ...(config.models || {}), chat: inheritedChat };
    }
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }),
      "utf-8",
    );

    // identity.md
    writeFirstTemplate([
      path.join(this._d.productDir, "identity-templates", `${langDir}${yuanType}.md`),
      path.join(this._d.productDir, "identity-templates", `${yuanType}.md`),
      path.join(this._d.productDir, "identity.example.md"),
    ], path.join(agentDir, "identity.md"));

    // ishiki.md
    writeFirstTemplate([
      path.join(this._d.productDir, "ishiki-templates", `${langDir}${yuanType}.md`),
      path.join(this._d.productDir, "ishiki-templates", `${yuanType}.md`),
      path.join(this._d.productDir, "ishiki.example.md"),
    ], path.join(agentDir, "ishiki.md"));

 // public-ishiki.md（对外意识模板）
    writeFirstTemplate([
      path.join(this._d.productDir, "public-ishiki-templates", `${langDir}${yuanType}.md`),
      path.join(this._d.productDir, "public-ishiki-templates", `${yuanType}.md`),
    ], path.join(agentDir, "public-ishiki.md"));

    const initialFileMap = {
      identity: "identity.md",
      ishiki: "ishiki.md",
      publicIshiki: "public-ishiki.md",
    };
    if (initialFiles && typeof initialFiles === "object") {
      for (const [key, fileName] of Object.entries(initialFileMap)) {
        if (typeof initialFiles[key] === "string") {
          fs.writeFileSync(path.join(agentDir, fileName), initialFiles[key], "utf-8");
        }
      }
    }

    if (avatarPath) {
      if (!path.isAbsolute(avatarPath) || !fs.existsSync(avatarPath)) {
        throw new Error("avatarPath must be an existing absolute path");
      }
      const ext = path.extname(avatarPath).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
        throw new Error("avatarPath must be a png, jpg, jpeg, or webp image");
      }
      const normalizedExt = ext === ".jpeg" ? ".jpg" : ext;
      fs.copyFileSync(avatarPath, path.join(agentDir, "avatars", `agent${normalizedExt}`));
    }

    if (initialMemory?.compiled && hasCompiledMemory(initialMemory.compiled)) {
      writeCompiledMemorySnapshot(path.join(agentDir, "memory"), initialMemory.compiled, {
        sourceId: initialMemory.sourceId,
        sourcePackage: initialMemory.sourcePackage,
        source: "character-card",
      });
    }

 // 可文件：确保存在（即使为空），避免运行时 ENOENT
    const touchIfMissing = (p) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
    touchIfMissing(path.join(agentDir, 'pinned.md'));

 // 频道系统
    try {
      await this._d.getChannelManager().setupChannelsForNewAgent(agentId);
    } catch (err) {
      await this._rollbackAgentCreation(agentDir, agentId);
      throw err;
    }

 // 初始化并加入长驻 Map
    const ag = this._createAgentInstance(agentId, () => ({}));
    ag.setGetOwnerIds(this._makeOwnerIdsFn(ag));
    const resolveModel = (bareId) =>
      this._d.getModels().resolveModelWithCredentials(bareId);
    try {
      await ag.init(() => {}, this._d.getSharedModels(), resolveModel);
    } catch (err) {
 //
      await this._rollbackAgentCreation(agentDir, agentId);
      throw err;
    }
 // #419: 新建 agent 继承当前已装 user/SDK skill 快照;空快照时保留 template 默认
    const requestedEnabled = Array.isArray(enabledSkills)
      ? [...new Set(enabledSkills.filter(name => typeof name === "string" && name.trim()).map(name => name.trim()))]
      : null;
    const defaultEnabled = requestedEnabled === null
      ? this._d.getSkills().computeDefaultEnabledForNewAgent()
      : [];
    const enabledForAgent = requestedEnabled !== null ? requestedEnabled : defaultEnabled;
    if (requestedEnabled !== null || enabledForAgent.length > 0) {
      try {
        ag.updateConfig({ skills: { enabled: enabledForAgent } });
        this._d.getSkills().syncAgentSkills(ag);
      } catch (err) {
        await this._rollbackAgentCreation(agentDir, agentId);
        throw err;
      }
    }
    this._registerAgent(agentId, ag);

 // 启动 cron + heartbeat
    const hub = this._d.getHub();
    hub?.scheduler?.startAgentCron(agentId);
    const newAgent = this._agents.get(agentId);
    if (newAgent) {
      hub?.scheduler?.startAgentHeartbeat?.(agentId, newAgent);
    }

    // Register DM callbacks.
    const dmRouter = hub?.dmRouter;
    if (dmRouter) {
      ag.setDmSentHandler((fromId, toId) => dmRouter.handleNewDm(fromId, toId));
    }

    this.invalidateAgentListCache();
    log.log(`Agent created: ${name} (${agentId})`);
    return { id: agentId, name: name.trim(), yuan: yuanType };
  }

  // ── Switch ──

  /**
  * */
  async switchAgentOnly(agentId) {
    return this._enqueueSwitch(() => this._doSwitchAgentOnly(agentId));
  }

  /**
 * 完整切换：切 agent 指针、恢复调度、同步 skills、创建 session。
 * 排队执行，快速连续切换会按序落到最终目标。
 */
  async switchAgent(agentId) {
    return this._enqueueSwitch(() => this._doSwitchAgent(agentId));
  }

 /** Promise 链互斥：所有切换操作排队执行，前一个失败不阻塞后续。 */
  _enqueueSwitch(fn) {
    const queued = this._switchQueue.catch(() => {}).then(fn);
    this._switchQueue = queued;
    return queued;
  }

  async _doSwitchAgentOnly(agentId) {
    if (!this._agents.has(agentId)) {
      throw new Error(t("error.agentNotFound", { id: agentId }));
    }
    const prevAgentId = this._activeAgentId;
    log.log(`switching agent to ${agentId}`);
    try {
      clearConfigCache();
      await this.ensureAgentRuntime(agentId, {
        priority: "foreground",
        reason: "switch",
      });
      this._activeAgentId = agentId;

      const chatRef = this.agent.config?.models?.chat;
      const ref = parseModelRef(chatRef);
      const models = this._d.getModels();
      if (ref?.id && ref.provider) {
        const model = findModel(models.availableModels, ref.id, ref.provider);
        if (!model) {
          throw new Error(t("error.agentModelNotAvailable", { id: agentId, model: `${ref.provider}/${ref.id}` }));
        }
        models.defaultModel = model;
      } else if (chatRef) {
        log.warn(`switchAgent(${agentId}): models.chat is missing provider (${JSON.stringify(chatRef)}), keeping previous default model`);
      }
      const effectiveModel = ref?.id || models.defaultModel?.id || "inherited";
      log.log(`agent switched to ${this.agent.agentName} (${agentId}), model=${effectiveModel}`);
    } catch (err) {
      this._activeAgentId = prevAgentId;
      throw err;
    }
  }

  async _doSwitchAgent(agentId) {
    const hub = this._d.getHub();
    await hub?.pauseForAgentSwitch();
    try {
      const engine = this._d.getEngine?.();
      const previousCwd = engine?.cwd || null;
      const homeFolder = engine?.getExplicitHomeCwd?.(agentId) || null;
      await this._doSwitchAgentOnly(agentId);
      this._d.getSkills().syncAgentSkills(this.agent);
      const cwd = homeFolder || previousCwd;
      const session = await this._d.getSessionCoordinator().createSession(null, cwd);
      log.log(`Switched agent: ${this.agent.agentName} (${agentId})`);
      return { ...session, cwd, homeFolder };
    } finally {
      hub?.resumeAfterAgentSwitch();
    }
  }

  async createSessionForAgent(agentId, cwd, memoryEnabled = true, model = null, opts = {}) {
    if (agentId && agentId !== this._activeAgentId) {
      await this.switchAgentOnly(agentId);
    }
    return this._d.getSessionCoordinator().createSession(null, cwd, memoryEnabled, model, opts);
  }

  // ── Delete ──

  async deleteAgent(agentId) {
    if (agentId === this._activeAgentId) {
      throw new Error(t("error.agentDeleteActive"));
    }

    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(agentDir)) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }

    const ag = this._agents.get(agentId);
    if (ag) {
      this._agents.delete(agentId);
      this._activityStores.delete(agentId);
      await this._d.getHub()?.scheduler?.removeAgentCron(agentId);
      await this._d.getHub()?.scheduler?.stopHeartbeat(agentId);
      await ag.dispose();
    }

    // 频道清理
    try {
      await this._d.getChannelManager().cleanupAgentFromChannels(agentId);
    } catch (err) {
      log.error(`Failed to remove agent from channels (${agentId}): ${err.message}`);
    }

    await fsp.rm(agentDir, { recursive: true, force: true });
    if (this._d.codiaHome) {
      try {
        detachAgentFromBundles({ codiaHome: this._d.codiaHome }, agentId);
      } catch (err) {
        log.error(`Failed to detach agent from skill bundles (${agentId}): ${err.message}`);
      }
    }
    this._d.getEngine?.()?.subagentThreads?.removeByAgentId?.(agentId);

    const prefs = this._d.getPrefs();
    const primaryId = prefs.getPrimaryAgent();
    if (primaryId === agentId) {
      prefs.savePrimaryAgent(this._activeAgentId);
    }

    const order = prefs.getPreferences()?.agentOrder || [];
    const newOrder = order.filter(id => id !== agentId);
    if (newOrder.length !== order.length) {
      const p = prefs.getPreferences();
      p.agentOrder = newOrder;
      prefs.savePreferences(p);
    }

    this.invalidateAgentListCache();
    log.log(`deleted agent ${agentId}`);
  }

  // Utility

  setPrimaryAgent(agentId) {
    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(path.join(agentDir, "config.yaml"))) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }
    this._d.getPrefs().savePrimaryAgent(agentId);
  }

  agentIdFromSessionPath(sessionPath) {
    const rel = relativePathInsideBase(sessionPath, this._d.agentsDir);
    if (rel === null) return null;
    return rel.split(path.sep)[0] || null;
  }

  // ── Dispose ──

  async disposeAll(sessionCoord) {
 //
    const entries = sessionCoord ? [...sessionCoord._sessions.entries()] : [];
    if (entries.length > 0) {
      const summaryPromises = entries.map(([sp, entry]) => {
        const agent = this._agents.get(entry.agentId) || this.agent;
        return Promise.race([
          agent?._memoryTicker?.notifySessionEnd(sp) ?? Promise.resolve(),
          new Promise(r => setTimeout(r, 4000)),
        ]);
      });
      await Promise.allSettled(summaryPromises);
    }
    await Promise.allSettled(
      [...this._agents.values()].map(ag => ag.dispose()),
    );
    this._agents.clear();
  }

  // ── Internal ──

  _scanAgentDirs() {
    try {
      return readDirectoryLikeDirentsSync(this._d.agentsDir)
        .filter(e => !this.isAgentDeleted(e.name)
          && fs.existsSync(path.join(this._d.agentsDir, e.name, "config.yaml")));
    } catch { return []; }
  }

 /** */
  _makeOwnerIdsFn(ag) {
    return () => {
      const bridgeCfg = ag.config?.bridge || {};
      const ids = {};
      for (const [plat, cfg] of Object.entries(bridgeCfg)) {
        if (plat === 'readOnly' || plat === 'receiptEnabled') continue;
        if (typeof cfg === 'object' && cfg?.owner) ids[plat] = cfg.owner;
      }
      return ids;
    };
  }

  _registerAgent(agentId, ag) {
    if (!ag) {
      throw new Error(`agent instance is required for "${agentId}"`);
    }
    if (!ag.id) {
      ag.id = agentId;
    }
    if (ag.id !== agentId) {
      throw new Error(`agent id mismatch: map key "${agentId}" vs instance.id "${ag.id}"`);
    }
    this._agents.set(agentId, ag);
  }

  _createAgentInstance(agentId, getOwnerIds) {
    const ag = new Agent({
      id: agentId,
      agentsDir: this._d.agentsDir,
      productDir: this._d.productDir,
      userDir: this._d.userDir,
      channelsDir: this._d.channelsDir,
      searchConfigResolver: () => this._d.getSearchConfig(),
    });
    ag.setGetOwnerIds(getOwnerIds);
 // 回调注入：Agent 通过 _cb 访问 Engine 能力，不直接持有 Engine 引用
    const getEngine = () => this._d.getEngine?.();
    ag.setCallbacks({
      emitDevLog:           (text, level) => getEngine()?.emitDevLog?.(text, level),
      getConfirmStore:      () => getEngine()?.confirmStore ?? null,
      getCurrentSessionPath:() => getEngine()?.currentSessionPath ?? null,
      getSessionPermissionMode: (sp) => getEngine()?.getSessionPermissionMode?.(sp) ?? null,
      getSessionCwd:        (sp) => getEngine()?.getSessionCwd?.(sp) ?? null,
      getSessionWorkspaceFolders: (sp) => getEngine()?.getSessionWorkspaceFolders?.(sp) ?? [],
      getHomeCwd:           (agentId) => getEngine()?.getHomeCwd?.(agentId) ?? null,
      getStudioCronStore:   () => getEngine()?.getStudioCronStore?.() ?? null,
      emitEvent:            (event, sp) => getEngine()?._emitEvent?.(event, sp),
      emitSessionEvent:     (event) => getEngine()?.emitSessionEvent?.(event),
      getDeferredResults:   () => getEngine()?.deferredResults ?? null,
      getSubagentRunStore:  () => getEngine()?.subagentRuns ?? null,
      getSubagentThreadStore: () => getEngine()?.subagentThreads ?? null,
      getActivityHub:       () => getEngine()?.activityHub ?? null,
      getTaskRegistry:      () => getEngine()?.taskRegistry ?? null,
      getTerminalSessionManager: () => getEngine()?.terminalSessions ?? null,
      registerSessionFile:  (entry) => getEngine()?.registerSessionFile?.(entry),
      setSubagentController: (id, ctrl) => getEngine()?.setSubagentController(id, ctrl),
      removeSubagentController: (id) => getEngine()?.removeSubagentController(id),
      executeIsolated:      (prompt, opts) => getEngine()?.executeIsolated(prompt, opts),
      getCurrentModelId:    () => getEngine()?.currentModel?.id ?? null,
      getSkillsDir:         () => getEngine()?.skillsDir ?? null,
      getLearnSkills:       () => getEngine()?.getLearnSkills?.() ?? {},
      isChannelsEnabled:    () => getEngine()?.isChannelsEnabled?.() ?? false,
      createChannelEntry:   (opts) => getEngine()?.createChannelEntry?.(opts),
      resolveUtilityConfig: () => getEngine()?.resolveUtilityConfig?.({ agentId: ag.id }),
      getCwd:               () => getEngine()?.cwd ?? "",
      getLocale:            () => getEngine()?.getLocale?.() ?? "zh-CN",
      getTimezone:          () => getEngine()?.getTimezone?.() ?? "",
      listActiveAgents:     () => this.listActiveAgentsForRoster(),
      scheduleMemoryMaintenance: (agentId, reason) =>
        this.scheduleAgentMemoryMaintenance(agentId, reason, ag),
      getEngine,  // update-settings-tool 仍需要完整 engine
    });
    ag.setOnInstallCallback(async (skillName) => {
      const skills = this._d.getSkills();
      await skills.reload(this._d.getResourceLoader?.(), this._agents);
      const enabled = new Set(ag.config?.skills?.enabled || []);
      enabled.add(skillName);
      ag.updateConfig({ skills: { enabled: [...enabled] } });
      skills.syncAgentSkills(ag);
    });
    ag.setNotifyHandler((payload) => {
      const engine = this._d.getEngine?.();
      if (typeof engine?.deliverNotification === "function") {
        return engine.deliverNotification(payload, { agentId: ag.id });
      }
      this._d.getHub()?.eventBus?.emit({
        type: "notification",
        title: payload?.title || "",
        body: payload?.body || "",
        agentId: ag.id,
      }, null);
      return undefined;
    });
    ag.setDescriptionRefreshHandler(() => {
      this._refreshDescription(ag.id).catch(() => {});
    });
    return ag;
  }

  async _generateAgentId(name) {
    let utilConfig;
    try {
      utilConfig = this._d.resolveUtilityConfig();
    } catch {
 // utility 模型未配置（新用户常见），直接走兜底 ID
      return `agent-${Date.now().toString(36)}`;
    }
    return _generateAgentId(utilConfig, name, this._d.agentsDir);
  }
}
