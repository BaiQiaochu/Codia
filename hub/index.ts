// @ts-nocheck
/**
 * Hub message dispatch center.
 *
 * Hub and GsapEngine run in the same Node process. hub.send() forwards to
 * engine methods directly, while EventBus provides shared event broadcasting.
 *
 * Modules:
 *   EventBus
 *   ChannelRouter
 *   GuestHandler
 *   Scheduler
 */

import path from "path";
import fs from "fs";
import crypto from "crypto";
import { EventBus } from "./event-bus.ts";
import { ChannelRouter } from "./channel-router.ts";
import { GuestHandler } from "./guest-handler.ts";
import { Scheduler } from "./scheduler.ts";
import { DmRouter } from "./dm-router.ts";
import { AgentPhoneActivityStore } from "../lib/conversations/agent-phone-activity.ts";
import {
  extractTextContent,
  filterUnreferencedInlineImages,
  loadSessionHistoryMessages,
  isValidSessionPath,
} from "../core/message-utils.ts";
import { submitDesktopSessionMessage } from "../core/desktop-session-submit.ts";
import { extOfName, inferFileKind } from "../lib/file-metadata.ts";
import { callText } from "../core/llm-client.ts";
import { normalizeSessionTurnContext } from "../core/session-turn-context.ts";
import { findModel } from "../shared/model-ref.ts";
import {
  appendMessage as appendChannelStoreMessage,
  getChannelMembers,
  getChannelMemberRoles,
} from "../lib/channels/channel-store.ts";

export class Hub {
  /**
   * @param {object} opts
   * @param {import('../core/engine.ts').GsapEngine} opts.engine
   */
  constructor({ engine }) {
    this._engine = engine;
    this._eventBus = new EventBus();
    this._channelRouter = new ChannelRouter({ hub: this });
    this._guestHandler = new GuestHandler({ hub: this });
    this._scheduler = new Scheduler({ hub: this });
    this._dmRouter = new DmRouter({ hub: this });
    this._agentPhoneActivities = new AgentPhoneActivityStore({
      emit: (event) => this._eventBus.emit(event, null),
    });
    this._agentPhoneAbortHandlers = new Set();

 //
    engine.setHubCallbacks({
      hub: this,
      scheduler: this._scheduler,
      dmRouter: this._dmRouter,
      channelRouter: this._channelRouter,
      eventBus: this._eventBus,
      registerAgentPhoneAbortHandler: (handler, meta) => this.registerAgentPhoneAbortHandler(handler, meta),
      pauseForAgentSwitch: () => this.pauseForAgentSwitch(),
      resumeAfterAgentSwitch: () => this.resumeAfterAgentSwitch(),
      syncBackgroundExecution: () => this.syncBackgroundExecution(),
      triggerChannelDelivery: (name, opts) => this._channelRouter.triggerImmediate(name, opts),
      triggerChannelTriage: (name, opts) => this._channelRouter.triggerImmediate(name, opts),
    });

    // Inject EventBus for legacy subscribers.
    engine.setEventBus(this._eventBus);

    this._sessionHandlerCleanups = [];
    this._setupSessionHandlers();
    this._setupDmHandler();
  }

  /** @returns {import('../core/engine.ts').GsapEngine} */
  get engine() { return this._engine; }

  /** @returns {EventBus} */
  get eventBus() { return this._eventBus; }

  /** @returns {ChannelRouter} */
  get channelRouter() { return this._channelRouter; }

  /** @returns {Scheduler} */
  get scheduler() { return this._scheduler; }

  /** @returns {import('../lib/bridge/bridge-manager.ts').BridgeManager|null} */
  get bridgeManager() { return this._bridgeManager || null; }
  set bridgeManager(bm) { this._bridgeManager = bm; }

  get agentPhoneActivities() { return this._agentPhoneActivities; }

  registerAgentPhoneAbortHandler(handler, meta = {}) {
    if (typeof handler !== "function") return () => {};
    const entry = { handler, meta };
    this._agentPhoneAbortHandlers.add(entry);
    return () => {
      this._agentPhoneAbortHandlers.delete(entry);
    };
  }

  abortAgentPhoneSessions(reason = "phone-disabled", filter = null) {
    const entries = [...this._agentPhoneAbortHandlers];
    let aborted = 0;
    for (const { handler, meta } of entries) {
      if (!matchesAgentPhoneAbortFilter(meta, filter)) continue;
      try {
        handler(reason);
        aborted += 1;
      } catch (err) {
        console.warn(`[hub] agent phone abort handler failed: ${err.message}`);
      }
    }
    return aborted;
  }

  // ──────────── 订阅 ────────────

  /**
  *
  *
   * @returns {Function} unsubscribe
   */
  subscribe(callback, filter) {
    return this._eventBus.subscribe(callback, filter);
  }

  // ──────────── 消息统一入口 ────────────

  /**
   * 统一消息入口
   *
   * @param {string} text  消息文本
   * @param {object} [opts]
    *
  *
 * @param {boolean} [opts.isGroup] 是否群聊（影-guest 上下文标签）
    *
 * @param {string} [opts.model] 模型覆盖
  *
   */
  async send(text, opts = {}) {
    const {
      sessionKey,
      role = "owner",
      ephemeral = false,
      meta,
      isGroup = false,
      cwd,
      model,
      persist,
      from,
      to,
      onDelta,
      images,
      imageAttachmentPaths,
      videos,
      videoAttachmentPaths,
      audios,
      audioAttachmentPaths,
      inboundFiles,
      clientMessageId,
      sessionPath,
      agentId,
      uiContext,
      displayMessage,
      sessionFileRefs,
    } = opts;
    const o = { sessionKey, role, ephemeral, meta, isGroup, cwd, model, persist, from, to, onDelta, images, imageAttachmentPaths, videos, videoAttachmentPaths, audios, audioAttachmentPaths, inboundFiles, clientMessageId, sessionPath, agentId, uiContext, displayMessage, sessionFileRefs };

    //
    // Persist image uploads before routing.
    if (
      o.images?.length
      && this._engine.gsapHome
      && !o.inboundFiles?.length
      && !hasDisplayImageAttachments(o.displayMessage)
    ) {
      const attachDir = path.join(this._engine.gsapHome, "attachments");
      await fs.promises.mkdir(attachDir, { recursive: true });
      const savedPaths = [];
      for (const img of o.images) {
        const ext = (img.mimeType || "image/png").split("/")[1] || "png";
        const hash = crypto.createHash("md5").update((img.data || "").slice(0, 1024)).digest("hex").slice(0, 8);
        const filePath = path.join(attachDir, `upload-${Date.now()}-${hash}.${ext}`);
        try {
          await fs.promises.writeFile(filePath, Buffer.from(img.data, "base64"));
          savedPaths.push(filePath);
        } catch { /* best-effort; prompt still goes through */ }
      }
      if (savedPaths.length) {
        const pathNote = savedPaths.map(p => `[attached_image: ${p}]`).join("\n");
        text = `${pathNote}\n${text}`;
        o.imageAttachmentPaths = savedPaths;
      }
    }
    if (
      o.videos?.length
      && this._engine.gsapHome
      && !o.inboundFiles?.length
      && !hasDisplayVideoAttachments(o.displayMessage)
    ) {
      const attachDir = path.join(this._engine.gsapHome, "attachments");
      await fs.promises.mkdir(attachDir, { recursive: true });
      const savedPaths = [];
      for (const video of o.videos) {
        const ext = extensionForVideoMime(video.mimeType);
        const hash = crypto.createHash("md5").update((video.data || "").slice(0, 1024)).digest("hex").slice(0, 8);
        const filePath = path.join(attachDir, `upload-${Date.now()}-${hash}${ext}`);
        try {
          await fs.promises.writeFile(filePath, Buffer.from(video.data, "base64"));
          savedPaths.push(filePath);
        } catch { /* best-effort; prompt still goes through */ }
      }
      if (savedPaths.length) {
        const pathNote = savedPaths.map(p => `[attached_video: ${p}]`).join("\n");
        text = `${pathNote}\n${text}`;
        o.videoAttachmentPaths = savedPaths;
      }
    }

    // Route table is order-sensitive; first match wins.
    const routes = [
      { // 桌面端 owner
        match: o => !o.sessionKey && !o.ephemeral && o.role === "owner",
        handle: () => o.sessionPath
          ? submitDesktopSessionMessage(this._engine, {
            sessionPath: o.sessionPath,
            text,
            images: o.images,
            imageAttachmentPaths: o.imageAttachmentPaths,
            videos: o.videos,
            videoAttachmentPaths: o.videoAttachmentPaths,
            audios: o.audios,
            audioAttachmentPaths: o.audioAttachmentPaths,
            inboundFiles: o.inboundFiles,
            clientMessageId: o.clientMessageId,
            onDelta: o.onDelta,
            uiContext: o.uiContext,
            displayMessage: o.displayMessage,
            sessionFileRefs: o.sessionFileRefs,
          })
          : this._engine.prompt(text, { images: o.images, videos: o.videos, audios: o.audios }),
      },
      { // Bridge guest
        match: o => o.sessionKey && o.role === "guest",
        handle: () => this._guestHandler.handle(text, o.sessionKey, o.meta, { isGroup: o.isGroup, agentId: o.agentId, onDelta: o.onDelta, images: o.images, imageAttachmentPaths: o.imageAttachmentPaths, videos: o.videos, videoAttachmentPaths: o.videoAttachmentPaths, audios: o.audios, audioAttachmentPaths: o.audioAttachmentPaths, inboundFiles: o.inboundFiles }),
      },
      { // Bridge owner
        match: o => o.sessionKey && !o.ephemeral,
        handle: () => this._engine.executeExternalMessage(text, o.sessionKey, o.meta, { guest: false, agentId: o.agentId, onDelta: o.onDelta, images: o.images, imageAttachmentPaths: o.imageAttachmentPaths, videos: o.videos, videoAttachmentPaths: o.videoAttachmentPaths, audios: o.audios, audioAttachmentPaths: o.audioAttachmentPaths, inboundFiles: o.inboundFiles }),
      },
      {
        // Isolated execution for cron/heartbeat/channel work.
        match: o => o.ephemeral,
        handle: () => this._engine.executeIsolated(text, { cwd: o.cwd, model: o.model, persist: o.persist }),
      },
    ];

    for (const route of routes) {
      if (route.match(o)) return route.handle();
    }
    throw new Error(`[Hub] unhandled route: role=${o.role}, sessionKey=${o.sessionKey}, ephemeral=${o.ephemeral}`);
  }

  /**
  * */
  async abort(sessionPath) {
    return sessionPath
      ? this._engine.abortSession(sessionPath)
      : this._engine.abort();
  }

  //

  /**
  *
   */
  initSchedulers() {
    // Scheduler: heartbeat + cron.
    this._scheduler.start();

    // ChannelRouter is opt-in. Starting it unconditionally slows startup and
    // ignores the global channel switch migrated in 0.115.0.
    if (this._engine.isChannelsEnabled?.()) {
      this._channelRouter.start();
    }

    // 注入频道 post 回调
    this._channelRouter.setupPostHandler();
  }

  /**
  * */
  async pauseForAgentSwitch() {
    await this._scheduler.stopHeartbeat();
  }

  /**
  *
   */
  resumeAfterAgentSwitch() {
    void this.syncBackgroundExecution();
    this._setupDmHandler();
    this._channelRouter.setupPostHandler();
  }

  async syncBackgroundExecution() {
    await this._scheduler.syncAvailability();
    await this._channelRouter.syncAvailability();
  }

  /**
 * 停止所有调度器（dispose 用）
   */
  async stopSchedulers() {
    await this._scheduler.stop();
    await this._channelRouter.stop();
  }

  // ──────────── 频道代理方法 ────────────

  triggerChannelDelivery(channelName, opts) {
    return this._channelRouter.triggerImmediate(channelName, opts);
  }

  triggerChannelTriage(channelName, opts) {
    return this.triggerChannelDelivery(channelName, opts);
  }

  async toggleChannels(enabled) {
    if (!enabled) this.abortAgentPhoneSessions("channels-disabled");
    return this._channelRouter.toggle(enabled);
  }

  refreshChannelProactiveSchedule() {
    return this._channelRouter.refreshProactiveSchedule?.();
  }

 //

  async dispose() {
    for (const cleanup of this._sessionHandlerCleanups) cleanup();
    this._sessionHandlerCleanups = [];
    await this.stopSchedulers();
    await this._engine.dispose();
    this._eventBus.clear();
  }

  // ──────────── 内部 ────────────

  /** @returns {DmRouter} */
  get dmRouter() { return this._dmRouter; }

  _setupSessionHandlers() {
    const bus = this._eventBus;
    const engine = this._engine;

    const safeChannelPath = (id) => {
      const channelId = String(id || "").trim();
      if (!channelId) throw new Error("channelId is required");
      const filePath = path.join(engine.channelsDir || "", `${channelId}.md`);
      const resolved = path.resolve(filePath);
      const base = path.resolve(engine.channelsDir || "");
      if (!base || (!resolved.startsWith(base + path.sep) && resolved !== base)) {
        const err = new Error("Invalid channel id");
        err.status = 400;
        throw err;
      }
      if (!fs.existsSync(resolved)) {
        const err = new Error("Channel not found");
        err.status = 404;
        throw err;
      }
      return resolved;
    };

    const channelRoleCounts = (memberRoles = {}) => {
      const counts = { project_manager: 0, admin: 0, worker: 0 };
      for (const role of Object.values(memberRoles || {})) {
        if (role in counts) counts[role] += 1;
      }
      return counts;
    };

    // ── session:create ──
    this._sessionHandlerCleanups.push(bus.handle("session:create", async (payload: any = {}) => {
      const agentId = textOrNull(payload.agentId);
      const cwd = textOrNull(payload.cwd) || undefined;
      const memFlag = payload.memoryEnabled !== false;
      const model = resolveRequestedModel(engine, payload.model);
      const createOptions = {
        workspaceFolders: Array.isArray(payload.workspaceFolders)
          ? payload.workspaceFolders.filter((item) => typeof item === "string" && item.trim())
          : [],
        authorizedFolders: Array.isArray(payload.authorizedFolders)
          ? payload.authorizedFolders.filter((item) => typeof item === "string" && item.trim())
          : [],
        visibleInSessionList: payload.visibility !== "plugin_private" && payload.visibility !== "private",
        ...(payload.thinkingLevel != null ? { thinkingLevel: payload.thinkingLevel } : {}),
        ...(payload.permissionMode != null ? { permissionMode: payload.permissionMode } : {}),
        ownerPluginId: textOrNull(payload.ownerPluginId),
        sessionKind: textOrNull(payload.kind || payload.sessionKind),
        sessionVisibility: textOrNull(payload.visibility || payload.sessionVisibility) || "public",
      };
      if (typeof engine.createDetachedSession !== "function") {
        throw new Error("session detached creation unavailable");
      }
      const result = await engine.createDetachedSession({
        cwd,
        memoryEnabled: memFlag,
        model,
        ...(agentId ? { agentId } : {}),
        ...createOptions,
      });
      engine.persistSessionMeta?.();
      const sessionPath = result.sessionPath;
      if (payload.permissionMode !== undefined && sessionPath) {
        engine.setSessionPermissionModeForSession?.(sessionPath, payload.permissionMode);
      }
      const response = {
        ok: true,
        sessionPath,
        path: sessionPath,
        agentId: result.agentId,
        agentName: engine.getAgent?.(result.agentId)?.agentName || result.agentId || null,
        cwd: engine.getSessionByPath?.(sessionPath)?.sessionManager?.getCwd?.() || cwd || null,
        workspaceFolders: engine.getSessionWorkspaceFolders?.(sessionPath) || [],
        authorizedFolders: engine.getSessionAuthorizedFolders?.(sessionPath) || [],
        thinkingLevel: engine.getSessionThinkingLevel?.(sessionPath) || null,
        permissionMode: engine.getSessionPermissionMode?.(sessionPath) || null,
        ownerPluginId: createOptions.ownerPluginId || null,
        kind: createOptions.sessionKind || null,
        visibility: createOptions.sessionVisibility || "public",
      };
      bus.emit({ type: "session_created", session: response }, sessionPath);
      return response;
    }));

    // ── session:get ──
    this._sessionHandlerCleanups.push(bus.handle("session:get", async ({ sessionPath, ownerPluginId }: any = {}) => {
      if (!sessionPath) throw new Error("sessionPath is required");
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        throw new Error("Invalid session path");
      }
      const sessions = await engine.listSessions({
        includePluginPrivate: true,
        ...(ownerPluginId ? { ownerPluginId } : {}),
      });
      const session = sessions.find((item) => item.path === sessionPath) || null;
      if (!session) return { session: null };
      return { session };
    }));

    // ── session:update ──
    this._sessionHandlerCleanups.push(bus.handle("session:update", async ({
      sessionPath,
      title,
      pinned,
      projectId,
      thinkingLevel,
      permissionMode,
      ownerPluginId,
      kind,
      sessionKind,
      visibility,
      sessionVisibility,
    }: any = {}) => {
      if (!sessionPath) throw new Error("sessionPath is required");
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        throw new Error("Invalid session path");
      }
      if (typeof title === "string") await engine.saveSessionTitle?.(sessionPath, title);
      if (pinned !== undefined) await engine.setSessionPinned?.(sessionPath, !!pinned);
      if (projectId !== undefined) {
        await engine.setSessionProjectAssignment?.({ sessionPath, projectId });
      }
      if (thinkingLevel !== undefined) {
        await engine.setSessionThinkingLevel?.(sessionPath, thinkingLevel);
      }
      if (permissionMode !== undefined) {
        engine.setSessionPermissionModeForSession?.(sessionPath, permissionMode);
      }
      if (
        ownerPluginId !== undefined
        || kind !== undefined
        || sessionKind !== undefined
        || visibility !== undefined
        || sessionVisibility !== undefined
      ) {
        await engine.setSessionPluginMeta?.(sessionPath, {
          ownerPluginId,
          kind: kind ?? sessionKind,
          visibility: visibility ?? sessionVisibility,
        });
      }
      const sessions = await engine.listSessions({ includePluginPrivate: true });
      return { ok: true, session: sessions.find((item) => item.path === sessionPath) || null };
    }));

    // ── session:send ──
    this._sessionHandlerCleanups.push(bus.handle("session:send", async ({ text, sessionPath, ...opts }) => {
      if (!text || typeof text !== "string" || !text.trim()) {
        throw new Error("text is required");
      }
      const sp = sessionPath;
      if (!sp) throw new Error("sessionPath is required for session:send");
      if (engine.isSessionStreaming(sp)) throw new Error("session_busy");
      if (opts.context !== undefined) {
        opts.context = normalizeSessionTurnContext(opts.context);
      }
      engine.promptSession(sp, text, opts).catch(err => {
        console.error("[Hub] session:send promptSession error:", err.message);
        bus.emit({ type: "error", error: err.message, source: "session:send" }, sp);
      });
      return { sessionPath: sp, accepted: true };
    }));

    // ── session:abort ──
    this._sessionHandlerCleanups.push(bus.handle("session:abort", async ({ sessionPath } = {}) => {
      const sp = sessionPath;
      if (!sp) return { aborted: false };
      const result = await engine.abortSession(sp);
      return { aborted: !!result };
    }));

    // ── session:history ──
    this._sessionHandlerCleanups.push(bus.handle("session:history", async ({ sessionPath, limit: rawLimit } = {}) => {
      if (!sessionPath) throw new Error("sessionPath is required");
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        throw new Error("Invalid session path");
      }
      const limit = Math.min(Number(rawLimit) || 50, 200);
      const sourceMessages = await loadSessionHistoryMessages(engine, sessionPath);
      const messages = [];
      for (const m of sourceMessages) {
        if (m.role === "user") {
          const { text, images } = extractTextContent(m.content);
          const visibleImages = filterUnreferencedInlineImages(text, images);
          if (text || visibleImages.length) {
            messages.push({
              role: "user",
              content: text,
              images: visibleImages.length ? visibleImages : undefined,
              ...(m.timestamp ? { timestamp: m.timestamp } : {}),
            });
          }
        } else if (m.role === "assistant") {
          const { text, thinking, toolUses } = extractTextContent(m.content, { stripThink: true });
          if (text || toolUses.length) {
            messages.push({
              role: "assistant",
              content: text,
              thinking: thinking || undefined,
              toolCalls: toolUses.length ? toolUses : undefined,
              ...(m.timestamp ? { timestamp: m.timestamp } : {}),
            });
          }
        }
        if (messages.length >= limit) break;
      }
      return { messages };
    }));

    // ── session:list ──
    this._sessionHandlerCleanups.push(bus.handle("session:list", async ({ agentId, ownerPluginId, includePluginPrivate }: any = {}) => {
      const all = await engine.listSessions({
        includePluginPrivate: includePluginPrivate === true || !!ownerPluginId,
        ...(ownerPluginId ? { ownerPluginId } : {}),
      });
      const filtered = agentId ? all.filter(s => s.agentId === agentId) : all;
      const sessions = filtered.map(s => ({
        path: s.path,
        title: s.title,
        firstMessage: s.firstMessage,
        agentId: s.agentId,
        agentName: s.agentName,
        modelId: s.modelId,
        messageCount: s.messageCount,
        cwd: s.cwd,
        modified: s.modified,
        ownerPluginId: s.ownerPluginId || null,
        kind: s.sessionKind || null,
        visibility: s.visibility || "public",
      }));
      return { sessions };
    }));

    // ── agent:list ──
    this._sessionHandlerCleanups.push(bus.handle("agent:list", async ({ ownerPluginId, includePluginPrivate }: any = {}) => {
      const all = engine.listAgents({
        includePluginPrivate: includePluginPrivate === true || !!ownerPluginId,
        ...(ownerPluginId ? { ownerPluginId } : {}),
      });
      const agents = all.map(a => ({
        id: a.id,
        name: a.name,
        yuan: a.yuan || null,
        identity: a.identity || "",
        ownerPluginId: a.plugin?.ownerPluginId || null,
        visibility: a.plugin?.visibility || "public",
        isCurrent: a.isCurrent,
        isPrimary: a.isPrimary,
      }));
      return { agents };
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:profile", async ({ agentId }: any = {}) => {
      const { agent, error } = resolveAgentForBus(engine, agentId);
      if (error) throw new Error(error);
      return { profile: publicAgentProfile(agent) };
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:create", async (payload: any = {}) => {
      const name = textOrNull(payload.name);
      if (!name) throw new Error("name is required");
      const ownerPluginId = textOrNull(payload.ownerPluginId);
      const visibility = textOrNull(payload.visibility) || "public";
      const result = await engine.createAgent({
        name,
        ...(textOrNull(payload.id) ? { id: textOrNull(payload.id) } : {}),
        ...(textOrNull(payload.yuan) ? { yuan: textOrNull(payload.yuan) } : {}),
        ...(payload.initialFiles && typeof payload.initialFiles === "object" ? { initialFiles: payload.initialFiles } : {}),
        ...(payload.initialMemory && typeof payload.initialMemory === "object" ? { initialMemory: payload.initialMemory } : {}),
      });
      if (ownerPluginId || visibility !== "public" || payload.kind) {
        await engine.updateConfig?.({
          plugin: {
            ownerPluginId: ownerPluginId || null,
            visibility,
            ...(textOrNull(payload.kind) ? { kind: textOrNull(payload.kind) } : {}),
          },
        }, { agentId: result.id });
        engine.invalidateAgentListCache?.();
      }
      if (payload.memoryPolicy && typeof payload.memoryPolicy === "object") {
        await engine.updateConfig?.({
          memory: { enabled: payload.memoryPolicy.enabled !== false },
        }, { agentId: result.id });
      }
      const createdAgent = engine.getAgent?.(result.id);
      return {
        agent: {
          id: result.id,
          name: result.name,
          ownerPluginId: ownerPluginId || null,
          visibility,
          profile: createdAgent ? publicAgentProfile(createdAgent) : null,
        },
      };
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:update", async ({
      agentId,
      name,
      yuan,
      visibility,
      ownerPluginId,
      kind,
      memoryPolicy,
      toolPolicy,
      config,
    }: any = {}) => {
      if (!agentId) throw new Error("agentId is required");
      const partial: any = {};
      if (name !== undefined || yuan !== undefined) {
        partial.agent = {
          ...(name !== undefined ? { name } : {}),
          ...(yuan !== undefined ? { yuan } : {}),
        };
      }
      if (visibility !== undefined || ownerPluginId !== undefined || kind !== undefined) {
        partial.plugin = {
          ...(ownerPluginId !== undefined ? { ownerPluginId: textOrNull(ownerPluginId) } : {}),
          ...(visibility !== undefined ? { visibility: textOrNull(visibility) || "public" } : {}),
          ...(kind !== undefined ? { kind: textOrNull(kind) } : {}),
        };
      }
      if (memoryPolicy && typeof memoryPolicy === "object") {
        partial.memory = { enabled: memoryPolicy.enabled !== false };
      }
      if (toolPolicy && typeof toolPolicy === "object") {
        partial.tools = {
          ...(Array.isArray(toolPolicy.disabled) ? { disabled: toolPolicy.disabled } : {}),
        };
      }
      if (config && typeof config === "object") {
        Object.assign(partial, config);
      }
      await engine.updateConfig?.(partial, { agentId });
      engine.invalidateAgentListCache?.();
      const agent = engine.getAgent?.(agentId);
      return { ok: true, agent: agent ? publicAgentProfile(agent) : { id: agentId } };
    }));

    // ── provider & agent handlers ──

    this._sessionHandlerCleanups.push(bus.handle("provider:credentials", async ({ providerId }) => {
      const fresh = typeof engine.resolveProviderCredentialsFresh === "function"
        ? await engine.resolveProviderCredentialsFresh(providerId)
        : null;
      const creds = fresh
        ? { apiKey: fresh.api_key, baseUrl: fresh.base_url, api: fresh.api, accountId: fresh.accountId }
        : engine.providerRegistry.getCredentials(providerId);
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(creds?.baseUrl || ""));
      if (!creds?.apiKey && !isLocal) return { error: "no_credentials" };
      return {
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl,
        api: creds.api,
        ...(creds.accountId ? { accountId: creds.accountId } : {}),
      };
    }));

    this._sessionHandlerCleanups.push(bus.handle("utility:call-text", async ({
      agentId,
      systemPrompt = "",
      messages = [],
      temperature = 0.3,
      maxTokens = 512,
      timeoutMs = 60000,
    } = {}) => {
      const cfg = engine.resolveUtilityConfig(agentId ? { agentId } : undefined);
      const model = cfg?.utility;
      const apiKey = cfg?.api_key;
      const baseUrl = cfg?.base_url;
      const api = cfg?.api;
      if (!model || !api || !baseUrl || !apiKey) {
        throw new Error("Utility model is not configured");
      }
      const text = await callText({
        api,
        model,
        apiKey,
        baseUrl,
        provider: model?.provider || "custom",
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        timeoutMs,
        usageLedger: cfg.usageLedger ?? engine.usageLedger,
        usageContext: {
          source: {
            subsystem: "utility",
            operation: "utility_call_text",
            surface: "plugin",
            trigger: "event_bus",
          },
          attribution: {
            kind: "utility",
            agentId: cfg.usageAgentId ?? agentId ?? null,
          },
        },
      });
      return { text };
    }));

    this._sessionHandlerCleanups.push(bus.handle("model:sample-text", async ({
      agentId,
      sessionPath,
      systemPrompt = "",
      messages = [],
      temperature = 0.3,
      maxTokens = 512,
      timeoutMs = 60000,
      operation = "model_sample_text",
      pluginId = null,
    } = {}) => {
      const cfg = engine.resolveUtilityConfig(agentId ? { agentId } : undefined);
      const model = cfg?.utility;
      const apiKey = cfg?.api_key;
      const baseUrl = cfg?.base_url;
      const api = cfg?.api;
      if (!model || !api || !baseUrl || !apiKey) {
        throw new Error("Utility model is not configured");
      }
      const text = await callText({
        api,
        model,
        apiKey,
        baseUrl,
        provider: model?.provider || "custom",
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        timeoutMs,
        usageLedger: cfg.usageLedger ?? engine.usageLedger,
        usageContext: {
          source: {
            subsystem: "plugin",
            operation,
            surface: "plugin",
            trigger: "event_bus",
          },
          attribution: {
            kind: "plugin",
            pluginId: textOrNull(pluginId) || "unknown",
            agentId: cfg.usageAgentId ?? agentId ?? null,
            sessionPath: sessionPath || null,
          },
        },
      });
      return { text };
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:models-by-type", async ({ type, providerId }) => {
      if (providerId) {
        return { models: engine.providerRegistry.getModelsByType(providerId, type) };
      }
      return { models: engine.providerRegistry.getAllModelsByType(type) };
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:media-providers", async ({ capability = "image_generation" } = {}) => {
      const providers = {};
      for (const provider of engine.providerRegistry.getMediaProviders(capability)) {
        const providerModels = typeof engine.providerRegistry.getRegisteredMediaModels === "function"
          ? engine.providerRegistry.getRegisteredMediaModels(provider.providerId, capability)
          : provider.models || [];
        if (!providerModels.length) continue;
        const credentialStatus = engine.providerRegistry.getMediaProviderCredentialStatus(provider.providerId, capability);
        providers[provider.providerId] = {
          ...provider,
          hasCredentials: credentialStatus.hasCredentials,
          unavailableReason: credentialStatus.unavailableReason,
          credentialLanes: credentialStatus.lanes,
          activeCredentialLaneId: credentialStatus.activeLaneId || null,
          activeCredentialProviderId: credentialStatus.activeProviderId || null,
          models: providerModels.map((model) => ({
            ...model,
            id: model.id,
            name: model.displayName || model.name || model.id,
            displayName: model.displayName || model.name || model.id,
            protocolId: model.protocolId,
            credentialLaneId: model.credentialLaneId,
          })),
          availableModels: [],
        };
      }
      return { providers };
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:resolve-media-model", async ({
      providerId,
      provider,
      modelId,
      model,
      capability = "image_generation",
      credentialLaneId,
    } = {}) => {
      try {
        const resolved = engine.providerRegistry.resolveMediaModel({
          providerId: providerId || provider,
          modelId: modelId || model,
          capability,
          credentialLaneId,
        });
        const status = engine.providerRegistry.getMediaProviderCredentialStatus(resolved.providerId, capability);
        const lane = resolved.credentialLane || null;
        const credentialProviderId = lane?.providerId || status.activeProviderId || resolved.providerId;
        if (!status.hasCredentials && resolved.provider.authType !== "none") {
          return { error: status.unavailableReason || "no_credentials" };
        }
        return {
          providerId: resolved.providerId,
          modelId: resolved.model.id,
          model: resolved.model,
          protocolId: resolved.model.protocolId,
          capability: resolved.capability,
          credentialLaneId: lane?.id || status.activeLaneId || null,
          credentialProviderId,
        };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    }));

    const isResponseMediaDelivery = (payload: any = {}) => {
      const delivery = payload?.delivery && typeof payload.delivery === "object" ? payload.delivery : null;
      const mode = delivery?.mode || payload?.deliveryMode;
      return String(mode || "").toLowerCase() === "response";
    };

    this._sessionHandlerCleanups.push(bus.handle("media:generate-image", async (payload: any = {}) => {
      const sessionPath = textOrNull(payload.sessionPath);
      const responseDelivery = isResponseMediaDelivery(payload);
      if (!sessionPath && !responseDelivery) throw new Error("sessionPath is required");
      const input = payload.input && typeof payload.input === "object"
        ? payload.input
        : {
          prompt: payload.prompt,
          count: payload.count,
          image: payload.image,
          images: payload.images,
          referenceImages: payload.referenceImages,
          ratio: payload.ratio,
          resolution: payload.resolution,
          quality: payload.quality,
          model: payload.model,
          provider: payload.provider,
          delivery: payload.delivery,
          deliveryMode: payload.deliveryMode,
        };
      if (!textOrNull(input.prompt)) throw new Error("prompt is required");
      return bus.request("media-gen:submit-image", {
        input,
        ...(sessionPath ? { sessionPath } : {}),
        metadata: {
          ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
          ...(textOrNull(payload.pluginId) ? { pluginId: textOrNull(payload.pluginId) } : {}),
        },
        ...(payload.delivery !== undefined ? { delivery: payload.delivery } : {}),
        ...(payload.deliveryMode !== undefined ? { deliveryMode: payload.deliveryMode } : {}),
        ...(payload.deliveryTarget !== undefined ? { deliveryTarget: payload.deliveryTarget } : {}),
      });
    }));

    this._sessionHandlerCleanups.push(bus.handle("media:generate-video", async (payload: any = {}) => {
      return bus.request("media-gen:submit-video", payload);
    }));

    this._sessionHandlerCleanups.push(bus.handle("media:generate", async (payload: any = {}) => {
      const kind = String(payload?.kind || payload?.type || "image").toLowerCase();
      if (kind === "video") return bus.request("media:generate-video", payload);
      if (kind === "image") return bus.request("media:generate-image", payload);
      throw new Error(`unsupported media kind "${kind}"`);
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:add-media-model", async ({
      providerId,
      capability = "image_generation",
      model,
    } = {}) => {
      try {
        engine.providerRegistry.addMediaModel(providerId, capability, model);
        await engine.onProviderChanged?.();
        return { ok: true };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:remove-media-model", async ({
      providerId,
      capability = "image_generation",
      modelId,
    } = {}) => {
      try {
        engine.providerRegistry.removeMediaModel(providerId, capability, modelId);
        await engine.onProviderChanged?.();
        return { ok: true };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:catalog", async () => {
      const rawProviders = engine.providerRegistry.getAllProvidersRaw();
      const registered = engine.providerRegistry.getAll();
      const allIds = new Set([...registered.keys(), ...Object.keys(rawProviders)]);
      const providers = [];

      for (const providerId of allIds) {
        const entry = engine.providerRegistry.get(providerId);
        const raw = rawProviders[providerId] || {};
        const creds = engine.resolveProviderCredentials(providerId);
        providers.push({
          id: providerId,
          displayName: entry?.displayName || providerId,
          api: raw.api || creds.api || entry?.api || "",
          baseUrl: raw.base_url || creds.base_url || entry?.baseUrl || "",
          base_url: raw.base_url || creds.base_url || entry?.baseUrl || "",
          hasCredentials: !!creds.api_key,
          isBuiltin: !!registered.get(providerId),
          isConfigured: Object.prototype.hasOwnProperty.call(rawProviders, providerId),
          models: raw.models || [],
        });
      }

      return { providers };
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:config", async ({ agentId }) => {
      if (!agentId) return { error: "agent_id_required" };
      if (typeof engine.getAgent !== "function") return { error: "agent_lookup_unavailable" };
      const agent = engine.getAgent(agentId);
      if (!agent) return { error: "not_found" };
      return { config: agent.config };
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:update-config", async ({ agentId, partial }) => {
      if (!agentId) return { error: "agent_id_required" };
      if (typeof engine.getAgent !== "function") return { error: "agent_lookup_unavailable" };
      const agent = engine.getAgent(agentId);
      if (!agent) return { error: "not_found" };
      if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
        return { error: "invalid_partial" };
      }
      await engine.updateConfig(partial, { agentId });
      const updated = engine.getAgent(agentId) || agent;
      return { config: updated.config };
    }));

    this._sessionHandlerCleanups.push(bus.handle("session:capability-drift:mark-stale", async (payload: any = {}) => {
      if (typeof engine.markCapabilitySnapshotsStale !== "function") {
        return { error: "capability_drift_unavailable" };
      }
      try {
        return engine.markCapabilitySnapshotsStale(payload);
      } catch (err) {
        return { error: err.message || String(err) };
      }
    }));

    this._sessionHandlerCleanups.push(bus.handle("channel:members", async ({ channelId, channelName } = {}) => {
      const id = String(channelId || channelName || "").trim();
      const filePath = safeChannelPath(id);
      const members = getChannelMembers(filePath);
      const memberRoles = getChannelMemberRoles(filePath);
      const agents = typeof engine.listAgents === "function" ? engine.listAgents() : [];
      const agentById = new Map(agents.map((agent) => [agent.id, agent]));
      return {
        channelId: id,
        members,
        memberRoles,
        roleCounts: channelRoleCounts(memberRoles),
        agents: members.map((memberId) => ({
          id: memberId,
          name: agentById.get(memberId)?.name || agentById.get(memberId)?.agentName || memberId,
          role: memberRoles[memberId] || "worker",
        })),
      };
    }));

    this._sessionHandlerCleanups.push(bus.handle("channel:post-message", async ({
      channelId,
      channelName,
      senderId,
      senderName,
      body,
      text,
      blocks,
      mentionedAgents,
      triggerDelivery = true,
    } = {}) => {
      if (engine.isChannelsEnabled && !engine.isChannelsEnabled()) {
        throw new Error("Channels are disabled");
      }
      const id = String(channelId || channelName || "").trim();
      const messageBody = String(body || text || "").trim();
      if (!messageBody) throw new Error("body is required");
      const filePath = safeChannelPath(id);
      const sender = String(senderName || senderId || "system").trim() || "system";
      const messageBlocks = Array.isArray(blocks)
        ? blocks.filter((block) => block && typeof block === "object" && typeof block.type === "string")
        : [];
      const result = appendChannelStoreMessage(filePath, sender, messageBody, { blocks: messageBlocks });
      const message = {
        sender,
        timestamp: result.timestamp,
        body: messageBody,
        ...(messageBlocks.length > 0 ? { blocks: messageBlocks } : {}),
      };
      const members = new Set(getChannelMembers(filePath));
      const explicitMentions = Array.isArray(mentionedAgents)
        ? mentionedAgents
            .map((agentId) => String(agentId || "").trim())
            .filter((agentId) => agentId && members.has(agentId))
        : [];
      const extractedMentions = explicitMentions.length > 0
        ? explicitMentions
        : this._channelRouter._extractMentionedAgents(id, message);
      const uniqueMentions = [...new Set(extractedMentions)];

      bus.emit({
        type: "channel_new_message",
        channelName: id,
        sender,
        message,
      }, null);

      if (triggerDelivery !== false) {
        this.triggerChannelDelivery(id, { mentionedAgents: uniqueMentions }).catch((err) => {
          console.error(`[channel] trigger delivery failed: ${err.message}`);
        });
      }

      return {
        ok: true,
        channelId: id,
        timestamp: result.timestamp,
        message,
        mentionedAgents: uniqueMentions,
      };
    }));

    this._sessionHandlerCleanups.push(bus.handle("bridge:send-text", async ({
      platform,
      chatId,
      text,
      agentId,
      replyContext,
      channelId,
      companyId,
    } = {}) => {
      if (!platform || !chatId || !text) {
        throw new Error("platform, chatId, and text are required");
      }
      const manager = this.bridgeManager;
      if (!manager || typeof manager.sendTextMessage !== "function") {
        throw new Error("bridge text delivery unavailable");
      }
      return manager.sendTextMessage(platform, chatId, text, agentId || null, {
        replyContext,
        channelId,
        companyId,
        isGroup: true,
      });
    }));
  }

  _setupDmHandler() {
    const engine = this._engine;
 //
    for (const [, agent] of engine.agents || []) {
      agent.setDmSentHandler((fromId, toId) =>
        this._dmRouter.handleNewDm(fromId, toId));
    }
  }

}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveRequestedModel(engine, raw) {
  if (!raw) return undefined;
  const models = engine?.availableModels || engine?._models?.availableModels || engine?.models?.availableModels || [];
  if (typeof raw === "string") {
    const model = models.find((item) => item?.id === raw || item?.modelId === raw);
    if (!model) throw new Error(`model not found: ${raw}`);
    return model;
  }
  if (raw && typeof raw === "object") {
    const id = raw.id || raw.modelId || raw.model;
    const provider = raw.provider || raw.providerId;
    if (!id) throw new Error("model.id is required");
    const model = provider
      ? findModel(models, id, provider)
      : models.find((item) => item?.id === id || item?.modelId === id);
    if (!model) throw new Error(`model not found: ${provider ? `${provider}/` : ""}${id}`);
    return model;
  }
  throw new Error("model must be a string or { id, provider } object");
}

function publicAgentProfile(agent) {
  const config = agent?.config || {};
  const plugin = config.plugin && typeof config.plugin === "object" ? config.plugin : {};
  return {
    id: agent?.id || null,
    name: agent?.agentName || config.agent?.name || agent?.name || agent?.id || null,
    yuan: config.agent?.yuan || "gsap",
    ownerPluginId: plugin.ownerPluginId || null,
    visibility: plugin.visibility || "public",
    identity: agent?.personality || agent?.identity || "",
    description: agent?.descriptionSource || "",
    memoryPolicy: {
      enabled: agent?.memoryMasterEnabled !== false,
    },
    experiencePolicy: {
      enabled: agent?.experienceEnabled === true,
    },
    toolPolicy: {
      disabled: Array.isArray(config.tools?.disabled) ? [...config.tools.disabled] : [],
    },
    models: config.models || {},
  };
}

function matchesAgentPhoneAbortFilter(meta = {}, filter = null) {
  if (!filter) return true;
  if (typeof filter === "function") return filter(meta);
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    if (meta?.[key] !== value) return false;
  }
  return true;
}

function resolveAgentForBus(engine, agentId) {
  if (!agentId) return { error: "agent_id_required" };
  if (typeof engine?.getAgent !== "function") return { error: "agent_lookup_unavailable" };
  const agent = engine.getAgent(agentId);
  if (!agent) return { error: "not_found" };
  return { agent };
}

function hasDisplayImageAttachments(displayMessage) {
  const attachments = displayMessage?.attachments;
  if (!Array.isArray(attachments)) return false;
  return attachments.some((attachment) => {
    if (!attachment?.path || attachment.isDir) return false;
    return inferFileKind({
      mime: attachment.mimeType,
      ext: extOfName(attachment.name || attachment.path),
      isDirectory: false,
    }) === "image";
  });
}

function hasDisplayVideoAttachments(displayMessage) {
  const attachments = displayMessage?.attachments;
  if (!Array.isArray(attachments)) return false;
  return attachments.some((attachment) => {
    if (!attachment?.path || attachment.isDir) return false;
    return inferFileKind({
      mime: attachment.mimeType,
      ext: extOfName(attachment.name || attachment.path),
      isDirectory: false,
    }) === "video";
  });
}

function extensionForVideoMime(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized === "video/webm") return ".webm";
  if (normalized === "video/quicktime") return ".mov";
  return ".mp4";
}
