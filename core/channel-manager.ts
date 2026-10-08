// @ts-nocheck
/**
  *
 *
  *
  * */
import fs from "fs";
import path from "path";
import { createModuleLogger } from "../lib/debug-log.ts";
import { t, getLocale } from "../lib/i18n.ts";
import {
  createChannel as createChannelFile,
  addBookmarkEntry,
  addChannelMember,
  getChannelMembers,
  removeChannelMember,
  removeBookmarkEntry,
  deleteChannel,
  getChannelMemberRoles,
  setChannelMemberRole,
  normalizeChannelMembers,
} from "../lib/channels/channel-store.ts";

const log = createModuleLogger("channel");

function resolveDefaultChannelText(key, fallbackZh, fallbackEn) {
  const translated = t(key);
  if (translated && translated !== key) return translated;
  return getLocale().startsWith("zh") ? fallbackZh : fallbackEn;
}

export class ChannelManager {
  /**
   * @param {object} deps
    *
 * @param {string} deps.agentsDir - agents 根目- * @param {string} deps.userDir - 用户数据目录
  * */
  constructor(deps) {
    this._channelsDir = deps.channelsDir;
    this._agentsDir = deps.agentsDir;
    this._userDir = deps.userDir;
    this._getHub = deps.getHub;
  }

  createChannelEntry({
    id,
    name,
    description,
    members,
    memberRoles,
    intro,
    addUserBookmark = true,
  } = {}) {
    const normalizedMembers = normalizeChannelMembers(members);
    if (normalizedMembers.length < 2) {
      throw new Error("channel requires at least 2 agent members");
    }
    fs.mkdirSync(this._channelsDir, { recursive: true });
    for (const memberId of normalizedMembers) {
      if (!this._safeAgentDir(memberId)) {
        throw new Error(`Agent not found: ${memberId}`);
      }
    }

    const created = createChannelFile(this._channelsDir, {
      id,
      name,
      description,
      members: normalizedMembers,
      memberRoles,
      intro,
    });

    for (const memberId of normalizedMembers) {
      const memberDir = this._safeAgentDir(memberId);
      if (!memberDir) continue;
      addBookmarkEntry(path.join(memberDir, "channels.md"), created.id);
    }

    if (addUserBookmark) {
      addBookmarkEntry(path.join(this._userDir, "channel-bookmarks.md"), created.id);
    }

    this._emitChannelCreated({
      id: created.id,
      name,
      description,
      members: normalizedMembers,
      memberRoles: getChannelMemberRoles(created.filePath),
    });
    return created;
  }

  /**
   * 从所有频道中清理被删除的 agent
   * - 从每个频道的 members 中移除该 agent
   * - 移除后只剩一个人的频道直接删除
   * - 清理相关 bookmark
   */
  cleanupAgentFromChannels(agentId) {
    if (!this._channelsDir || !fs.existsSync(this._channelsDir)) return;

    const channelFiles = fs.readdirSync(this._channelsDir).filter(f => f.endsWith(".md"));
    const deletedChannels = [];

    for (const f of channelFiles) {
      const filePath = path.join(this._channelsDir, f);
      const channelId = f.replace(".md", "");
      const members = getChannelMembers(filePath);

      if (!members.includes(agentId)) continue;

      try {
        removeChannelMember(filePath, agentId);
        this._abortChannelPhoneSessions(channelId, agentId, "channel-member-removed");
        const remaining = getChannelMembers(filePath);
        if (remaining.length <= 1) {
          deleteChannel(filePath);
          this._abortChannelPhoneSessions(channelId, null, "channel-deleted");
          deletedChannels.push(channelId);
          log.log(`频道 "${channelId}" 成员不足，已删除`);
        }
      } catch (err) {
        log.error(`清理频道 "${channelId}" 失败: ${err.message}`);
      }
    }

    if (deletedChannels.length > 0) {
      this._cleanupBookmarks(deletedChannels, agentId);
    }
  }

  /**
  * */
  deleteChannelByName(channelId) {
    const filePath = path.join(this._channelsDir, `${channelId}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(t("error.channelNotFoundById", { id: channelId }));
    }

    deleteChannel(filePath);
    this._abortChannelPhoneSessions(channelId, null, "channel-deleted");

 //
    const agentDirs = fs.readdirSync(this._agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const d of agentDirs) {
      const channelsMd = path.join(this._agentsDir, d.name, "channels.md");
      removeBookmarkEntry(channelsMd, channelId);
    }

 // 清理用户 bookmark
    const userBookmarkPath = path.join(this._userDir, "channel-bookmarks.md");
    removeBookmarkEntry(userBookmarkPath, channelId);

    log.log(`deleted channel: ${channelId}`);
  }

  /**
 * 触发频道立即 triage（用户发消息后调用）
   */
  async triggerChannelDelivery(channelName, opts) {
    const hub = this._getHub();
    return (hub?.triggerChannelDelivery || hub?.triggerChannelTriage)?.call(hub, channelName, opts);
  }

  async triggerChannelTriage(channelName, opts) {
    return this.triggerChannelDelivery(channelName, opts);
  }

  addAgentToChannel(channelId, agentId, role = "worker") {
    const filePath = path.join(this._channelsDir, `${channelId}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(t("error.channelNotFoundById", { id: channelId }));
    }
    const agentDir = this._safeAgentDir(agentId);
    if (!agentDir) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    addChannelMember(filePath, agentId, role);

    const channelsMdPath = path.join(agentDir, "channels.md");
    addBookmarkEntry(channelsMdPath, channelId);
    return getChannelMemberRoles(filePath);
  }

  updateChannelMemberRole(channelId, memberId, role) {
    const filePath = path.join(this._channelsDir, `${channelId}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(t("error.channelNotFoundById", { id: channelId }));
    }
    return setChannelMemberRole(filePath, memberId, role);
  }

  getChannelMemberRoles(channelId) {
    const filePath = path.join(this._channelsDir, `${channelId}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(t("error.channelNotFoundById", { id: channelId }));
    }
    return getChannelMemberRoles(filePath);
  }

  /**
 * 为新 agent 设置默认频道
  *
   */
  setupChannelsForNewAgent(agentId) {
    const channelsMdPath = path.join(this._agentsDir, agentId, "channels.md");

 // 确保 ch_crew 频道存在
    const crewFile = path.join(this._channelsDir, "ch_crew.md");
    if (!fs.existsSync(crewFile)) {
      const chName = resolveDefaultChannelText("error.defaultChannelName", "工作群", "Crew");
      const chDesc = resolveDefaultChannelText(
        "error.defaultChannelDesc",
        "工作协调频道，所有成员在这里沟通日常事务。",
        "Work coordination channel for daily tasks.",
      );
      createChannelFile(this._channelsDir, {
        id: "ch_crew",
        name: chName,
        description: chDesc,
        members: [agentId],
        memberRoles: { [agentId]: "project_manager" },
        intro: chDesc,
      });
    } else {
      addChannelMember(crewFile, agentId);
    }

 //
    const allChannels = ["ch_crew"];
    try {
      const files = fs.readdirSync(this._channelsDir);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const channelId = f.replace(".md", "");
        if (channelId === "ch_crew") continue;
        const members = getChannelMembers(path.join(this._channelsDir, f));
        if (members.includes(agentId)) {
          allChannels.push(channelId);
        }
      }
    } catch {
      // ignore channel scan failure during bootstrap
    }

    for (const ch of allChannels) {
      addBookmarkEntry(channelsMdPath, ch);
    }
  }

  repairChannelCursorProjection() {
    if (!this._channelsDir || !fs.existsSync(this._channelsDir)) return { added: 0 };

    let added = 0;
    const files = fs.readdirSync(this._channelsDir).filter(f => f.endsWith(".md"));
    for (const f of files) {
      const channelId = f.replace(/\.md$/, "");
      const channelFile = path.join(this._channelsDir, f);
      const members = getChannelMembers(channelFile);
      for (const agentId of members) {
        const agentDir = path.join(this._agentsDir, agentId);
        const configPath = path.join(agentDir, "config.yaml");
        if (!fs.existsSync(configPath)) continue;

        const channelsMdPath = path.join(agentDir, "channels.md");
        const before = fs.existsSync(channelsMdPath)
          ? fs.readFileSync(channelsMdPath, "utf-8")
          : "";
        addBookmarkEntry(channelsMdPath, channelId);
        const after = fs.existsSync(channelsMdPath)
          ? fs.readFileSync(channelsMdPath, "utf-8")
          : "";
        if (before !== after) added++;
      }
    }
    if (added > 0) {
      log.log(`已修复 ${added} 个频道游标投影`);
    }
    return { added };
  }

  _safeAgentDir(agentId) {
    if (!agentId || /[/\\]|\.\./.test(agentId)) return null;
    const dirPath = path.resolve(this._agentsDir, agentId);
    const base = path.resolve(this._agentsDir);
    if (!dirPath.startsWith(base + path.sep) && dirPath !== base) return null;
    return fs.existsSync(dirPath) ? dirPath : null;
  }

  _emitChannelCreated(channel) {
    const eventBus = this._getHub?.()?.eventBus;
    if (typeof eventBus?.emit !== "function") return;
    eventBus.emit({
      type: "channel_created",
      channelName: channel.id,
      channel,
    }, null);
  }

  _abortChannelPhoneSessions(channelId, agentId, reason) {
    const hub = this._getHub?.();
    if (typeof hub?.abortAgentPhoneSessions !== "function") return;
    hub.abortAgentPhoneSessions(reason, {
      ...(agentId ? { agentId } : {}),
      conversationId: channelId,
      conversationType: "channel",
    });
  }

 /** 清理被删频道-bookmark（从其他 agent 和用户的 bookmark 中移除） */
  _cleanupBookmarks(deletedChannels, excludeAgentId) {
    const agentDirs = fs.readdirSync(this._agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== excludeAgentId);

    for (const d of agentDirs) {
      const channelsMd = path.join(this._agentsDir, d.name, "channels.md");
      for (const ch of deletedChannels) {
        try {
          removeBookmarkEntry(channelsMd, ch);
        } catch (err) {
          log.error(`清理 ${d.name} bookmark "${ch}" 失败: ${err.message}`);
        }
      }
    }

    const userBookmarkPath = path.join(this._userDir, "channel-bookmarks.md");
    for (const ch of deletedChannels) {
      try {
        removeBookmarkEntry(userBookmarkPath, ch);
      } catch (err) {
        log.error(`清理用户 bookmark "${ch}" 失败: ${err.message}`);
      }
    }
  }
}
