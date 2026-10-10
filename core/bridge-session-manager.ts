// @ts-nocheck
/**
 * Manages bridge sessions for external social platforms.
 *
 * The engine delegates bridge session indexing, external message execution,
 * and message injection here.
 */
import fs from "fs";
import path from "path";
import { createAgentSession, SessionManager } from "../lib/pi-sdk/index.ts";
import { createDefaultSettings } from "./session-defaults.ts";
import { debugLog } from "../lib/debug-log.ts";
import { t, getLocale } from "../lib/i18n.ts";
import { safeReadJSON } from "../shared/safe-fs.ts";
import { findModel } from "../shared/model-ref.ts";
import { uniqueToolNames } from "../shared/tool-categories.ts";
import { teardownSessionResources } from "./session-teardown.ts";
import { repairRestoredToolSnapshot } from "./tool-snapshot-repair.ts";
import { repairOrphanToolResultEntriesInFile } from "./session-health.ts";
import {
  pruneSessionInlineMediaHistory,
  repairSessionInlineMediaEntriesInFile,
} from "./session-inline-media-prune.ts";
import { isAbortLikeError, prepareVisionInputForTextOnlyModel } from "./vision-prepare.ts";
import { prepareModelImageInputsForPrompt } from "./model-image-preprocess.ts";
import { withVisionContextInjectionExtension } from "./vision-context-injector.ts";
import {
  SESSION_PERMISSION_MODES,
  normalizeBridgePermissionMode,
} from "./session-permission-mode.ts";
import { collectMediaItems } from "../lib/tools/media-details.ts";
import { formatSettingsUpdateText } from "../lib/tools/settings-update-result.ts";
import { materializeBridgeInboundFiles } from "../lib/session-files/bridge-inbound-files.ts";
import {
  modelSupportsAudioInput,
  modelSupportsDirectAudioInput,
  modelSupportsVideoInput,
} from "../shared/model-capabilities.ts";
import {
  appendBridgePromptLine,
  bridgeContextIndexMeta,
  buildBridgeContext,
} from "../lib/bridge/bridge-context.ts";
import { executeWukongAgentRuntimeTask, isWukongRuntimeAgent } from "../lib/wukong/runtime-adapter.ts";
import {
  buildFreshCompactMetaPatch,
  buildFreshCompactSnapshot,
  shouldRunFreshCompact,
} from "../lib/fresh-compact/policy.ts";

const BRIDGE_OWNER_DENIED_TOOL_NAMES = Object.freeze([
  "computer",
  "browser",
  "codia_card_guide",
  "show_card",
]);

function computeBridgeOwnerActiveToolNames(allToolNames) {
  const denied = new Set(BRIDGE_OWNER_DENIED_TOOL_NAMES);
  return uniqueToolNames(allToolNames).filter((name) => !denied.has(name));
}

function filterBridgeOwnerToolObjects(tools) {
  const denied = new Set(BRIDGE_OWNER_DENIED_TOOL_NAMES);
  return (tools || []).filter((tool) => tool?.name && !denied.has(tool.name));
}

function assertVideoInputSupported(model, videos) {
  if (!videos?.length) return;
  if (!modelSupportsVideoInput(model)) {
    throw new Error("current model does not support video input");
  }
}

function assertAudioInputSupported(model, audios) {
  if (!audios?.length) return;
  if (!modelSupportsAudioInput(model)) {
    throw new Error("current model does not support audio input");
  }
  if (!modelSupportsDirectAudioInput(model)) {
    throw new Error("current provider does not support direct audio input");
  }
}

function buildPromptMediaOptions(opts) {
  const media = [
    ...(opts?.images || []),
    ...(opts?.videos || []),
    ...(opts?.audios || []),
  ];
  if (!media.length) return undefined;
  return {
    images: media,
    ...(opts.imageAttachmentPaths?.length ? { imageAttachmentPaths: opts.imageAttachmentPaths } : {}),
    ...(opts.videoAttachmentPaths?.length ? { videoAttachmentPaths: opts.videoAttachmentPaths } : {}),
    ...(opts.audioAttachmentPaths?.length ? { audioAttachmentPaths: opts.audioAttachmentPaths } : {}),
  };
}

function recordBridgeAssistantUsage({ ledger, event, sessionPath, agent, model, bridgeContext }) {
  if (!ledger || event?.type !== "message_end" || event.message?.role !== "assistant") return null;
  const conversationType = bridgeContext?.chatType === "channel" ? "channel" : "dm";
  const conversationId = bridgeContext?.sessionKey || bridgeContext?.chatId || sessionPath || "unknown";
  const usageContext = bridgeContext?.isBridgeSession
    ? {
        source: {
          subsystem: "phone",
          operation: "reply",
          surface: conversationType,
          trigger: "user",
        },
        attribution: {
          kind: "phone_conversation",
          agentId: agent?.id || bridgeContext?.agentId || null,
          conversationId,
          conversationType,
          sessionPath,
        },
      }
    : {
        source: {
          subsystem: "session",
          operation: "reply",
          surface: "bridge",
          trigger: "user",
        },
        attribution: {
          kind: "session",
          agentId: agent?.id || null,
          sessionPath,
        },
      };
  const modelMeta = {
    provider: model?.provider ?? null,
    modelId: model?.id ?? null,
    api: model?.api ?? null,
  };
  if (event.message?.usage) {
    return ledger.record({
      model: modelMeta,
      usage: event.message.usage,
      usageContext,
      costRates: model?.cost,
    });
  }
  const errorMessage = event.message?.errorMessage || event.message?.error?.message || null;
  if (event.message?.stopReason === "error" || errorMessage) {
    const request = ledger.start({
      model: modelMeta,
      usageContext,
      costRates: model?.cost,
    });
    return ledger.recordError(request.requestId, new Error(errorMessage || "provider request failed"));
  }
  return null;
}

function withVisionExtension(resourceLoader, getBridge, getSessionPath, isEnabled, warn, resolveSessionFile, getTargetModel) {
  return withVisionContextInjectionExtension(resourceLoader, {
    path: "codia-vision-context-injection",
    sessionPathRef: () => getSessionPath?.() || null,
    targetModelRef: () => getTargetModel?.() || null,
    getVisionBridge: getBridge,
    isVisionAuxiliaryEnabled: () => isEnabled?.() === true,
    resolveSessionFile,
    warn,
  });
}

function normalizeFreshCompactNoopReason(reason) {
  const value = String(reason || "").trim();
  if (value === "already_compacted" || value === "nothing_to_compact") return value;
  return null;
}

function getFreshCompactNoopReason(error) {
  const message = error?.message || String(error || "");
  if (message.includes("Already compacted")) return "already_compacted";
  if (message.includes("Nothing to compact")) return "nothing_to_compact";
  return null;
}

function readLastJsonlEntry(filePath) {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
  return null;
}

export class BridgeSessionManager {
  /**
   * @param {object} deps
   * @param {() => object} deps.getAgent
   * @param {(id: string) => object|null} deps.getAgentById
   * @param {() => import('./model-manager.ts').ModelManager} deps.getModelManager
   * @param {() => object} deps.getResourceLoader
   * @param {() => object} deps.getPreferences
    *
   * @param {() => string} deps.getHomeCwd
   */
  constructor(deps) {
    this._deps = deps;
    this._activeSessions = new Map();
    this._activeSessionRoles = new Map();
    this._sessionPathBridgeContexts = new Map();
  }

  /** Active bridge sessions used by bridge-manager abort flow. */
  get activeSessions() { return this._activeSessions; }

  _repairOrphanToolHistory(sessionPath, label) {
    try {
      const { repaired, removed } = repairOrphanToolResultEntriesInFile(sessionPath);
      if (repaired) {
        console.warn(`[bridge-session] ${label}: cleaned ${removed} orphan toolResult entries in ${path.basename(sessionPath)}`);
      }
    } catch (err) {
      console.warn(`[bridge-session] ${label}: orphan tool history repair failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  _repairInlineMediaHistory(sessionPath, label) {
    try {
      const result = repairSessionInlineMediaEntriesInFile(sessionPath);
      if (result.repaired) {
        console.warn(
          `[bridge-session] ${label}: cleaned ${result.stripped} inline media blocks in ${path.basename(sessionPath)} `
          + `(image=${result.strippedImages}, video=${result.strippedVideos}, audio=${result.strippedAudios})`,
        );
      }
    } catch (err) {
      console.warn(`[bridge-session] ${label}: inline media repair failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  /** Whether a bridge session is currently streaming. */
  isSessionStreaming(sessionKey, opts = {}) {
    const session = this._activeSessions.get(sessionKey);
    if (!session) return false;
    if (opts.role && this._activeSessionRoles.get(sessionKey) !== opts.role) return false;
    return session.__bridgeLifecycleActive === true || session.isStreaming === true;
  }

  /** Abort a bridge session if it is currently streaming. */
  async abortSession(sessionKey) {
    const session = this._activeSessions.get(sessionKey);
    if (!session || !this.isSessionStreaming(sessionKey)) return false;
    this._activeSessions.delete(sessionKey);
    this._activeSessionRoles.delete(sessionKey);
    try { session.__bridgeAbortController?.abort?.(); } catch {}
    try {
      const abortPromise = session.abort?.();
      Promise.resolve(abortPromise).catch((err) =>
        console.warn(`[bridge-session] abortSession[${sessionKey}]: abort failed: ${err.message}`),
      );
    } catch (err) {
      console.warn(`[bridge-session] abortSession[${sessionKey}]: abort failed: ${err.message}`);
    }
    try {
      session.dispose?.();
    } catch (err) {
      console.warn(`[bridge-session] abortSession[${sessionKey}]: session.dispose failed: ${err.message}`);
    }
    return true;
  }

  /** Path to the bridge session index file. */
  _indexPath(agent) {
    const a = agent || this._deps.getAgent();
    return path.join(a.sessionDir, "bridge", "bridge-sessions.json");
  }

  _resolveAgent(opts = {}, operation = "operation") {
    if (opts.agentId) {
      const agent = this._deps.getAgentById?.(opts.agentId) || null;
      if (agent) return agent;
      const focus = this._deps.getAgent?.() || null;
      if (focus?.id === opts.agentId) return focus;
      throw new Error(`bridge ${operation}: agent "${opts.agentId}" not found`);
    }
    const agent = this._deps.getAgent?.() || null;
    if (!agent) throw new Error(`bridge ${operation}: focus agent not available`);
    return agent;
  }

  _listAgentsForReconcile() {
    const all = this._deps.getAgents?.();
    if (all instanceof Map) return [...all.values()].filter(Boolean);
    if (Array.isArray(all)) return all.filter(Boolean);
    const focus = this._deps.getAgent?.();
    return focus ? [focus] : [];
  }

  /**
   * Startup sanity check: scan bridge-index and remove orphan file refs.
   */
  reconcile() {
    let totalCleaned = 0;

    for (const agent of this._listAgentsForReconcile()) {
      const index = this.readIndex(agent);
      const bridgeDir = path.join(agent.sessionDir, "bridge");
      let cleaned = 0;

      for (const [sessionKey, raw] of Object.entries(index)) {
        const entry = typeof raw === "string" ? { file: raw } : raw;
        if (!entry.file) continue;
        const fp = path.join(bridgeDir, entry.file);
        if (!fs.existsSync(fp)) {
          // Keep metadata such as name/avatarUrl/userId; only remove the file ref.
          delete entry.file;
          index[sessionKey] = entry;
          cleaned++;
        }
      }

      if (cleaned > 0) {
        this.writeIndex(index, agent);
        totalCleaned += cleaned;
        debugLog()?.log("bridge", `reconcile: cleaned ${cleaned} orphan session refs for ${agent.id || "unknown"}`);
      }
    }

    if (totalCleaned > 0) {
      console.log(`[bridge-session] reconcile: cleaned ${totalCleaned} orphan session ref(s)`);
    }
  }

  /** Read bridge session index. */
  readIndex(agent) {
    return safeReadJSON(this._indexPath(agent), {});
  }

  /** Write bridge session index. */
  writeIndex(index, agent) {
    const dir = path.dirname(this._indexPath(agent));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._indexPath(agent), JSON.stringify(index, null, 2) + "\n", "utf-8");
  }

  _normalizeIndexEntry(raw) {
    if (!raw) return {};
    return typeof raw === "string" ? { file: raw } : { ...raw };
  }

  _normalizeToolNames(value) {
    return uniqueToolNames(Array.isArray(value) ? value : []);
  }

  _serializeIndexEntry(previousRaw, entry) {
    if (typeof previousRaw === "string" && Object.keys(entry).length === 1 && typeof entry.file === "string") {
      return entry.file;
    }
    return entry;
  }

  _relativeBridgeFile(bridgeDir, sessionPath) {
    const relative = path.relative(bridgeDir, sessionPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`bridge session path escapes bridge dir: ${sessionPath}`);
    }
    return relative.split(path.sep).join("/");
  }

  _syncIndexEntry(index, sessionKey, previousRaw, { bridgeDir, sessionPath, meta }) {
    const entry = this._normalizeIndexEntry(previousRaw);
    try {
      entry.file = this._relativeBridgeFile(bridgeDir, sessionPath);
    } catch (err) {
      console.warn(`[bridge-session] skip unsafe index update for ${sessionKey}: ${err.message}`);
      return { changed: false, file: null };
    }
    if (meta) Object.assign(entry, meta);
    const nextValue = this._serializeIndexEntry(previousRaw, entry);
    if (JSON.stringify(previousRaw ?? null) === JSON.stringify(nextValue)) return { changed: false, file: entry.file };
    index[sessionKey] = nextValue;
    return { changed: true, file: entry.file };
  }

  _buildBridgeContext(sessionKey, meta = {}, opts = {}, agent = null) {
    return buildBridgeContext({
      ...(meta || {}),
      sessionKey,
      role: opts.guest === true ? "guest" : "owner",
      agentId: agent?.id || opts.agentId || null,
    }, getLocale());
  }

  _bridgeContextMeta(context, meta = {}) {
    return bridgeContextIndexMeta(context, meta || {});
  }

  _writeIndexEntryPatch(agent, sessionKey, patch) {
    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const entry = this._normalizeIndexEntry(raw);
    if (!entry.file) return false;
    Object.assign(entry, patch);
    index[sessionKey] = this._serializeIndexEntry(raw, entry);
    this.writeIndex(index, agent);
    return true;
  }

  _rememberBridgeContext(sessionPath, context) {
    if (!sessionPath || context?.isBridgeSession !== true) return;
    const raw = { ...context };
    delete raw.platformLabel;
    delete raw.notificationHint;
    this._sessionPathBridgeContexts.set(path.resolve(sessionPath), raw);
  }

  getBridgeContextForSessionPath(sessionPath, opts = {}) {
    if (!sessionPath) return null;
    const resolved = path.resolve(sessionPath);
    const cached = this._sessionPathBridgeContexts.get(resolved);
    if (cached) return buildBridgeContext(cached, getLocale());

    const agents = opts.agentId
      ? [this._resolveAgent(opts, "getBridgeContextForSessionPath")]
      : this._listAgentsForReconcile();
    for (const agent of agents) {
      const index = this.readIndex(agent);
      const bridgeDir = path.join(agent.sessionDir, "bridge");
      for (const [sessionKey, raw] of Object.entries(index)) {
        const entry = this._normalizeIndexEntry(raw);
        if (!entry.file) continue;
        const entryPath = path.resolve(bridgeDir, entry.file);
        if (entryPath !== resolved) continue;
        const fileRoot = String(entry.file).split(/[\\/]/)[0];
        return buildBridgeContext({
          ...entry,
          role: entry.role || (fileRoot === "guests" ? "guest" : "owner"),
          sessionKey,
          agentId: agent.id,
        }, getLocale());
      }
    }
    return null;
  }

  _buildOwnerFreshCompactContext(agent, homeCwd) {
    const prefs = this._deps.getPreferences();
    const systemPrompt = agent.buildSystemPrompt({
      cwdOverride: homeCwd,
      forceMemoryEnabled: agent.memoryMasterEnabled !== false,
      ...(typeof agent.experienceEnabled === "boolean"
        ? { forceExperienceEnabled: agent.experienceEnabled === true }
        : {}),
    });
    const state = {
      bridgeReadOnly: normalizeBridgePermissionMode(prefs?.bridge || {}) === SESSION_PERMISSION_MODES.READ_ONLY,
      bridgePermissionMode: normalizeBridgePermissionMode(prefs?.bridge || {}),
      experienceEnabled: agent.experienceEnabled === true,
      memoryMasterEnabled: agent.memoryMasterEnabled !== false,
      model: agent.config?.models?.chat || null,
      thinkingLevel: prefs?.thinking_level || "auto",
    };
    return {
      systemPrompt,
      snapshot: buildFreshCompactSnapshot({ systemPrompt, state }),
    };
  }

  _writeFreshCompactIndexMeta(agent, sessionKey, patch) {
    return this._writeIndexEntryPatch(agent, sessionKey, { freshCompact: patch });
  }

  _resolveBridgeSessionEntry(agent, sessionKey, operation) {
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const entry = this._normalizeIndexEntry(raw);
    const existingFile = entry.file || null;
    if (!existingFile) {
      throw new Error(`bridge ${operation}: session "${sessionKey}" not found or has no history`);
    }
    const sessionFilePath = path.join(bridgeDir, existingFile);
    if (!fs.existsSync(sessionFilePath)) {
      throw new Error(`bridge ${operation}: session file missing on disk: ${sessionFilePath}`);
    }
    return { bridgeDir, index, raw, entry, sessionFilePath };
  }

  isFreshCompactAlreadySatisfied(sessionKey, opts = {}) {
    const agent = this._resolveAgent(opts, "fresh compact inspect");
    const sessionPath = opts.sessionPath
      || this._resolveBridgeSessionEntry(agent, sessionKey, "fresh compact inspect").sessionFilePath;
    const lastEntry = readLastJsonlEntry(sessionPath);
    if (lastEntry?.type === "compaction") {
      return { satisfied: true, reason: "already_compacted" };
    }
    return { satisfied: false, reason: null };
  }

  async markFreshCompactSatisfied(sessionKey, opts = {}) {
    const agent = this._resolveAgent(opts, "fresh compact mark");
    this._resolveBridgeSessionEntry(agent, sessionKey, "fresh compact mark");
    const noopReason = normalizeFreshCompactNoopReason(opts.noopReason);
    const before = typeof opts.tokensBefore === "number" ? opts.tokensBefore : null;
    const after = typeof opts.tokensAfter === "number" ? opts.tokensAfter : (before ?? null);
    const contextWindow = typeof opts.contextWindow === "number" ? opts.contextWindow : null;
    const homeCwd = this._deps.getHomeCwd(agent.id) || process.cwd();
    const freshContext = this._buildOwnerFreshCompactContext(agent, homeCwd);
    const patch = buildFreshCompactMetaPatch({
      snapshot: freshContext.snapshot,
      reason: opts.reason || "daily",
      now: opts.now || new Date(),
      usage: { tokensBefore: before, tokensAfter: after, contextWindow },
    });
    this._writeIndexEntryPatch(agent, sessionKey, {
      freshCompact: patch,
      promptSnapshot: { version: 1, systemPrompt: freshContext.systemPrompt },
    });
    return {
      tokensBefore: before,
      tokensAfter: after,
      contextWindow,
      fresh: true,
      reason: opts.reason || "daily",
      noop: !!noopReason,
      noopReason,
    };
  }

  listDailyFreshCompactTargets(agent, { now = new Date() } = {}) {
    const index = this.readIndex(agent);
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const targets = [];
    for (const [sessionKey, raw] of Object.entries(index)) {
      const entry = this._normalizeIndexEntry(raw);
      if (!entry.file) continue;
      const root = String(entry.file).split(/[\\/]/)[0];
      if (root !== "owner") continue;
      const sessionPath = path.join(bridgeDir, entry.file);
      if (!fs.existsSync(sessionPath)) continue;
      if (this.isSessionStreaming(sessionKey)) continue;
      const decision = shouldRunFreshCompact({ meta: entry, now });
      if (decision.run) {
        targets.push({ sessionKey, sessionPath, reason: decision.reason || "daily" });
      }
    }
    return targets;
  }

  _resolveBridgeChatModel(agent, mm) {
    const chatRef = agent.config?.models?.chat;

    if (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) {
      const model = findModel(mm.availableModels, chatRef.id, chatRef.provider);
      if (!model) {
        throw new Error(t("error.bridgeAgentModelNotAvailable", {
          name: agent.agentName,
          model: `${chatRef.provider}/${chatRef.id}`,
        }));
      }
      return model;
    }

    try {
      const model = mm.resolveExecutionModel(chatRef);
      if (model) return model;
    } catch {
      throw new Error(t("error.bridgeAgentModelNotAvailable", {
        name: agent.agentName,
        model: String(chatRef || ""),
      }));
    }

    throw new Error(t("error.bridgeAgentNoChatModel", { name: agent.agentName }));
  }

  /**
   * Execute an external-platform message in a persistent bridge session.
   * @param {string} prompt - Formatted user message.
   * @param {string} sessionKey - Conversation identifier, for example tg_dm_12345.
   * @param {object} [meta] - Metadata such as name/avatarUrl/userId.
    *
   * @returns {Promise<string|null|object>}
   */
  async executeExternalMessage(prompt, sessionKey, meta, opts = {}) {
    let promptText = prompt;
    let agent;
    try {
      agent = this._resolveAgent(opts, "executeExternalMessage");
    } catch (err) {
      return { __bridgeError: true, message: err.message };
    }
    const bridgeContext = this._buildBridgeContext(sessionKey, meta, opts, agent);
    if (opts.forceLocalRuntime !== true && opts.guest !== true && isWukongRuntimeAgent(agent)) {
      try {
        const result = await executeWukongAgentRuntimeTask({
          agent,
          engine: this._deps,
          text: promptText,
          source: {
            subsystem: "bridge",
            surface: bridgeContext?.platform || meta?.platform || "bridge",
          },
          conversation: {
            sessionKey,
            platform: bridgeContext?.platform || meta?.platform || null,
            chatType: bridgeContext?.chatType || null,
            userId: meta?.userId || bridgeContext?.userId || null,
            chatId: meta?.chatId || bridgeContext?.chatId || null,
          },
          metadata: {
            senderName: meta?.senderName || meta?.name || null,
            contextTag: opts.contextTag || null,
          },
          attachments: [
            ...(opts.inboundFiles || []),
            ...(opts.images || []),
            ...(opts.videos || []),
            ...(opts.audios || []),
          ],
        });
        if (result) return result;
      } catch (err) {
        console.error(`[bridge-session] Wukong runtime failed (${sessionKey}):`, err.message);
        return { __bridgeError: true, message: err.message, runtime: "wukong" };
      }
    }
    const mm = this._deps.getModelManager();
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const subDir = opts.guest ? "guests" : "owner";
    const sessionDir = path.join(bridgeDir, subDir);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Support both the legacy string index value and the new object value.
    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const entry = this._normalizeIndexEntry(raw);
    const entryRoot = String(entry.file || "").split(/[\\/]/)[0];
    const existingFile = entryRoot === subDir ? entry.file : null;
    const existingPath = existingFile ? path.join(bridgeDir, existingFile) : null;
    const persistedPromptSnapshot = existingFile ? entry.promptSnapshot : null;

    try {
      let mgr;
      let reopenError = null;
      if (existingPath) {
        this._repairOrphanToolHistory(existingPath, "restore");
        this._repairInlineMediaHistory(existingPath, "restore");
        try {
          mgr = SessionManager.open(existingPath, sessionDir);
        } catch (err) {
          reopenError = err;
          mgr = null;
          console.warn(`[bridge-session] existing session open failed (${sessionKey}): ${err.message}; creating a new session and rebinding index`);
          debugLog()?.log("bridge-session", `open failed for ${sessionKey}: ${err.message}`);
        }
      }
      const homeCwd = this._deps.getHomeCwd(agent.id) || process.cwd();
      if (!mgr) {
        mgr = SessionManager.create(homeCwd, sessionDir);
      }

      let sessionOpts;
      const sessionPathRef = { current: null };
      const toolMediaUrls = [];
      // Collect tool details.media from tool_execution_end events.

      if (opts.guest) {
        // Guest mode: yuan + public-ishiki + contextTag, no tools.
        const yuanBase = agent.yuanPrompt;
        const pubIshiki = agent.publicIshiki;
        const bridgePromptLine = appendBridgePromptLine("", bridgeContext, getLocale()).trim();
        const parts = [yuanBase, pubIshiki, opts.contextTag, bridgePromptLine].filter(Boolean);
        const guestPrompt = persistedPromptSnapshot?.systemPrompt || parts.join("\n\n");
        const tempResourceLoader = Object.create(this._deps.getResourceLoader());
        tempResourceLoader.getSystemPrompt = () => guestPrompt;
        tempResourceLoader.getSkills = () => ({ skills: [], diagnostics: [] });
        const guestResourceLoader = withVisionExtension(
          tempResourceLoader,
          () => this._deps.getVisionBridge?.(),
          () => sessionPathRef.current,
          () => this._deps.isVisionAuxiliaryEnabled?.() === true,
          (msg) => console.warn(`[bridge-session] ${msg}`),
          ({ fileId, filePath, sessionPath }) => {
            const lookupSessionPath = sessionPath || sessionPathRef.current || null;
            if (fileId) return this._deps.getSessionFile?.(fileId, { sessionPath: lookupSessionPath });
            if (filePath) return this._deps.getSessionFileByPath?.(filePath, { sessionPath: lookupSessionPath });
            return null;
          },
          () => chatModel,
        );

        // Use the agent model instead of the global default model.
        const chatModel = this._resolveBridgeChatModel(agent, mm);

        sessionOpts = {
          model: chatModel,
          thinkingLevel: "off",
          resourceLoader: guestResourceLoader,
          tools: [],
          customTools: [],
          settingsManager: this._createSettings(chatModel),
        };
      } else {
        // Owner mode uses the full agent toolset. Keep this path shared with compaction.
        sessionOpts = this._buildOwnerSessionOpts(agent, mm, homeCwd, sessionPathRef, {
          bridgeContext,
          toolNames: entry.toolNames,
          ownerPromptSnapshot: persistedPromptSnapshot?.systemPrompt,
        });
      }
      const activeToolNames = this._normalizeToolNames(sessionOpts.activeToolNames);
      delete sessionOpts.activeToolNames;

      const { session } = await createAgentSession({
        cwd: homeCwd,
        sessionManager: mgr,
        modelRuntime: mm.modelRuntime,
        ...sessionOpts,
      });

      const activeSessionPath = session.sessionManager?.getSessionFile?.() || null;
      sessionPathRef.current = activeSessionPath;
      if (activeToolNames.length) {
        session.setActiveToolsByName?.(activeToolNames);
      }
      this._rememberBridgeContext(activeSessionPath, bridgeContext);
      const lifecycleAbort = new AbortController();
      session.__bridgeAbortController = lifecycleAbort;
      session.__bridgeLifecycleActive = true;
      this._activeSessions.set(sessionKey, session);
      this._activeSessionRoles.set(sessionKey, opts.guest === true ? "guest" : "owner");

      this._deps.emitEvent?.({ type: "session_status", isStreaming: true }, activeSessionPath);
      const displayMessage = opts.displayMessage || { text: promptText, source: "bridge" };
      this._deps.emitEvent?.({
        type: "session_user_message",
        message: {
          ...displayMessage,
          text: displayMessage.text ?? promptText,
          source: displayMessage.source || "bridge",
          bridgeSessionKey: sessionKey,
        },
      }, activeSessionPath);

      if (opts.inboundFiles?.length && !activeSessionPath) {
        throw new Error("bridge inbound files require a resolved sessionPath");
      }
      if (opts.inboundFiles?.length && activeSessionPath) {
        const materialized = await materializeBridgeInboundFiles({
          codiaHome: this._deps.getCodiaHome?.() || this._deps.getCodiaHome?.(),
          sessionPath: activeSessionPath,
          files: opts.inboundFiles,
          registerSessionFile: this._deps.registerSessionFile,
        });
        if (materialized.imageAttachmentPaths.length) {
          promptText = addAttachedImageMarkers(promptText, materialized.imageAttachmentPaths);
          opts = {
            ...opts,
            imageAttachmentPaths: [
              ...(opts.imageAttachmentPaths || []),
              ...materialized.imageAttachmentPaths,
            ],
          };
        }
      }

      // Capture streamed text output.
      let capturedText = "";
      let providerError = null;
      const unsub = session.subscribe((event) => {
        recordBridgeAssistantUsage({
          ledger: this._deps.getUsageLedger?.(),
          event,
          sessionPath: activeSessionPath,
          agent,
          model: session.model,
          bridgeContext,
        });
        this._deps.emitEvent?.(event, activeSessionPath);
        if (event.type === "message_end" && event.message?.stopReason === "error") {
          providerError = event.message?.errorMessage || event.message?.error?.message || "provider request failed";
        }
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            const delta = sub.delta || "";
            capturedText += delta;
            try { opts.onDelta?.(delta, capturedText); } catch {}
          }
        } else if (event.type === "tool_execution_end" && !event.isError) {
          toolMediaUrls.push(...collectMediaItems(event.result?.details?.media));
          const card = event.result?.details?.card;
          if (card?.description) {
            capturedText += (capturedText ? "\n\n" : "") + card.description;
          }
          const settingsUpdateText = formatSettingsUpdateText(event.result?.details?.settingsUpdate);
          if (settingsUpdateText) {
            capturedText += (capturedText ? "\n\n" : "") + settingsUpdateText;
          }
        }
      });

      try {
        ({ text: promptText, opts } = await prepareVisionInputForTextOnlyModel({
          targetModel: session.model,
          text: promptText,
          opts,
          sessionPath: activeSessionPath,
          getVisionBridge: () => this._deps.getVisionBridge?.(),
          visionPolicyTarget: { isVisionAuxiliaryEnabled: this._deps.isVisionAuxiliaryEnabled },
          warn: (msg) => console.warn(`[bridge-session] ${msg}`),
          signal: lifecycleAbort.signal,
        }));
        ({ text: promptText, opts } = await prepareModelImageInputsForPrompt({
          text: promptText,
          opts,
        }));
        assertVideoInputSupported(session.model, opts?.videos);
        assertAudioInputSupported(session.model, opts?.audios);
        const promptOpts = buildPromptMediaOptions(opts);
        const nativeMediaTurn = this._deps.beginCurrentTurnNativeMedia?.(activeSessionPath, opts);
        try {
          await session.prompt(promptText, promptOpts);
          if (providerError) throw new Error(providerError);
        } finally {
          this._deps.endCurrentTurnNativeMedia?.(nativeMediaTurn);
        }
      } finally {
        session.__bridgeLifecycleActive = false;
        this._deps.emitEvent?.({ type: "session_status", isStreaming: false }, activeSessionPath);
        try {
          pruneSessionInlineMediaHistory(session);
        } catch (err) {
          console.warn(`[bridge-session] inline media prune failed (${sessionKey}): ${err?.message || err}`);
        }
        await teardownSessionResources({
          session,
          unsub,
          label: `bridge.executeExternalMessage[${sessionKey}]`,
          warn: (msg) => console.warn(`[bridge-session] ${msg}`),
        });
        this._activeSessions.delete(sessionKey);
        this._activeSessionRoles.delete(sessionKey);
      }

      const sessionPath = activeSessionPath || session.sessionManager?.getSessionFile?.();
      // Update index and metadata.
      if (sessionPath) {
        const indexMeta = this._bridgeContextMeta(bridgeContext, meta);
        indexMeta.promptSnapshot = {
          version: 1,
          systemPrompt: sessionOpts.resourceLoader?.getSystemPrompt?.() || "",
        };
        if (opts.guest !== true && activeToolNames.length) {
          indexMeta.toolNames = activeToolNames;
        }
        const { changed, file } = this._syncIndexEntry(index, sessionKey, raw, {
          bridgeDir,
          sessionPath,
          meta: indexMeta,
        });
        if (changed) {
          if (existingFile && existingFile !== file) {
            debugLog()?.log("bridge-session", `rebound ${sessionKey}: ${existingFile} -> ${file}`);
            if (reopenError) {
              console.log(`[bridge-session] ${sessionKey} self-healed: ${existingFile} -> ${file}`);
            }
          }
          this.writeIndex(index, agent);
        }
      }
      if (opts.guest !== true && sessionPath) {
        try {
          agent.memoryTicker?.notifyTurn?.(sessionPath);
        } catch (err) {
          console.warn(`[bridge-session] bridge memory notifyTurn failed (${sessionKey}): ${err?.message || err}`);
        }
      }

      const text = capturedText.trim() || null;
      if (toolMediaUrls.length) {
        debugLog()?.log("bridge-session", `tool media -> ${toolMediaUrls.length} url(s) via details.media`);
        return { text, toolMedia: toolMediaUrls };
      }
      return text;
    } catch (err) {
      if (isAbortLikeError(err)) return null;
      console.error(`[bridge-session] external message failed (${sessionKey}):`, err.message);
      return { __bridgeError: true, message: err.message };
    }
  }

  /**
   * Inject a steer message into a streaming bridge session.
   * @param {string} sessionKey
   * @param {string} text
   * @returns {boolean}
   */
  steerSession(sessionKey, text, opts = {}) {
    const session = this._activeSessions.get(sessionKey);
    if (!this.isSessionStreaming(sessionKey, opts)) return false;
    session.steer(text);
    return true;
  }

  /**
   * Append an assistant message to a bridge session without calling the LLM.
   * @param {string} sessionKey
   * @param {string} text
    *
   * @returns {boolean}
   */
  recordAssistantMessage(sessionKey, text, opts = {}) {
    try {
      const agent = this._resolveAgent(opts, "recordAssistantMessage");
      const bridgeContext = this._buildBridgeContext(sessionKey, opts.meta, { ...opts, guest: false }, agent);
      const index = this.readIndex(agent);
      const raw = index[sessionKey];
      const existingFile = typeof raw === "string" ? raw : raw?.file || null;
      const bridgeDir = path.join(agent.sessionDir, "bridge");
      const sessionDir = path.join(bridgeDir, "owner");
      fs.mkdirSync(sessionDir, { recursive: true });

      let mgr = null;
      let sessionPath = null;
      if (existingFile) {
        sessionPath = path.join(bridgeDir, existingFile);
        if (fs.existsSync(sessionPath)) {
          this._repairOrphanToolHistory(sessionPath, "record assistant");
          this._repairInlineMediaHistory(sessionPath, "record assistant");
          mgr = SessionManager.open(sessionPath, path.dirname(sessionPath));
        } else if (!opts.createIfMissing) {
          console.warn(`[bridge-session] recordAssistantMessage: session file missing: ${sessionPath}`);
          return false;
        }
      } else if (!opts.createIfMissing) {
        console.warn(`[bridge-session] recordAssistantMessage: sessionKey "${sessionKey}" not found`);
        return false;
      }

      if (!mgr) {
        const homeCwd = this._deps.getHomeCwd(agent.id) || process.cwd();
        mgr = SessionManager.create(homeCwd, sessionDir);
        sessionPath = mgr.getSessionFile?.() || null;
        if (!sessionPath) {
          console.warn(`[bridge-session] recordAssistantMessage: new session path unavailable for "${sessionKey}"`);
          return false;
        }
      }

      mgr.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: agent.config?.models?.chat?.provider || "openai",
        model: agent.config?.models?.chat?.id || "unknown",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });

      if (sessionPath) {
        this._rememberBridgeContext(sessionPath, bridgeContext);
        const { changed } = this._syncIndexEntry(index, sessionKey, raw, {
          bridgeDir,
          sessionPath,
          meta: this._bridgeContextMeta(bridgeContext, opts.meta || null),
        });
        if (changed) this.writeIndex(index, agent);
      }

      debugLog()?.log("bridge-session", `recorded assistant message to ${sessionKey} (${text.length} chars)`);
      return true;
    } catch (err) {
      if (opts.agentId && /agent ".+" not found/.test(err.message || "")) throw err;
      console.error(`[bridge-session] recordAssistantMessage failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Back-compat wrapper used by slash/session ops.
   */
  injectMessage(sessionKey, text, opts = {}) {
    return this.recordAssistantMessage(sessionKey, text, { ...opts, createIfMissing: false });
  }

  recordCustomEntryForSessionPath(sessionPath, customType, data, opts = {}) {
    const resolved = path.resolve(sessionPath);
    for (const session of this._activeSessions.values()) {
      const livePath = session?.sessionManager?.getSessionFile?.();
      if (livePath && path.resolve(livePath) === resolved) {
        session.sessionManager.appendCustomEntry(customType, data);
        return { ok: true, mode: "bridge-live" };
      }
    }

    const context = this.getBridgeContextForSessionPath(resolved, opts);
    if (!context || !fs.existsSync(resolved)) return { ok: false, mode: "not-found" };
    const manager = SessionManager.open(resolved, path.dirname(resolved));
    manager.appendCustomEntry(customType, data);
    return { ok: true, mode: "bridge-file" };
  }

  _buildOwnerSessionOpts(agent, mm, homeCwd, sessionPathRef = { current: null }, opts = {}) {
    const prefs = this._deps.getPreferences();
    const bridgePermissionMode = normalizeBridgePermissionMode(prefs?.bridge || {});
    const bridgeReadOnly = bridgePermissionMode === SESSION_PERMISSION_MODES.READ_ONLY;
    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot({
        forceMemoryEnabled: agent.memoryMasterEnabled !== false,
        ...(typeof agent.experienceEnabled === "boolean"
          ? { forceExperienceEnabled: agent.experienceEnabled === true }
          : {}),
      })
      : agent.tools;
    const { tools: baseTools, customTools: baseCustomTools } = this._deps.buildTools(
      homeCwd,
      agentToolsSnapshot,
      {
        workspace: homeCwd,
        agentDir: agent.agentDir,
        getSessionPath: () => sessionPathRef.current,
        getPermissionMode: () => bridgePermissionMode,
      },
    );

    const bridgeTools = baseTools;
    const bridgeCustomTools = baseCustomTools;
    const ownerTools = filterBridgeOwnerToolObjects(bridgeTools);
    const ownerCustomTools = filterBridgeOwnerToolObjects(bridgeCustomTools);
    const allToolNames = uniqueToolNames([
      ...ownerTools.map((tool) => tool?.name),
      ...ownerCustomTools.map((tool) => tool?.name),
    ]);
    const availableToolNames = computeBridgeOwnerActiveToolNames(allToolNames);
    const activeToolNames = Array.isArray(opts.toolNames)
      ? repairRestoredToolSnapshot(opts.toolNames, availableToolNames)
      : availableToolNames;

    const ownerModel = this._resolveBridgeChatModel(agent, mm);
    const ownerPromptBase = opts.ownerPromptSnapshot || agent.buildSystemPrompt({
      cwdOverride: homeCwd,
      forceMemoryEnabled: agent.memoryMasterEnabled !== false,
      ...(typeof agent.experienceEnabled === "boolean"
        ? { forceExperienceEnabled: agent.experienceEnabled === true }
        : {}),
    });
    const ownerPromptSnapshot = appendBridgePromptLine(ownerPromptBase, opts.bridgeContext, getLocale());
    const ownerResourceLoader = Object.create(this._deps.getResourceLoader(), {
      getSystemPrompt: { value: () => ownerPromptSnapshot },
    });
    const visionResourceLoader = withVisionExtension(
      ownerResourceLoader,
      () => this._deps.getVisionBridge?.(),
      () => sessionPathRef.current,
      () => this._deps.isVisionAuxiliaryEnabled?.() === true,
      (msg) => console.warn(`[bridge-session] ${msg}`),
      ({ fileId, filePath, sessionPath }) => {
        const lookupSessionPath = sessionPath || sessionPathRef.current || null;
        if (fileId) return this._deps.getSessionFile?.(fileId, { sessionPath: lookupSessionPath });
        if (filePath) return this._deps.getSessionFileByPath?.(filePath, { sessionPath: lookupSessionPath });
        return null;
      },
      () => ownerModel,
    );

    return {
      model: ownerModel,
      thinkingLevel: mm.resolveThinkingLevel(prefs?.thinking_level || "auto"),
      resourceLoader: visionResourceLoader,
      tools: ownerTools,
      customTools: ownerCustomTools,
      settingsManager: this._createSettings(ownerModel),
      activeToolNames,
    };
  }

  async compactSession(sessionKey, opts = {}) {
    const agent = this._resolveAgent(opts, "compactSession");
    const active = this._activeSessions.get(sessionKey);
    if (active?.isStreaming) {
      throw new Error("bridge compact: session is streaming, try again after the reply completes");
    }

    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const entry = this._normalizeIndexEntry(raw);
    const existingFile = entry.file || null;
    if (!existingFile) {
      throw new Error(`bridge compact: session "${sessionKey}" not found or has no history`);
    }
    const sessionFilePath = path.join(bridgeDir, existingFile);
    if (!fs.existsSync(sessionFilePath)) {
      throw new Error(`bridge compact: session file missing on disk: ${sessionFilePath}`);
    }

    const mm = this._deps.getModelManager();
    const homeCwd = this._deps.getHomeCwd(agent.id) || process.cwd();
    const sessionDir = path.dirname(sessionFilePath);
    this._repairOrphanToolHistory(sessionFilePath, "compact reopen");
    this._repairInlineMediaHistory(sessionFilePath, "compact reopen");
    const mgr = SessionManager.open(sessionFilePath, sessionDir);
    const sessionPathRef = { current: sessionFilePath };
    const freshContext = opts.fresh === true
      ? this._buildOwnerFreshCompactContext(agent, homeCwd)
      : null;
    const sessionOpts = this._buildOwnerSessionOpts(agent, mm, homeCwd, sessionPathRef, {
      ownerPromptSnapshot: freshContext?.systemPrompt,
      toolNames: entry.toolNames,
    });
    const activeToolNames = this._normalizeToolNames(sessionOpts.activeToolNames);
    delete sessionOpts.activeToolNames;

    const { session } = await createAgentSession({
      cwd: homeCwd,
      sessionManager: mgr,
      modelRuntime: mm.modelRuntime,
      ...sessionOpts,
    });
    if (activeToolNames.length) {
      session.setActiveToolsByName?.(activeToolNames);
    }

    try {
      const before = session.getContextUsage?.() ?? null;
      if (session.isCompacting) {
        throw new Error("bridge compact: already compacting");
      }
      try {
        await session.compact();
      } catch (err) {
        const noopReason = freshContext ? getFreshCompactNoopReason(err) : null;
        if (!noopReason) throw err;
        return await this.markFreshCompactSatisfied(sessionKey, {
          agentId: agent.id,
          reason: opts.reason || "manual",
          now: opts.now || new Date(),
          noopReason,
          tokensBefore: before?.tokens ?? null,
          tokensAfter: before?.tokens ?? null,
          contextWindow: before?.contextWindow ?? null,
        });
      }
      const after = session.getContextUsage?.() ?? null;

      const result = {
        tokensBefore: before?.tokens ?? null,
        tokensAfter: after?.tokens ?? null,
        contextWindow: after?.contextWindow ?? before?.contextWindow ?? null,
      };

      if (freshContext) {
        const reason = opts.reason || "manual";
        const patch = buildFreshCompactMetaPatch({
          snapshot: freshContext.snapshot,
          reason,
          now: opts.now || new Date(),
          usage: result,
        });
        this._writeIndexEntryPatch(agent, sessionKey, {
          freshCompact: patch,
          promptSnapshot: { version: 1, systemPrompt: freshContext.systemPrompt },
          ...(activeToolNames.length ? { toolNames: activeToolNames } : {}),
        });
        return { ...result, fresh: true, reason };
      }

      if (activeToolNames.length && JSON.stringify(activeToolNames) !== JSON.stringify(entry.toolNames || [])) {
        this._writeIndexEntryPatch(agent, sessionKey, { toolNames: activeToolNames });
      }

      return result;
    } finally {
      await teardownSessionResources({
        session,
        label: `bridge.compactSession[${sessionKey}]`,
        warn: (msg) => console.warn(`[bridge-session] ${msg}`),
      });
    }
  }

  async freshCompactSession(sessionKey, opts = {}) {
    return this.compactSession(sessionKey, {
      ...opts,
      fresh: true,
      reason: opts.reason || "manual",
    });
  }

  /** Create bridge-specific settings. Compaction still uses SDK defaults. */
  _createSettings(model) {
    return createDefaultSettings(model);
  }
}

function addAttachedImageMarkers(text, imageAttachmentPaths) {
  const promptText = text || "";
  const missing = Array.from(new Set(imageAttachmentPaths || []))
    .filter((filePath) => filePath && !promptText.includes(`[attached_image: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_image: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}
