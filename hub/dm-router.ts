// @ts-nocheck
import fs from "fs";
import path from "path";
import {
  appendMessage,
  getRecentMessages,
  formatMessagesForLLM,
} from "../lib/channels/channel-store.ts";
import { runAgentPhoneSession } from "./agent-executor.ts";
import { debugLog } from "../lib/debug-log.ts";
import { getLocale } from "../lib/i18n.ts";
import {
  getAgentPhoneProjectionPath,
  readAgentPhoneProjection,
  recordAgentPhoneActivity,
} from "../lib/conversations/agent-phone-projection.ts";
import {
  readAgentPhoneRuntime,
  resolveAgentPhoneRuntimeSessionPath,
} from "../lib/conversations/agent-phone-runtime.ts";
import { normalizeAgentPhoneToolMode } from "../lib/conversations/agent-phone-session.ts";
import {
  DEFAULT_AGENT_PHONE_SETTINGS,
  formatAgentPhonePromptGuidance,
  positiveIntegerOrNull,
} from "../lib/conversations/agent-phone-prompt.ts";

const MAX_ROUNDS = 3;
const COOLDOWN_MS = 10_000;

export class DmRouter {
  constructor({ hub }) {
    this._hub = hub;
    this._cooldowns = new Map();
    this._processing = new Map();
  }

  get _engine() { return this._hub.engine; }

  _isPhoneEnabled() {
    return this._engine.isChannelsEnabled?.() !== false;
  }

  async _recordPhoneActivity(agentId, peerId, state, summary, details = {}) {
    try {
      const agent = this._engine.getAgent(agentId);
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      const activity = {
        conversationId: `dm:${peerId}`,
        conversationType: "dm",
        agentId,
        state,
        summary,
        details,
      };
      this._hub.agentPhoneActivities?.record?.(activity);
      await recordAgentPhoneActivity({ agentDir, ...activity });
    } catch (err) {
      debugLog()?.warn?.("dm-router", `phone activity record failed (${agentId}/dm:${peerId}): ${err.message}`);
    }
  }

  _resolvePhoneSettings(agentId, peerId) {
    try {
      const agent = this._engine.getAgent(agentId);
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(agentDir, `dm:${peerId}`));
      return {
        toolMode: normalizeAgentPhoneToolMode(projection.meta.toolMode),
        replyMinChars: positiveIntegerOrNull(projection.meta.replyMinChars),
        replyMaxChars: positiveIntegerOrNull(projection.meta.replyMaxChars),
      };
    } catch {
      return DEFAULT_AGENT_PHONE_SETTINGS;
    }
  }

  _resolvePhoneSessionPath(agentId, peerId) {
    try {
      const agent = this._engine.getAgent(agentId);
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      return resolveAgentPhoneRuntimeSessionPath(agentDir, readAgentPhoneRuntime(agentDir, `dm:${peerId}`));
    } catch {
      return null;
    }
  }

  async handleNewDm(fromId, toId) {
    if (!this._isPhoneEnabled()) return;

    const key = `${fromId}->${toId}`;
    const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
    const now = Date.now();
    for (const [k, ts] of this._processing) {
      if (now - ts > PROCESSING_TIMEOUT_MS) this._processing.delete(k);
    }

    if (this._processing.has(key)) return;

    for (const [k, t] of this._cooldowns) {
      if (now - t >= COOLDOWN_MS) this._cooldowns.delete(k);
    }
    if (this._cooldowns.has(key) && now - this._cooldowns.get(key) < COOLDOWN_MS) {
      debugLog()?.log("dm-router", `cooldown hit: ${key}`);
      return;
    }

    this._processing.set(key, Date.now());
    this._cooldowns.set(key, now);

    try {
      await this._processReply(fromId, toId);
    } catch (err) {
      console.error(`[dm-router] ${key} failed: ${err.message}`);
    } finally {
      this._processing.delete(key);
    }
  }

  async _processReply(fromId, toId) {
    if (!this._isPhoneEnabled()) return;

    const engine = this._engine;
    const agentsDir = engine.agentsDir;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const dmFile = path.join(agentsDir, toId, "dm", `${fromId}.md`);
      if (!fs.existsSync(dmFile)) break;

      const recentMsgs = getRecentMessages(dmFile, 20);
      if (recentMsgs.length === 0) break;

      const lastMsg = recentMsgs[recentMsgs.length - 1];
      if (lastMsg.sender === toId) break;

      const msgText = formatMessagesForLLM(recentMsgs);
      const lastMsgTimestamp = lastMsg.timestamp || null;
      const fromAgent = engine.getAgent(fromId);
      const toAgent = engine.getAgent(toId);
      const fromName = fromAgent?.agentName || fromAgent?.name || fromId;
      const toName = toAgent?.agentName || toAgent?.name || toId;
      const isZh = getLocale().startsWith("zh");
      const phoneSettings = this._resolvePhoneSettings(toId, fromId);
      const promptGuidance = formatAgentPhonePromptGuidance({
        agentId: toId,
        agent: toAgent,
        agentsDir,
        settings: phoneSettings,
        enConversationName: "DM",
      });

      debugLog()?.log("dm-router", `${toId} replying to ${fromId} (round ${round + 1}/${MAX_ROUNDS})`);
      await this._recordPhoneActivity(
        toId,
        fromId,
        "viewed",
        isZh ? `已查看来自 ${fromName} 的私信` : `Viewed DM from ${fromName}`,
        { messageCount: recentMsgs.length, lastMessageTimestamp: lastMsgTimestamp },
      );
      await this._recordPhoneActivity(
        toId,
        fromId,
        "replying",
        isZh ? "正在回复私信" : "Replying to DM",
        { round: round + 1, maxRounds: MAX_ROUNDS },
      );

      let activeSessionPath = null;
      const replyText = await runAgentPhoneSession(
        toId,
        [
          {
            text: isZh
              ? `你的手机收到了来自「${fromName}」的私信。\n\n`
                + `以下是你们最近的聊天记录：\n\n${msgText}\n\n`
                + `---\n\n`
                + `${promptGuidance}\n\n`
                + `请给出你的回复（第 ${round + 1}/${MAX_ROUNDS} 轮）。直接输出内容，不要加前缀。\n`
                + `如果你觉得对话可以结束了，在末尾加 <done/>。\n`
                + `如果你不想回复，输出 [NO_REPLY]。`
              : `You received a DM from "${fromName}".\n\n`
                + `Here is your recent chat history:\n\n${msgText}\n\n`
                + `---\n\n`
                + `${promptGuidance}\n\n`
                + `Give your reply (round ${round + 1}/${MAX_ROUNDS}). Output directly, no prefix.\n`
                + `If you think the conversation can end, append <done/>.\n`
                + `If you don't want to reply, output [NO_REPLY].`,
            capture: true,
          },
        ],
        {
          engine,
          conversationId: `dm:${fromId}`,
          conversationType: "dm",
          toolMode: phoneSettings.toolMode,
          emitEvents: true,
          onSessionReady: (sessionPath) => {
            activeSessionPath = sessionPath;
            return this._recordPhoneActivity(
              toId,
              fromId,
              "replying",
              isZh ? "正在回复私信" : "Replying to DM",
              { round: round + 1, maxRounds: MAX_ROUNDS, sessionPath },
            );
          },
          onActivity: (state, summary, details) =>
            this._recordPhoneActivity(
              toId,
              fromId,
              state,
              summary,
              {
                ...(details || {}),
                ...(activeSessionPath ? { sessionPath: activeSessionPath } : {}),
              },
            ),
        },
      );

      if (!replyText || replyText.includes("[NO_REPLY]")) {
        debugLog()?.log("dm-router", `${toName} chose not to reply to ${fromName}`);
        await this._recordPhoneActivity(
          toId,
          fromId,
          "no_reply",
          isZh ? "选择不回复私信" : "Chose not to reply to DM",
          {
            round: round + 1,
            ...(this._resolvePhoneSessionPath(toId, fromId)
              ? { sessionPath: this._resolvePhoneSessionPath(toId, fromId) }
              : {}),
          },
        );
        break;
      }

      const isDone = /<done\s*\/?>/i.test(replyText);
      const cleanReply = replyText.replace(/<done\s*\/?>/gi, "").trim();
      if (!cleanReply) break;

      const toFile = path.join(agentsDir, toId, "dm", `${fromId}.md`);
      const fromFile = path.join(agentsDir, fromId, "dm", `${toId}.md`);
      await appendMessage(toFile, toId, cleanReply);
      if (fs.existsSync(fromFile)) await appendMessage(fromFile, toId, cleanReply);

      this._hub.eventBus.emit({
        type: "dm_new_message",
        from: toId,
        to: fromId,
      }, null);
      await this._recordPhoneActivity(
        toId,
        fromId,
        "idle",
        isZh ? "已回复私信" : "Replied to DM",
        {
          done: isDone,
          ...(this._resolvePhoneSessionPath(toId, fromId)
            ? { sessionPath: this._resolvePhoneSessionPath(toId, fromId) }
            : {}),
        },
      );

      debugLog()?.log("dm-router", `${toName} replied to ${fromName}: ${cleanReply.slice(0, 60)}...${isDone ? " [done]" : ""}`);

      if (isDone) break;

      const swapKey = `${toId}->${fromId}`;
      this._cooldowns.set(swapKey, Date.now());
      [fromId, toId] = [toId, fromId];
    }
  }
}
