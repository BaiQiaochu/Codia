// @ts-nocheck
/**
 * ChannelRouter dispatches internal channel messages through Hub.
 * It wraps channel-ticker and exposes callback-based routing methods.
 *
 * Mapped methods:
 *   _getChannelAgentOrder -> getAgentOrder()
 *   _executeChannelCheck -> _executeCheck()
 *   _executeChannelReply -> _executeReply()
 *   _channelMemorySummarize -> _memorySummarize()
 *   _setupChannelPostHandler -> setupPostHandler()
  *
 */

import fs from "fs";
import path from "path";
import { createChannelTicker } from "../lib/channels/channel-ticker.ts";
import { Type } from "../lib/pi-sdk/index.ts";
import {
  appendMessage,
  formatMessagesForLLM,
  getChannelMembers,
  getChannelMeta,
  getChannelMemberRoles,
  getRecentMessages,
} from "../lib/channels/channel-store.ts";
import { extractMentionedAgentIds } from "../lib/channels/channel-mentions.ts";
import {
  recordAgentPhoneActivity,
} from "../lib/conversations/agent-phone-projection.ts";
import {
  readAgentPhoneRuntime,
  resolveAgentPhoneRuntimeSessionPath,
} from "../lib/conversations/agent-phone-runtime.ts";
import { normalizeToolRuntimeContext } from "../lib/tools/tool-session.ts";
import { normalizeAgentPhoneToolMode } from "../lib/conversations/agent-phone-session.ts";
import {
  DEFAULT_AGENT_PHONE_SETTINGS,
  formatAgentPhonePromptGuidance,
  normalizeAgentPhoneModelOverride,
  positiveIntegerOrDefault,
  positiveIntegerOrNull,
} from "../lib/conversations/agent-phone-prompt.ts";
import { loadConfig } from "../lib/memory/config-loader.ts";
import { callText } from "../core/llm-client.ts";
import { runAgentPhoneSession, runAgentSession } from "./agent-executor.ts";
import { createModuleLogger, debugLog } from "../lib/debug-log.ts";
import { getLocale } from "../lib/i18n.ts";
import { extractBlocks, resolveMediaGenerationBlocksWithDeferredResults } from "../server/block-extractors.ts";

const log = createModuleLogger("channel");
const CHANNEL_STATIC_BLOCK_TYPES = new Set([
  "file",
  "artifact",
  "screenshot",
  "media_generation",
  "skill",
  "plugin_card",
  "cron_confirm",
  "settings_confirm",
  "session_confirmation",
  "subagent",
]);

const CHANNEL_ROLE_LABELS_ZH = {
  project_manager: "项目经理",
  admin: "管理员",
  worker: "工人",
};

const CHANNEL_ROLE_LABELS_EN = {
  project_manager: "Project manager",
  admin: "Admin",
  worker: "Worker",
};

function normalizeChannelRole(role) {
  return ["project_manager", "admin", "worker"].includes(role) ? role : "worker";
}

function formatRoleList(memberRoles, isZh) {
  const labels = isZh ? CHANNEL_ROLE_LABELS_ZH : CHANNEL_ROLE_LABELS_EN;
  return Object.entries(memberRoles || {})
    .map(([memberId, memberRole]) => {
      const role = normalizeChannelRole(memberRole);
      return `- ${memberId}: ${role} (${labels[role]})`;
    })
    .join("\n");
}

function annotateChannelBlock(block, sessionPath) {
  if (!block || typeof block !== "object" || !CHANNEL_STATIC_BLOCK_TYPES.has(block.type)) return null;
  return {
    ...block,
    ...(sessionPath ? { sessionPath } : {}),
  };
}

function replacementTaskId(block) {
  if (block?.type === "file") return block.replacesTaskId || null;
  if (block?.type === "media_generation" && block.status !== "pending") return block.taskId || null;
  return null;
}

function mergeChannelOutputBlock(blocks, block) {
  if (!block) return blocks;
  if (block.type === "media_generation" && block.status === "pending") {
    const resolved = blocks.some((existing) => replacementTaskId(existing) === block.taskId);
    if (resolved) return blocks;
  }
  const taskId = replacementTaskId(block);
  if (!taskId) return [...blocks, block];
  const idx = blocks.findIndex((existing) => (
    existing.type === "media_generation" && existing.taskId === taskId
  ));
  if (idx < 0) return [...blocks, block];
  const next = [...blocks];
  next[idx] = block;
  return next;
}

function cloneChannelOutputBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  return JSON.parse(JSON.stringify(blocks));
}

function prepareChannelOutputBlocks(blocks, deferredResults) {
  const cloned = cloneChannelOutputBlocks(blocks);
  return resolveMediaGenerationBlocksWithDeferredResults(cloned, deferredResults);
}

export class ChannelRouter {
  /**
   * @param {object} opts
   * @param {import('./index.ts').Hub} opts.hub
   */
  static _AGENT_ORDER_TTL = 30_000; // 30 绉?
  constructor({ hub }) {
    this._hub = hub;
    this._ticker = null;
    this._agentOrderCache = null; // { list: string[], ts: number }
  }

  /** @returns {import('../core/engine.ts').CodiaEngine} */
  get _engine() { return this._hub.engine; }

  _getAgentInstance(agentId) {
    return this._engine.getAgent?.(agentId)
      || this._engine.agents?.get?.(agentId)
      || null;
  }

  _resolveMemoryMasterEnabled(agentId, { agentInstance = null, cfg = null } = {}) {
    if (agentInstance) return agentInstance.memoryMasterEnabled !== false;
    const resolvedCfg = cfg || loadConfig(path.join(this._engine.agentsDir, agentId, "config.yaml"));
    return resolvedCfg?.memory?.enabled !== false;
  }

  async _recordPhoneActivity(agentId, channelName, state, summary, details = {}) {
    try {
      const agent = this._getAgentInstance(agentId);
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      const activity = {
        conversationId: channelName,
        conversationType: "channel",
        agentId,
        state,
        summary,
        details,
      };
      this._hub.agentPhoneActivities?.record?.(activity);
      await recordAgentPhoneActivity({
        agentDir,
        ...activity,
      });
    } catch (err) {
      debugLog()?.warn?.("channel", `phone activity record failed (${agentId}/#${channelName}): ${err.message}`);
    }
  }

  _resolveChannelPhoneSettings(channelName) {
    try {
      const filePath = path.join(this._engine.channelsDir || "", `${channelName}.md`);
      if (!fs.existsSync(filePath)) return DEFAULT_AGENT_PHONE_SETTINGS;
      const meta = getChannelMeta(filePath);
      const override = normalizeAgentPhoneModelOverride({
        enabled: meta.agentPhoneModelOverrideEnabled,
        id: meta.agentPhoneModelOverrideId,
        provider: meta.agentPhoneModelOverrideProvider,
      });
      return {
        toolMode: normalizeAgentPhoneToolMode(meta.agentPhoneToolMode),
        replyMinChars: positiveIntegerOrNull(meta.agentPhoneReplyMinChars),
        replyMaxChars: positiveIntegerOrNull(meta.agentPhoneReplyMaxChars),
        proactiveEnabled: meta.agentPhoneProactiveEnabled !== "false",
        reminderIntervalMinutes: positiveIntegerOrDefault(
          meta.agentPhoneReminderIntervalMinutes,
          DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes,
        ),
        guardLimit: positiveIntegerOrDefault(
          meta.agentPhoneGuardLimit,
          DEFAULT_AGENT_PHONE_SETTINGS.guardLimit,
        ),
        modelOverrideEnabled: override.enabled,
        modelOverrideModel: override.model,
      };
    } catch {
      return DEFAULT_AGENT_PHONE_SETTINGS;
    }
  }

  _formatPhonePromptGuidance(agentId, settings, isZh) {
    if (!isZh) {
      return formatAgentPhonePromptGuidance({
        agentId,
        agent: this._getAgentInstance(agentId),
        agentsDir: this._engine.agentsDir,
        settings,
        enConversationName: "channel",
      });
    }

    const lines = [
      "- 私有反思只记录在手机动态里，不会发送到群聊。",
      "- 实际发到群聊的正文要像即时聊天，优先口语化；只有需要步骤、代码或精确信息时才使用结构化表达。",
    ];
    if (settings.replyMinChars || settings.replyMaxChars) {
      const range = settings.replyMinChars && settings.replyMaxChars
        ? `${settings.replyMinChars} 到 ${settings.replyMaxChars} 字`
        : settings.replyMinChars
          ? `至少 ${settings.replyMinChars} 字`
          : `不超过 ${settings.replyMaxChars} 字`;
      lines.push(`- 这个频道希望实际发送的回复正文${range}，这是写作约束，不会改变模型输出预算。`);
    }
    return lines.join("\n");
  }

  _resolvePhoneSessionPath(agentId, channelName) {
    try {
      const agent = this._getAgentInstance(agentId);
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      return resolveAgentPhoneRuntimeSessionPath(agentDir, readAgentPhoneRuntime(agentDir, channelName));
    } catch {
      return null;
    }
  }

  _createChannelPhoneTools(agentId, channelName, { setDecision, getOutputBlocks } = {}) {
    const engine = this._engine;
    const isZh = getLocale().startsWith("zh");
    const channelFile = path.join(engine.channelsDir || "", `${channelName}.md`);
    let decided = false;

    const markDecision = (decision) => {
      if (decided) return false;
      decided = true;
      setDecision?.(decision);
      return true;
    };
    const isCurrentMember = () => {
      if (!fs.existsSync(channelFile)) return false;
      return getChannelMembers(channelFile).includes(agentId);
    };
    const notMemberResult = (action) => ({
      content: [{
        type: "text",
        text: isZh ? "操作失败：你已不在这个频道中。" : "Action failed: you are no longer a member of this channel.",
      }],
      details: { action, error: "not a channel member" },
    });

    return [
      {
        name: "channel_read_context",
        label: isZh ? "读取频道上下文" : "Read channel context",
        description: isZh
          ? "读取当前群聊频道的最近消息。数据源是频道聊天记录 Truth，不是本轮 phone session。"
          : "Read recent messages from the current channel. The source is the channel transcript Truth, not this phone session.",
        parameters: Type.Object({
          count: Type.Optional(Type.Number({
            description: isZh ? "要读取的最近消息数量，默认 20，最多 50。" : "Number of recent messages to read, defaults to 20, max 50.",
          })),
        }),
        execute: async (_toolCallId, params = {}) => {
          if (!fs.existsSync(channelFile)) {
            return {
              content: [{ type: "text", text: isZh ? "频道不存在。" : "Channel not found." }],
              details: { action: "read_context", error: "channel not found" },
            };
          }
          if (!isCurrentMember()) return notMemberResult("read_context");
          const count = Math.max(1, Math.min(50, Number(params.count) || 20));
          const messages = getRecentMessages(channelFile, count);
          return {
            content: [{
              type: "text",
              text: messages.length > 0
                ? formatMessagesForLLM(messages)
                : (isZh ? "频道暂无消息。" : "No channel messages."),
            }],
            details: { action: "read_context", channel: channelName, messageCount: messages.length },
          };
        },
      },
      {
        name: "channel_reply",
        label: isZh ? "发送频道消息" : "Send channel message",
        description: isZh
          ? "把本轮回复发送到当前频道。只有这个工具的 content 会写入群聊；普通生成文本只留在手机动态里。"
          : "Send this turn's reply to the current channel. Only this tool's content is posted; ordinary generated text stays in phone activity.",
        parameters: Type.Object({
          content: Type.String({
            description: isZh ? "要发送到频道的正文。不要包含 mood、解释或工具调用说明。" : "Message body to post. Do not include mood, explanations, or tool-call notes.",
          }),
          mood: Type.Optional(Type.String({
            description: isZh ? "可选：本次发言前的私有反思摘要，只记录在工具详情中，不发送到频道。" : "Optional private mood summary. Stored in tool details, not posted.",
          })),
        }),
        execute: async (_toolCallId, params = {}) => {
          const content = String(params.content || "").trim();
          if (!content) {
            return {
              content: [{ type: "text", text: isZh ? "发送失败：content 为空。" : "Send failed: content is empty." }],
              details: { action: "reply", error: "empty content" },
            };
          }
          if (decided) {
            return {
              content: [{ type: "text", text: isZh ? "本轮已经完成过频道决定。" : "This phone turn already made a channel decision." }],
              details: { action: "reply", error: "already decided" },
            };
          }
          if (engine.isChannelsEnabled && !engine.isChannelsEnabled()) {
            return {
              content: [{ type: "text", text: isZh ? "发送失败：频道功能已关闭。" : "Send failed: channels are disabled." }],
              details: { action: "reply", error: "channels disabled" },
            };
          }
          if (!fs.existsSync(channelFile)) {
            return {
              content: [{ type: "text", text: isZh ? "发送失败：频道不存在。" : "Send failed: channel not found." }],
              details: { action: "reply", error: "channel not found" },
            };
          }
          if (!isCurrentMember()) return notMemberResult("reply");

          const outputBlocks = prepareChannelOutputBlocks(getOutputBlocks?.() || [], engine.deferredResults);
          const { timestamp } = appendMessage(
            channelFile,
            agentId,
            content,
            outputBlocks.length > 0 ? { blocks: outputBlocks } : {},
          );
          const decision = {
            type: "reply",
            replied: true,
            replyContent: content,
            timestamp,
            blocks: outputBlocks,
            mood: typeof params.mood === "string" ? params.mood : null,
          };
          markDecision(decision);

          this._hub.eventBus.emit({
            type: "channel_new_message",
            channelName,
            sender: agentId,
            message: {
              sender: agentId,
              timestamp,
              body: content,
              ...(outputBlocks.length > 0 ? { blocks: outputBlocks } : {}),
            },
          }, null);

          return {
            content: [{ type: "text", text: isZh ? `已发送到 #${channelName}` : `Posted to #${channelName}` }],
            details: { action: "reply", channel: channelName, timestamp, mood: decision.mood, blocks: outputBlocks },
          };
        },
      },
      {
        name: "channel_pass",
        label: isZh ? "本轮不发言" : "Pass this turn",
        description: isZh
          ? "表示你已经看过这批群聊消息，但本轮选择不在频道发言。"
          : "Mark these channel messages as seen while choosing not to post this turn.",
        parameters: Type.Object({
          reason: Type.Optional(Type.String({
            description: isZh ? "简短说明为什么本轮不发言。" : "Brief reason for not posting this turn.",
          })),
          mood: Type.Optional(Type.String({
            description: isZh ? "可选：本次判断的私有反思摘要。" : "Optional private mood summary for this decision.",
          })),
        }),
        execute: async (_toolCallId, params = {}) => {
          if (decided) {
            return {
              content: [{ type: "text", text: isZh ? "本轮已经完成过频道决定。" : "This phone turn already made a channel decision." }],
              details: { action: "pass", error: "already decided" },
            };
          }
          const decision = {
            type: "pass",
            replied: false,
            passed: true,
            reason: typeof params.reason === "string" ? params.reason : "",
            mood: typeof params.mood === "string" ? params.mood : null,
          };
          if (fs.existsSync(channelFile) && !isCurrentMember()) return notMemberResult("pass");
          markDecision(decision);
          return {
            content: [{ type: "text", text: isZh ? "已标记为本轮不发言。" : "Marked as pass for this turn." }],
            details: { action: "pass", channel: channelName, reason: decision.reason, mood: decision.mood },
          };
        },
      },
    ];
  }

  _createCompanyChannelTools(agentId, channelName) {
    const assignTool = this._engine.pluginManager?.getPluginTool?.("company", "assign");
    const reportTool = this._engine.pluginManager?.getPluginTool?.("company", "report");
    const tools = [];
    let role = "";
    try {
      const channelFile = path.join(this._engine.channelsDir || "", `${channelName}.md`);
      if (fs.existsSync(channelFile)) {
        const memberRoles = getChannelMemberRoles(channelFile);
        role = memberRoles?.[agentId] || "";
      }
    } catch {
      // If role metadata is unavailable, keep the tool visible so legacy
      // channels can still dispatch company tasks.
    }

    const isZh = getLocale().startsWith("zh");
    const roleLabel = (isZh ? CHANNEL_ROLE_LABELS_ZH : CHANNEL_ROLE_LABELS_EN)[normalizeChannelRole(role)];
    const reportDescription = isZh
      ? role === "project_manager"
        ? "回写你负责的拆解、调度或阶段总结任务状态。项目经理先用 company_assign 派发，再用 company_report 记录自己的推进/总结。"
        : role === "admin"
          ? "回写流程复核、阻塞记录、失败原因和待验收输出。管理员负责监督与汇总，不创建新的任务树。"
          : "回写你被分派的执行任务状态、产物、阻塞或完成结果。工人先执行，再用 company_report 同步进展。"
      : role === "project_manager"
        ? "Update your planning, dispatch, or summary task state. Project managers dispatch with company_assign first, then report their own progress here."
        : role === "admin"
          ? "Update review status, blockers, failure reasons, and outputs waiting for acceptance. Admins supervise and summarize; they do not create new task trees."
          : "Update your assigned execution task status, artifacts, blockers, or completion result. Workers execute first, then report progress here.";
    const wrapCompanyTool = (pluginTool, name, description) => ({
      ...pluginTool,
      name,
      description,
      execute: async (toolCallId, params = {}, signalOrRuntimeCtx, _onUpdate, piCtx) => {
        const { ctx: runtimeCtx } = normalizeToolRuntimeContext(signalOrRuntimeCtx, piCtx);
        const nextParams = {
          ...(params && typeof params === "object" ? params : {}),
          channelId: String(params?.channelId || channelName).trim() || channelName,
        };
        return pluginTool.execute(toolCallId, nextParams, {
          ...runtimeCtx,
          agentId,
          channelId: nextParams.channelId,
          channelName,
          conversationId: channelName,
          conversationType: "channel",
        });
      },
    });

    if ((!role || role === "project_manager") && assignTool && typeof assignTool.execute === "function") {
      tools.push(wrapCompanyTool(
        assignTool,
        "company_assign",
        isZh
          ? "把老板命令拆成一人公司任务树并自动写入当前频道，随后提醒被分派的频道成员执行。channelId 省略时固定使用当前频道。"
          : "Split a boss command into a company task tree, post it into the current channel, and notify assigned channel members. Defaults channelId to the current channel.",
      ));
    }

    if (reportTool && typeof reportTool.execute === "function") {
      tools.push(wrapCompanyTool(
        reportTool,
        "company_report",
        `${reportDescription} ${isZh ? `当前频道角色：${roleLabel}。` : `Current channel role: ${roleLabel}.`}`,
      ));
    }

    return tools;
  }

 //

  start() {
    const engine = this._engine;
    if (!engine.channelsDir) return;
    if (this.getAgentOrder().length === 0) return;
    if (this._ticker) return;

    this._ticker = createChannelTicker({
      channelsDir: engine.channelsDir,
      agentsDir: engine.agentsDir,
      getAgentOrder: () => this.getAgentOrder(),
      executeCheck: (agentId, channelName, newMessages, allUpdates, opts) =>
        this._executeCheck(agentId, channelName, newMessages, allUpdates, opts),
      onMemorySummarize: (agentId, channelName, contextText) =>
        this._memorySummarize(agentId, channelName, contextText),
      onEvent: (event, data) => {
        this._hub.eventBus.emit({ type: event, ...data }, null);
      },
    });
    this._ticker.start();
  }

  ensureStarted() {
    if (this._ticker) return true;
    if (this._engine.isChannelsEnabled && !this._engine.isChannelsEnabled()) return false;
    this.start();
    this.setupPostHandler();
    return !!this._ticker;
  }

  async stop() {
    if (this._ticker) {
      await this._ticker.stop();
      this._ticker = null;
    }
  }

  async toggle(enabled) {
    if (enabled) {
      if (this._ticker) return;
      this.start();
      this.setupPostHandler();
    } else {
      await this.stop();
    }
  }

  triggerImmediate(channelName, opts) {
    this.ensureStarted();
    return this._ticker?.triggerImmediate(channelName, opts) || Promise.resolve();
  }

  refreshProactiveSchedule() {
    if (!this.ensureStarted()) return;
    this._ticker?.refreshSchedule?.();
  }

  tickerSnapshot(channelName) {
    if (!this.ensureStarted()) return null;
    return this._ticker?.snapshot?.(channelName) || null;
  }

  _listMentionableAgents() {
    if (typeof this._engine.listAgents === "function") {
      return this._engine.listAgents();
    }
    return this.getAgentOrder().map((id) => {
      const agent = this._getAgentInstance(id);
      return {
        id,
        name: agent?.agentName || agent?.config?.agent?.name || id,
        agentName: agent?.agentName,
      };
    });
  }

  _extractMentionedAgents(channelName, message) {
    const text = typeof message === "string" ? message : (message?.body || message?.text);
    if (!text) return [];
    const channelFile = path.join(this._engine.channelsDir || "", `${channelName}.md`);
    const meta = getChannelMeta(channelFile);
    return extractMentionedAgentIds(text, {
      channelMembers: Array.isArray(meta.members) ? meta.members : [],
      agents: this._listMentionableAgents(),
    });
  }

  async syncAvailability() {
    this._agentOrderCache = null;
    const hasRunnableAgents = this.getAgentOrder().length > 0;
    if (!hasRunnableAgents) {
      await this.stop();
      return;
    }
    if (!this._ticker) {
      this.start();
      this.setupPostHandler();
    }
  }

  /**
    *
  *
   */
  setupPostHandler() {
    for (const [, agent] of this._engine.agents || []) {
      agent.setChannelPostHandler((channelName, senderId, message) => {
        debugLog()?.log("channel", `agent ${senderId} posted to #${channelName}, triggering phone delivery`);
        if (message) {
          this._hub.eventBus.emit({
            type: "channel_new_message",
            channelName,
            sender: senderId,
            message,
          }, null);
        }
        const mentionedAgents = this._extractMentionedAgents(channelName, message)
          .filter((agentId) => agentId !== senderId);
        if (mentionedAgents.length === 0) {
          debugLog()?.log("channel", `agent ${senderId} post has no target mentions; skip immediate fan-out`);
          return;
        }
        this.triggerImmediate(channelName, {
          mentionedAgents,
          triggerSource: "agent_post",
          sourceAgentId: senderId,
        })?.catch(err =>
          log.error(`agent post delivery failed: ${err.message}`)
        );
      });
    }
  }

  // ──────────── 频道 Agent 顺序 ────────────

 /** 获取参与频道轮转-agent 列表（只含有 channels.md 的，30s TTL 缓存-*/
  getAgentOrder() {
    const now = Date.now();
    if (this._agentOrderCache && now - this._agentOrderCache.ts < ChannelRouter._AGENT_ORDER_TTL) {
      return this._agentOrderCache.list;
    }
    try {
      const entries = fs.readdirSync(this._engine.agentsDir, { withFileTypes: true });
      const list = entries
        .filter(e => e.isDirectory())
        .filter(e => {
          const agentDir = path.join(this._engine.agentsDir, e.name);
          return fs.existsSync(path.join(agentDir, "config.yaml"))
            || fs.existsSync(path.join(agentDir, "channels.md"));
        })
        .filter(e => typeof this._engine.canRunBackgroundTask !== "function" || this._engine.canRunBackgroundTask(e.name))
        .map(e => e.name);
      this._agentOrderCache = { list, ts: now };
      return list;
    } catch {
      return [];
    }
  }

  // ──────────── Triage + Reply ────────────

  async _executePhoneCheck(agentId, channelName, newMessages, msgText, {
    signal,
    proactive = false,
    mentionedAgents = [],
    mentionTargeted = false,
    deliveryWindow = null,
  } = {}) {
    const isZh = getLocale().startsWith("zh");
    try {
      await this._recordPhoneActivity(
        agentId,
        channelName,
        "replying",
        proactive
          ? (isZh ? "收到频道提醒，正在查看群聊" : "Received channel reminder and is reading")
          : (isZh ? "正在查看群聊消息" : "Reading channel messages"),
        {
          messageCount: newMessages.length,
          proactive,
          totalUnreadCount: deliveryWindow?.totalUnreadCount ?? newMessages.length,
          droppedUnreadCount: deliveryWindow?.droppedUnreadCount ?? 0,
        },
      );

      const channelFile = path.join(this._engine.channelsDir || "", `${channelName}.md`);
      const memberRoles = getChannelMemberRoles(channelFile);
      const roleContext = this._buildRoleContext(agentId, channelName, memberRoles);
      const decision = await this._executeReply(agentId, channelName, msgText, {
        signal,
        messageCount: newMessages.length,
        deliveryWindow,
        proactive,
        mentionedAgents,
        mentionTargeted,
        roleContext,
      });

      const sessionPath = this._resolvePhoneSessionPath(agentId, channelName);
      if (decision?.replied) {
        log.log(`${agentId} replied #${channelName} (${decision.replyContent.length} chars)`);
        await this._recordPhoneActivity(
          agentId,
          channelName,
          "idle",
          isZh ? "已回复" : "Replied",
          {
            replyTimestamp: decision.timestamp,
            ...(decision.mood ? { mood: decision.mood } : {}),
            ...(sessionPath ? { sessionPath } : {}),
          },
        );
        return { replied: true, replyContent: decision.replyContent };
      }

      if (decision?.passed) {
        await this._recordPhoneActivity(
          agentId,
          channelName,
          "no_reply",
          isZh ? "已查看，选择不发言" : "Viewed and chose not to post",
          {
            messageCount: newMessages.length,
            ...(decision.reason ? { reason: decision.reason } : {}),
            ...(decision.mood ? { mood: decision.mood } : {}),
            ...(sessionPath ? { sessionPath } : {}),
          },
        );
        return { replied: false, passed: true };
      }

      await this._recordPhoneActivity(
        agentId,
        channelName,
        "error",
        isZh ? "没有调用频道回复工具" : "Did not call a channel decision tool",
        {
          messageCount: newMessages.length,
          ...(sessionPath ? { sessionPath } : {}),
        },
      );
      return { replied: false, missingDecision: true };
    } catch (err) {
      log.error(`reply failed (${agentId}/#${channelName}): ${err.message}`);
      await this._recordPhoneActivity(
        agentId,
        channelName,
        "error",
        isZh ? "处理频道消息失败" : "Failed to process channel messages",
        { error: err.message },
      );
      return { replied: false };
    }
  }

  /**
  *
    *
   */
  async _executeCheck(agentId, channelName, newMessages, _allChannelUpdates, {
    signal,
    proactive = false,
    mentionedAgents = [],
    mentionTargeted = false,
    deliveryWindow = null,
  } = {}) {
    const engine = this._engine;
    const msgText = formatMessagesForLLM(newMessages);
    const isZh = getLocale().startsWith("zh");
    const lastNewMessage = newMessages[newMessages.length - 1] || null;
    await this._recordPhoneActivity(
      agentId,
      channelName,
      "viewed",
      isZh ? `已查看 ${newMessages.length} 条新频道消息` : `Viewed ${newMessages.length} new channel message(s)`,
      {
        messageCount: newMessages.length,
        totalUnreadCount: deliveryWindow?.totalUnreadCount ?? newMessages.length,
        droppedUnreadCount: deliveryWindow?.droppedUnreadCount ?? 0,
        bookmarkState: deliveryWindow?.bookmarkState ?? null,
        lastMessageTimestamp: lastNewMessage?.timestamp || null,
      },
    );
    if (this._usePhoneDelivery !== false) {
      return this._executePhoneCheck(agentId, channelName, newMessages, msgText, {
        signal,
        proactive,
        mentionedAgents,
        mentionTargeted,
        deliveryWindow,
      });
    }
    const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
    const memberRoles = getChannelMemberRoles(channelFile);
    const roleContext = this._buildRoleContext(agentId, channelName, memberRoles);

 //
    const readFile = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
    const agentDir = path.join(engine.agentsDir, agentId);

 // 复用 Agent 实例-personality（identity + yuan + ishiki 已在内存中组装）
    const agentInstance = engine.agents?.get(agentId);
    const cfg = agentInstance?.config || loadConfig(path.join(agentDir, "config.yaml"));
    const agentName = cfg.agent?.name || agentId;

    const agentContext = agentInstance?.personality
      || [readFile(path.join(agentDir, "identity.md")),
          readFile(path.join(engine.productDir, "yuan", `${cfg.agent?.yuan || "codia"}.md`)),
          readFile(path.join(agentDir, "ishiki.md"))].filter(Boolean).join("\n\n");

    // Memory and user profile can change at runtime; read them from disk.
    const memoryMd = readFile(path.join(agentDir, "memory", "memory.md"));
    const userMd = readFile(path.join(engine.userDir, "user.md"));
    const memoryContext = memoryMd?.trim()
      ? (isZh ? `\n\n你的记忆：\n${memoryMd}` : `\n\nYour memory:\n${memoryMd}`)
      : "";
    const userContext = userMd?.trim()
      ? (isZh ? `\n\n用户档案：\n${userMd}` : `\n\nUser profile:\n${userMd}`)
      : "";

    //
    const isMentioned = mentionTargeted || msgText.includes(`@${agentName}`) || msgText.includes(`@${agentId}`);

    // ── Step 1: Triage ──
    let shouldReply = isMentioned;

    if (!shouldReply) {
      try {
        const utilCfg = engine.resolveUtilityConfig({ agentId }) || {};
        const { utility_large: model, large_api_key: api_key, large_base_url: base_url, large_api: api } = utilCfg;
        if (api_key && base_url && api) {
          const triageSystem = agentContext + memoryContext + userContext + roleContext
            + "\n\n---\n\n"
            + (isZh
              ? "你在一个群聊频道里。阅读以下最近的消息，判断你是否要回复。\n"
                + "回答 YES 的情况：有人跟你说话、@你、问了你能回答的问题，或者你有想说的话。\n"
                + "回答 NO 的情况：别人已经充分回答了问题（你没有新的补充）、话题与你无关、你插不上话，或者你刚回复过且没人追问你。\n"
                + "只回答 YES 或 NO。"
              : "You are in a group chat channel. Read the recent messages below and decide whether you should reply.\n"
                + "Answer YES if: someone is talking to you, @-mentions you, asks a question you can answer, or you have something to say.\n"
                + "Answer NO if: the question has already been adequately answered (you have nothing new to add), the topic is irrelevant to you, you can't contribute, or you just replied and no one followed up.\n"
                + "Answer only YES or NO.");

          const triageTimeout = AbortSignal.timeout(10_000);
          const triageSignal = signal
            ? AbortSignal.any([signal, triageTimeout])
            : triageTimeout;
          const answer = await callText({
            api, model,
            apiKey: api_key,
            baseUrl: base_url,
            systemPrompt: triageSystem,
            messages: [{ role: "user", content: isZh ? `#${channelName} \u9891\u9053\u6700\u8fd1\u6d88\u606f\uff1a\n${msgText}` : `#${channelName} recent messages:\n${msgText}` }],
            temperature: 0,
            maxTokens: 10,
            timeoutMs: 10_000,
            signal: triageSignal,
            usageLedger: utilCfg.usageLedger ?? engine.usageLedger,
            usageContext: {
              source: {
                subsystem: "channel",
                operation: "channel_triage",
                surface: "channel",
                trigger: "scheduled",
              },
              attribution: {
                kind: "memory",
                agentId,
              },
            },
          });
          shouldReply = answer.trim().toUpperCase().includes("YES");
        } else {
 // utility_large 凭证不完整，跳过 triage 直接回复
          shouldReply = true;
        }
      } catch (err) {
 // utility 模型未配置或 triage 调用失败 -默认回复（让 agent 自己-reply 阶段判断要不要说话）
        console.warn(`[channel] triage unavailable, defaulting to reply (${agentId}/#${channelName}): ${err.message}`);
        shouldReply = true;
      }
    }

    console.log(`\x1b[90m[channel] triage ${agentId}/#${channelName}: ${shouldReply ? "YES" : "NO"}${isMentioned ? " (@)" : ""}\x1b[0m`);
    debugLog()?.log("channel", `triage ${agentId}/#${channelName}: ${shouldReply ? "YES" : "NO"}${isMentioned ? " (mentioned)" : ""} (${newMessages.length} msgs)`);

    if (!shouldReply) {
      await this._recordPhoneActivity(
        agentId,
        channelName,
        "no_reply",
        "Viewed and chose not to post",
        { messageCount: newMessages.length },
      );
      return { replied: false };
    }

 //
    try {
      await this._recordPhoneActivity(
        agentId,
        channelName,
        "replying",
        "Reading channel messages",
        { messageCount: newMessages.length },
      );
      const replyText = await this._executeReply(agentId, channelName, msgText, roleContext, { signal });

      if (!replyText) {
        console.log(`\x1b[90m[channel] ${agentId} empty reply (#${channelName})\x1b[0m`);
        await this._recordPhoneActivity(
          agentId,
          channelName,
          "no_reply",
          "Viewed and chose not to post",
          { messageCount: newMessages.length },
        );
        return { replied: false };
      }

      // Write the reply into the channel file.
      appendMessage(channelFile, agentId, replyText);

      console.log(`\x1b[90m[channel] ${agentId} replied #${channelName} (${replyText.length} chars)\x1b[0m`);
      debugLog()?.log("channel", `${agentId} replied #${channelName} (${replyText.length} chars)`);
      await this._recordPhoneActivity(
        agentId,
        channelName,
        "idle",
        "Replied",
        { messageCount: newMessages.length },
      );

      // Broadcast the new channel message to connected clients.
      this._hub.eventBus.emit({ type: "channel_new_message", channelName, sender: agentId }, null);

      return { replied: true, replyContent: replyText };
    } catch (err) {
      console.error(`[channel] reply failed (${agentId}/#${channelName}): ${err.message}`);
      debugLog()?.error("channel", `reply failed (${agentId}/#${channelName}): ${err.message}`);
      await this._recordPhoneActivity(
        agentId,
        channelName,
        "error",
        "Failed to process channel messages",
        { error: err.message },
      );
      return { replied: false };
    }
  }

  /**
 * 两轮 Agent Session 生成频道回复
   */
  _formatMentionGuidance(agentId, mentionedAgents, mentionTargeted, isZh) {
    const ids = Array.from(new Set(
      Array.isArray(mentionedAgents)
        ? mentionedAgents.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim())
        : [],
    ));
    if (ids.length === 0) return "";

    const names = ids
      .map((id) => this._resolveChannelMemorySenderName(id, isZh))
      .filter(Boolean)
      .join(isZh ? "、" : ", ");
    if (mentionTargeted || ids.includes(agentId)) {
      return isZh
        ? [
          `- 这轮消息明确 @ 了你（${names || agentId}），你是本轮优先被提醒的成员。`,
          "- 判断是否需要回应；如果只是确认收到或暂时不需要发言，也可以调用 channel_pass。",
        ].join("\n")
        : [
          `- This turn explicitly @mentioned you (${names || agentId}); you were prioritized for this channel check.`,
          "- Decide whether a reply is useful; if there is nothing to add, call channel_pass.",
        ].join("\n");
    }

    return isZh
      ? [
        `- 这轮消息明确 @ 了 ${names || ids.join("、")}，你也能看到这段频道 Truth，但不要抢答。`,
        "- 除非你确实需要补充、纠错或推进话题，否则调用 channel_pass。",
      ].join("\n")
      : [
        `- This turn explicitly @mentioned ${names || ids.join(", ")}. You can still see this channel Truth, but do not steal the reply.`,
        "- Unless you truly need to add context, correct something, or move the topic forward, call channel_pass.",
      ].join("\n");
  }

  _isCompanyTaskAssignmentText(text) {
    return /company\s+tasks?\s+assigned|company_task_assigned|公司任务.*分派|任务已分派|任务卡/i
      .test(String(text || ""));
  }

  _formatCompanyTaskGuidance(agentId, msgText, mentionTargeted, isZh) {
    if (!mentionTargeted || !this._isCompanyTaskAssignmentText(msgText)) return "";
    return isZh
      ? [
        "- 这轮是“一人公司”插件写入频道的任务卡。你被 @ 时，应把它当作分派给自己的可执行任务。",
        "- 结合你的频道角色直接处理任务，能给结果就给结果；不能立即完成时，回复已接单、下一步和阻塞。",
        "- 当你有进展、完成结果或阻塞时，先调用 company_report 更新任务状态，再用 channel_reply 给频道同步简短结论。",
        "- 不要声称一人公司插件不能调度 agent，也不要把任务退回成手动模拟流程。",
      ].join("\n")
      : [
        "- This turn is a company task card posted into the channel. When you are @mentioned, treat it as an executable assignment for you.",
        "- Work according to your channel role: provide the result if you can, otherwise reply with acceptance, next step, and blockers.",
        "- When you have progress, a result, or a blocker, call company_report first, then use channel_reply to post a short channel update.",
        "- Do not claim the company plugin cannot dispatch agents, and do not downgrade the assignment into a manual simulation flow.",
      ].join("\n");
  }

  _formatChannelBehaviorGuidance(agentId, mentionedAgents, mentionTargeted, isZh, msgText = "") {
    const companyTaskGuidance = this._formatCompanyTaskGuidance(agentId, msgText, mentionTargeted, isZh);
    const mentionGuidance = this._formatMentionGuidance(agentId, mentionedAgents, mentionTargeted, isZh);
    if (companyTaskGuidance && mentionGuidance) return `${companyTaskGuidance}\n${mentionGuidance}`;
    if (companyTaskGuidance) return companyTaskGuidance;
    if (mentionGuidance) return mentionGuidance;
    return isZh
      ? [
        "- 你可以因为被问到、被提到、想补充、想推进话题、表达情绪、主动开启话题或觉得有价值而发言。",
        "- 不需要只在事情与你直接相关时才发言。",
      ].join("\n")
      : [
        "- You may post because you were asked, mentioned, have something useful to add, want to move the topic, want to start a topic, or feel it is worth saying.",
        "- You do not need the topic to be directly about you.",
      ].join("\n");
  }

  _formatChannelIdentityGuidance(agentId, channelName, isZh) {
    const speaker = this._resolveChannelMemorySenderName(agentId, isZh);
    const channelFile = path.join(this._engine.channelsDir || "", `${channelName}.md`);
    let members = [];
    try {
      const meta = getChannelMeta(channelFile);
      members = Array.isArray(meta?.members) ? meta.members : getChannelMembers(channelFile);
    } catch {
      members = [];
    }

    if (members.length === 0) {
      return isZh
        ? `You are the speaker ${speaker}. Only represent ${speaker}; do not speak as any other member.`
        : `You are the speaker ${speaker}. Only represent ${speaker}; do not speak as any other member.`;
    }

    const memberLines = members.map((memberId) => {
      const name = this._resolveChannelMemorySenderName(memberId, isZh);
      const suffix = memberId === agentId ? " (you)" : "";
      return `- ${name}${suffix}`;
    }).join("\n");
    return [
      `Channel members:`,
      memberLines,
      "",
      `You are the speaker ${speaker}. Do not speak for other members; only represent your own identity.`,
    ].join("\n");
  }

  _formatCompanyAssignToolGuidance(hasCompanyAssignTool, isZh) {
    if (!hasCompanyAssignTool) return "";
    return isZh
      ? [
        "- 如果这轮消息是在要求拆解项目、分派任务、安排多人协作、生成完整工程包或推进一人公司流程，必须先调用 company_assign，并把完整需求放进 command。",
        "- company_assign 会创建任务卡、写入当前频道、@ 被分派成员并触发他们处理，不只是保存状态。",
        "- 执行成员处理任务后会通过 company_report 回写状态；不要把任务树当作静态看板。",
        "- 不要只在普通文本里手动模拟分工，也不要声称一人公司插件不能调度 agent。",
        "- company_assign 完成后，再用 channel_reply 给频道发一句简短确认，或用 channel_pass 结束本轮。",
      ].join("\n")
      : [
        "- If this turn asks you to split a project, assign work, coordinate multiple members, produce a complete project package, or run the one-person-company workflow, first call company_assign with the full request in command.",
        "- company_assign creates task cards, posts task cards into the current channel, @mentions assigned members, and triggers them to process the work; it is not only a status store.",
        "- Executors report progress back through company_report; do not treat the task tree as a static board.",
        "- Do not only simulate dispatch in ordinary text, and do not claim the company plugin cannot dispatch agents.",
        "- After company_assign finishes, use channel_reply for a short channel confirmation, or use channel_pass to finish this turn.",
      ].join("\n");
  }

  _formatDeliveryWindowGuidance(deliveryWindow, isZh) {
    const dropped = Number(deliveryWindow?.droppedUnreadCount || 0);
    if (dropped <= 0) return "";
    return isZh
      ? [
        `注意：较早的 ${dropped} 条未读消息没有放入本次投递窗口。`,
        "需要更早上下文时，用 channel_read_context 读取频道 Truth，并结合此前 Phone Session 内容理解。",
      ].join("\n")
      : [
        `Note: ${dropped} older unread message(s) were not included in this delivery window.`,
        "Use channel_read_context to read the channel Truth when you need older context, and interpret this window together with the prior Phone Session content.",
      ].join("\n");
  }

  async _executeReply(agentId, channelName, msgText, roleContextOrOptions = {}, maybeOptions = {}) {
    const phoneOptions = typeof roleContextOrOptions === "string" ? maybeOptions : (roleContextOrOptions || {});
    const roleContext = typeof roleContextOrOptions === "string"
      ? roleContextOrOptions
      : String(phoneOptions.roleContext || "");
    const legacySignal = phoneOptions.signal;
    if (this._usePhoneDelivery !== false) {
      const isZh = getLocale().startsWith("zh");
      const {
        signal,
        messageCount = null,
        deliveryWindow = null,
        proactive = false,
        mentionedAgents = [],
        mentionTargeted = false,
      } = phoneOptions;
      const phoneSettings = this._resolveChannelPhoneSettings(channelName);
      const promptGuidance = this._formatPhonePromptGuidance(agentId, phoneSettings, isZh);
      const behaviorGuidance = this._formatChannelBehaviorGuidance(agentId, mentionedAgents, mentionTargeted, isZh, msgText);
      const deliveryWindowGuidance = this._formatDeliveryWindowGuidance(deliveryWindow, isZh);
      const companyTools = this._createCompanyChannelTools(agentId, channelName);
      const companyAssignGuidance = this._formatCompanyAssignToolGuidance(
        companyTools.some((tool) => tool.name === "company_assign"),
        isZh,
      );
      const intro = proactive
        ? (isZh
          ? `你的手机收到了 #${channelName} 的频道提醒。\n\n以下是最近的频道内容，来源是频道聊天记录 Truth，不是用户单独发给你的请求，也不一定是新消息：\n\n`
          : `Your phone received a channel reminder for #${channelName}.\n\nHere is recent channel content. The source is the channel transcript Truth, not a direct user request, and it may not be new:\n\n`)
        : (isZh
          ? `你的手机收到了 #${channelName} 的新群聊消息。\n\n这些是本次投递窗口内未处理的新消息，不是频道全部历史；来源是频道聊天记录 Truth，不是用户单独发给你的请求：\n\n`
          : `Your phone received new messages in #${channelName}.\n\nThese are the unprocessed new messages inside this delivery window, not the channel's full history. The source is the channel transcript Truth, not a direct user request:\n\n`);

      let activeSessionPath = null;
      let decision = null;
      let channelOutputBlocks = [];
      const collectChannelOutputBlocks = (event, eventSessionPath) => {
        if (!event || event.type !== "tool_execution_end" || event.isError) return;
        const blocks = extractBlocks(event.toolName, event.result?.details, event.result);
        for (const block of blocks) {
          const annotated = annotateChannelBlock(block, eventSessionPath || activeSessionPath);
          if (annotated) channelOutputBlocks = mergeChannelOutputBlock(channelOutputBlocks, annotated);
        }
      };
      try {
        await runAgentPhoneSession(
          agentId,
          [
            {
              text: isZh
                ? intro
                  + `${msgText || "（没有新消息）"}\n\n`
                  + `${deliveryWindowGuidance ? `${deliveryWindowGuidance}\n\n` : ""}`
                  + "请像群聊成员一样阅读并行动：\n"
                  + `${roleContext ? `${roleContext}\n\n` : ""}`
                  + `${behaviorGuidance}\n`
                  + `${companyAssignGuidance ? `${companyAssignGuidance}\n` : ""}`
                  + "- 需要旧上下文时，用 channel_read_context 读取频道 Truth；需要事实和长期背景时，用 search_memory。\n"
                  + "- 结合此前 Phone Session 内容理解这批消息；本次投递窗口不是频道全部历史。\n"
                  + `${promptGuidance}\n`
                  + "- 本轮最后必须调用 channel_reply 或 channel_pass 之一完成动作。\n"
                  + "- 不要把最终群聊回复写在普通文本里；只有 channel_reply.content 会进入群聊。"
                : intro
                  + `${msgText || "(No new messages)"}\n\n`
                  + `${deliveryWindowGuidance ? `${deliveryWindowGuidance}\n\n` : ""}`
                  + "Read and act like a group chat member:\n"
                  + `${roleContext ? `${roleContext}\n\n` : ""}`
                  + `${behaviorGuidance}\n`
                  + `${companyAssignGuidance ? `${companyAssignGuidance}\n` : ""}`
                  + "- Use channel_read_context for older channel Truth; use search_memory for facts and long-term background.\n"
                  + "- Interpret this batch together with the prior Phone Session content; this delivery window is not the channel's full history.\n"
                  + `${promptGuidance}\n`
                  + "- End this turn by calling exactly one of channel_reply or channel_pass.\n"
                  + "- Do not write the final channel reply as ordinary text; only channel_reply.content enters the channel.",
              capture: true,
            },
          ],
          {
            engine: this._engine,
            signal,
            conversationId: channelName,
            conversationType: "channel",
            toolMode: phoneSettings.toolMode,
            modelOverride: phoneSettings.modelOverrideEnabled ? phoneSettings.modelOverrideModel : null,
            emitEvents: true,
            extraCustomTools: [
              ...companyTools,
              ...this._createChannelPhoneTools(agentId, channelName, {
                setDecision: (next) => { if (!decision) decision = next; },
                getOutputBlocks: () => channelOutputBlocks,
              }),
            ],
            onSessionReady: (sessionPath) => {
              activeSessionPath = sessionPath;
              return this._recordPhoneActivity(
                agentId,
                channelName,
                "replying",
                isZh ? "正在查看群聊消息" : "Reading channel messages",
                {
                  ...(messageCount != null ? { messageCount } : {}),
                  sessionPath,
                },
              );
            },
            onActivity: (state, summary, details) =>
              this._recordPhoneActivity(
                agentId,
                channelName,
                state,
                summary,
                {
                  ...(details || {}),
                  ...(activeSessionPath ? { sessionPath: activeSessionPath } : {}),
                },
              ),
            onEvent: (event, { sessionPath } = {}) => collectChannelOutputBlocks(event, sessionPath),
          },
        );
      } catch (err) {
        if (decision) {
          return { ...decision, abortedAfterDecision: true };
        }
        throw err;
      }

      return decision || { replied: false, missingDecision: true };
    }

    const isZh = getLocale().startsWith("zh");
    const text = await runAgentSession(
      agentId,
      [
        {
          text: isZh
            ? `#${channelName} 频道的最近消息：\n\n${msgText}\n\n${roleContext}\n\n`
              + `请阅读这些消息，并使用 search_memory 查询记忆来理解上下文和真实发生过的事。\n`
              + `注意：你现在的回复用户看不到，这是内部思考环节，仅用于查阅资料和理解上下文。下一轮才是你真正发到群聊的内容。`
            : `Recent messages in #${channelName}:\n\n${msgText}\n\n${roleContext}\n\n`
              + `Read these messages and use search_memory to look up memories for context and real events.\n`
              + `Note: your reply right now is invisible to users - this is your internal thinking phase, for research and understanding context only. The next round is what actually gets posted to the chat.`,
          capture: false,
        },
        {
          text: isZh
            ? `现在请给出你想在 #${channelName} 群聊中发送的回复。这条回复会直接发送到群聊，所有人都能看到。\n\n`
              + `回复规则：\n`
              + `- 默认 30 字以内，像在群里说话，简短自然\n`
              + `- 如果话题确实需要展开，可以写到 1000 字\n`
              + `- 直接输出回复内容，不要加任何前缀、解释、MOOD 或代码块\n`
              + `- 不要重复别人已经说过的内容\n`
              + `- 只说真实发生过的事，不要编造你没做过的活动或经历\n`
              + `- 如果你觉得没什么好说的，回复 [NO_REPLY]`
            : `Now give the reply you want to post in #${channelName}. This reply will be sent directly to the group chat - everyone can see it.\n\n`
              + `Reply rules:\n`
              + `- Keep it under 30 words by default - short and natural, like chatting in a group\n`
              + `- If the topic truly requires elaboration (storytelling, analysis, detailed explanation), you may write up to 1000 words\n`
              + `- Output the reply directly - no prefixes, explanations, MOOD blocks, or code fences\n`
              + `- Don't repeat what others have already said\n`
              + `- Only mention things that actually happened - don't fabricate activities or experiences\n`
              + `- If you have nothing to say, reply [NO_REPLY]`,
          capture: true,
        },
      ],
      { engine: this._engine, signal: legacySignal, sessionSuffix: "channel-temp" },
    );

    if (!text || text.includes("[NO_REPLY]")) {
      debugLog()?.log("channel", `${agentId}/#${channelName}: chose not to reply`);
      return null;
    }

    return text;
  }

  _resolveChannelMemorySenderName(sender, isZh) {
    const rawSender = String(sender || "").trim();
    if (!rawSender) return isZh ? "未知角色" : "Unknown";
    if (rawSender === "system") return isZh ? "系统" : "System";

    const engine = this._engine;
    if (rawSender === "user" || rawSender === engine.userName) {
      return engine.userName || (isZh ? "用户" : "User");
    }

    const agent = this._getAgentInstance(rawSender);
    if (agent?.agentName) return agent.agentName;

    try {
      const cfg = loadConfig(path.join(engine.agentsDir, rawSender, "config.yaml"));
      const name = cfg?.agent?.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
      // Legacy channel logs may reference an agent that no longer exists.
    }

    return rawSender;
  }

  _formatChannelMemoryContext(agentId, payload, isZh) {
    if (typeof payload === "string") return payload;

    const lines = [];
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    for (const message of messages) {
      const speaker = this._resolveChannelMemorySenderName(message?.sender, isZh);
      const body = String(message?.body || message?.text || "").trim();
      if (!body) continue;
      const timestamp = String(message?.timestamp || "").trim();
      lines.push(timestamp ? `[${timestamp}] ${speaker}: ${body}` : `${speaker}: ${body}`);
    }

    const replyContent = String(payload?.replyContent || "").trim();
    if (replyContent) {
      const replyLabel = isZh ? "[我的回复]" : "[My reply]";
      const agentName = this._resolveChannelMemorySenderName(agentId, isZh);
      lines.push(`${replyLabel} ${agentName}: ${replyContent}`);
    }

    const legacyText = String(payload?.contextText || "").trim();
    if (legacyText) lines.push(legacyText);
    return lines.join("\n\n");
  }

  _channelMemorySystemPrompt(isZh) {
    return isZh
      ? [
        "把频道聊天记录 Truth 压缩成可搜索的长期记忆摘要。",
        "只输出 1 到 3 条干净短句，用分号分隔；每条必须写清谁做了什么、决定了什么或状态发生了什么变化。",
        "如果输入包含已有频道记忆，请合并已有记忆和本次频道内容并重写，清理旧 ID、含混主语和杂乱摘要。",
        "使用输入里的角色显示名，不要保留 sender id，不要写聊天流水、标题、项目符号、mood、泛称或含混主语。",
        "如果这批内容没有长期检索价值，只输出 NO_MEMORY。",
      ].join("\n")
      : [
        "Compress the channel transcript Truth into searchable long-term memory.",
        "Output 1 to 3 clean short facts separated by semicolons; each fact must state who did what, what was decided, or what state changed.",
        "If existing channel memory is provided, merge and rewrite it with the current channel content, cleaning old ids, vague subjects, and messy summaries.",
        "Use the display names from the input. Do not keep sender ids, chat logs, headings, bullets, mood, vague subjects, or generic group references.",
        "If there is no durable searchable value, output NO_MEMORY.",
      ].join("\n");
  }

  _normalizeChannelMemorySummary(rawSummary) {
    return String(rawSummary || "")
      .trim()
      .replace(/^```(?:\w+)?\s*/u, "")
      .replace(/\s*```$/u, "")
      .trim();
  }

  _isEmptyChannelMemorySummary(summaryText) {
    const normalized = String(summaryText || "").trim().toUpperCase();
    return !normalized || normalized === "NO_MEMORY" || normalized === "无记忆";
  }

  _getPreviousChannelMemoryFacts(factStore, sessionId) {
    if (typeof factStore?.getBySession !== "function") return [];
    return factStore.getBySession(sessionId) || [];
  }

  _clearPreviousChannelMemoryFacts(factStore, sessionId, previousFacts = null) {
    if (typeof factStore?.delete !== "function") return;
    const facts = Array.isArray(previousFacts)
      ? previousFacts
      : this._getPreviousChannelMemoryFacts(factStore, sessionId);
    for (const fact of facts) {
      if (fact?.id != null) factStore.delete(fact.id);
    }
  }

  _formatChannelMemoryPromptContent(channelName, contextText, previousFacts, isZh) {
    const previousText = previousFacts
      .map(fact => String(fact?.fact || "").trim())
      .filter(Boolean)
      .join("\n");
    const clippedContext = contextText.slice(0, 3000);
    const clippedPrevious = previousText.slice(0, 2000);
    if (isZh) {
      return [
        `频道 #${channelName}`,
        "已有频道记忆（可能包含旧 ID 或杂乱摘要，请清理并合并）：",
        clippedPrevious || "（无）",
        "本次频道内容：",
        clippedContext,
      ].join("\n");
    }
    return [
      `Channel #${channelName}`,
      "Existing channel memory (may contain old ids or messy summaries; clean and merge it):",
      clippedPrevious || "(none)",
      "Current channel content:",
      clippedContext,
    ].join("\n");
  }

  /**
    *
   */
  async _memorySummarize(agentId, channelName, payload) {
    const engine = this._engine;
    let factStore = null;
    let needClose = false;
    try {
      const agentInstance = this._getAgentInstance(agentId);
      if (!this._resolveMemoryMasterEnabled(agentId, { agentInstance })) {
        console.log(`\x1b[90m[channel] ${agentId} memory master disabled, skip channel memory\x1b[0m`);
        return;
      }

      const utilCfg = engine.resolveUtilityConfig({ agentId }) || {};
      const { utility: model, api_key, base_url, api } = utilCfg;
      if (!api_key || !base_url || !api) {
        console.log(`\x1b[90m[channel] ${agentId} missing utility API config, skip channel memory summary\x1b[0m`);
        return;
      }

      const isZhMem = getLocale().startsWith("zh");
      const contextText = this._formatChannelMemoryContext(agentId, payload, isZhMem);
      if (!contextText.trim()) return;

      const sessionId = `channel-${channelName}`;
      if (agentInstance?.factStore) {
        factStore = agentInstance.factStore;
      } else {
        const { FactStore } = await import("../lib/memory/fact-store.ts");
        const dbPath = path.join(engine.agentsDir, agentId, "memory", "facts.db");
        factStore = new FactStore(dbPath);
        needClose = true;
      }

      const previousFacts = this._getPreviousChannelMemoryFacts(factStore, sessionId);
      const rawSummary = await callText({
        api, model,
        apiKey: api_key,
        baseUrl: base_url,
        systemPrompt: this._channelMemorySystemPrompt(isZhMem),
        messages: [{
          role: "user",
          content: this._formatChannelMemoryPromptContent(channelName, contextText, previousFacts, isZhMem),
        }],
        temperature: 0.3,
        maxTokens: 200,
        usageLedger: utilCfg.usageLedger ?? engine.usageLedger,
        usageContext: {
          source: {
            subsystem: "memory",
            operation: "channel_memory_summary",
            surface: "channel",
            trigger: "scheduled",
          },
          attribution: {
            kind: "memory",
            agentId,
          },
        },
      });
      const summaryText = this._normalizeChannelMemorySummary(rawSummary);

      const now = new Date();
      this._clearPreviousChannelMemoryFacts(factStore, sessionId, previousFacts);
      if (this._isEmptyChannelMemorySummary(summaryText)) {
        console.log(`\x1b[90m[channel] ${agentId} memory cleared/no durable summary (#${channelName})\x1b[0m`);
        return;
      }

      factStore.add({
        fact: `[#${channelName}] ${summaryText}`,
        tags: [isZhMem ? "频道" : "channel", channelName],
        time: now.toISOString().slice(0, 16),
        session_id: sessionId,
      });

      console.log(`\x1b[90m[channel] ${agentId} memory saved (#${channelName}, ${summaryText.length} chars)\x1b[0m`);
    } catch (err) {
      console.error(`[channel] memory summary failed (${agentId}/#${channelName}): ${err.message}`);
    } finally {
      if (needClose) factStore?.close?.();
    }
  }

  _buildRoleContext(agentId, channelName, memberRoles) {
    const isZh = getLocale().startsWith("zh");
    const role = normalizeChannelRole(memberRoles?.[agentId]);
    const labels = isZh ? CHANNEL_ROLE_LABELS_ZH : CHANNEL_ROLE_LABELS_EN;
    const roleLabel = labels[role];
    const others = Object.entries(memberRoles || {})
      .filter(([memberId]) => memberId !== agentId)
      .map(([memberId, memberRole]) => {
        const otherRole = normalizeChannelRole(memberRole);
        return `- ${memberId}: ${otherRole} (${labels[otherRole]})`;
      })
      .join("\n");
    const roleList = formatRoleList(memberRoles, isZh);

    if (isZh) {
      const roleGuide = role === "project_manager"
        ? [
          "你是频道调度入口：负责理解老板/用户目标、调用 company_assign 拆任务树、@ 对应成员、跟进阶段总结。",
          "项目经理不要把分工只写成普通聊天文本；涉及多人协作、工作流、打包、修复或完整交付时先调用 company_assign。",
          "除非频道没有可用工人或明确需要你补位，不要抢执行细节；把执行交给工人，把复核/阻塞交给管理员。",
        ].join("\n")
        : role === "admin"
          ? [
            "你是频道流程监督：负责复核输出、记录阻塞/失败原因、汇总可交付结果，并提醒项目经理需要补派或重试的节点。",
            "管理员不创建新的任务树；除非项目经理缺席且用户明确要求你接管，否则不要替项目经理做总指挥。",
            "看到待复核、失败、重试或规范偏差时，先用 company_report 更新状态，再用 channel_reply 简短同步。"
          ].join("\n")
          : [
            "你是频道执行成员：负责处理被分派给你的具体任务，产出图片、文件、代码、表格、视频、音频或明确结论。",
            "不要代替项目经理重新拆全局计划，也不要只回复“无法调度”；被 @ 或任务卡分派时应直接执行或说明阻塞。",
            "有进展、完成结果或阻塞时，先用 company_report 回写任务状态，再用 channel_reply 给频道同步简短结论。"
          ].join("\n");

      return [
        `你在频道 #${channelName} 的团队角色是：${roleLabel}（${role}）。`,
        "当前频道调度链路：用户/老板输入 -> 项目经理拆解并派发 -> 管理员监督复核和阻塞 -> 工人执行产出 -> 频道回报。",
        roleGuide,
        roleList ? `当前频道成员分工：\n${roleList}` : "",
        others ? `除你之外的成员：\n${others}` : "",
      ].filter(Boolean).join("\n\n");
    }

    const roleGuide = role === "project_manager"
      ? [
        "You are the channel dispatch entry point: understand the boss/user goal, coordinate assignments, call company_assign to create the task tree, @ the right members, and summarize progress.",
        "Do not only describe delegation in ordinary chat text. For multi-agent work, workflows, packaging, bug fixes, or complete deliverables, call company_assign first.",
        "Do not compete with workers on execution details unless there is no available worker or you are explicitly covering a gap."
      ].join("\n")
      : role === "admin"
        ? [
          "You are the channel process supervisor: review outputs, record blockers/failure reasons, summarize deliverables, and flag nodes that need retry or reassignment.",
          "Admins do not create new task trees unless the project manager is absent and the user explicitly asks you to take over.",
          "For reviews, failures, retries, or constraint drift, call company_report first, then post a short channel_reply."
        ].join("\n")
        : [
          "You are a channel executor: handle concrete tasks assigned to you and produce images, files, code, tables, video, audio, or a clear result.",
          "Do not take over whole-project planning, and do not claim the channel cannot dispatch agents. When @mentioned or assigned a task card, execute or state the blocker.",
          "For progress, completion, or blockers, call company_report first, then post a short channel_reply."
        ].join("\n");

    return [
      `Your team role in #${channelName} is: ${roleLabel} (${role}).`,
      "Current channel dispatch chain: user/boss input -> project manager decomposes and dispatches -> admin supervises review and blockers -> workers execute outputs -> channel report.",
      roleGuide,
      roleList ? `Current channel member roles:\n${roleList}` : "",
      others ? `Other teammates:\n${others}` : "",
    ].filter(Boolean).join("\n\n");
  }
}
