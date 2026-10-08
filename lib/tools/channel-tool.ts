// @ts-nocheck
/**
 * Channel tool used by agents.
 *
 * Actions:
 * - read: read recent channel messages
 * - post: post text or rich blocks to a channel
 * - create: create a new channel
 * - list: list joined channels
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import {
  appendMessage,
  createChannel,
  addBookmarkEntry,
  getRecentMessages,
  getChannelMeta,
  formatMessagesForLLM,
  normalizeChannelMembers,
  readBookmarks,
} from "../channels/channel-store.ts";
import fs from "fs";
import path from "path";

function safeChannelFilePath(channelsDir, channelId) {
  if (!channelId || /[/\\]|\.\./.test(channelId)) return null;
  const filePath = path.resolve(channelsDir, `${channelId}.md`);
  const base = path.resolve(channelsDir);
  if (!filePath.startsWith(base + path.sep) && filePath !== base) return null;
  return filePath;
}

function safeAgentDir(agentsDir, agentId) {
  if (!agentId || /[/\\]|\.\./.test(agentId)) return null;
  const dirPath = path.resolve(agentsDir, agentId);
  const base = path.resolve(agentsDir);
  if (!dirPath.startsWith(base + path.sep) && dirPath !== base) return null;
  return fs.existsSync(dirPath) ? dirPath : null;
}

function listJoinedChannels({ channelsDir, agentsDir, agentId }) {
  if (!fs.existsSync(channelsDir)) return [];

  const bookmarks = readBookmarks(path.join(agentsDir, agentId, "channels.md"));
  return fs.readdirSync(channelsDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => {
      const id = fileName.replace(/\.md$/, "");
      const filePath = path.join(channelsDir, fileName);
      const meta = getChannelMeta(filePath);
      const members = Array.isArray(meta.members) ? meta.members : [];
      return {
        id,
        name: meta.name || id,
        description: meta.description || "",
        members,
        lastRead: bookmarks.get(id) || "never",
        filePath,
      };
    })
    .filter((channel) => channel.members.includes(agentId))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function formatChannelList(channels) {
  const lines = ["# 频道", ""];
  for (const channel of channels) {
    const parts = [
      `name: ${channel.name}`,
      `members: ${channel.members.join(", ")}`,
      `last: ${channel.lastRead}`,
    ];
    if (channel.description) parts.push(`description: ${channel.description}`);
    lines.push(`- ${channel.id} (${parts.join("; ")})`);
  }
  return lines.join("\n");
}

function resolveChannelReference({ channelsDir, agentsDir, agentId, channel }) {
  const requested = typeof channel === "string" ? channel.trim() : "";
  if (!requested) return { ok: false, error: "missing params" };

  const exactPath = safeChannelFilePath(channelsDir, requested);
  if (exactPath && fs.existsSync(exactPath)) {
    const meta = getChannelMeta(exactPath);
    const members = Array.isArray(meta.members) ? meta.members : [];
    if (!members.includes(agentId)) {
      return {
        ok: false,
        error: "not a member",
        channelId: requested,
        name: meta.name || requested,
      };
    }
    return {
      ok: true,
      id: requested,
      name: meta.name || requested,
      filePath: exactPath,
      members,
    };
  }

  const matches = listJoinedChannels({ channelsDir, agentsDir, agentId })
    .filter((entry) => entry.name === requested);
  if (matches.length === 1) {
    const match = matches[0];
    return {
      ok: true,
      id: match.id,
      name: match.name,
      filePath: match.filePath,
      members: match.members,
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: "ambiguous channel name",
      name: requested,
      matches: matches.map((entry) => entry.id),
    };
  }

  return {
    ok: false,
    error: "channel not found",
    name: requested,
  };
}

function channelResolveErrorResult(action, requested, resolved) {
  if (resolved.error === "ambiguous channel name") {
    const choices = resolved.matches.join(", ");
    return {
      content: [{
        type: "text",
        text: `Channel name "${resolved.name}" is ambiguous; use a channel ID instead: ${choices}`,
      }],
      details: { action, error: resolved.error, matches: resolved.matches },
    };
  }

  if (resolved.error === "not a member") {
    return {
      content: [{ type: "text", text: t("error.agentNotChannelMember", { channel: requested }) }],
      details: { action, error: resolved.error },
    };
  }

  return {
    content: [{ type: "text", text: t("error.channelNotExists", { channel: requested }) }],
    details: { action, error: "channel not found" },
  };
}

function normalizeChannelBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((block) => block && typeof block === "object" && typeof block.type === "string")
    .map((block) => JSON.parse(JSON.stringify(block)));
}

function missingAgentResult(memberId) {
  const message = `Agent not found: ${memberId}`;
  return {
    content: [{ type: "text", text: t("error.channelCreateFailed", { msg: message }) }],
    details: { action: "create", error: message },
  };
}

/**
 * Create the channel tool.
 * @param {object} opts
 * @param {string} opts.channelsDir
 * @param {string} opts.agentsDir
 * @param {string} opts.agentId
 * @param {() => Array<{id: string, name: string}>} opts.listAgents
 * @param {(channelName: string, senderId: string, message: object) => void} [opts.onPost]
 * @param {() => boolean} [opts.isEnabled]
 * @param {(opts: object) => Promise<{id: string, filePath: string}>|{id: string, filePath: string}} [opts.createChannelEntry]
 * @returns {import('../pi-sdk/index.ts').ToolDefinition}
 */
export function createChannelTool({
  channelsDir,
  agentsDir,
  agentId,
  listAgents: _listAgents,
  onPost,
  isEnabled,
  createChannelEntry,
}) {
  return {
    name: "channel",
    label: t("toolDef.channel.label"),
    description: t("toolDef.channel.description"),
    parameters: Type.Object({
      action: StringEnum(
        ["read", "post", "create", "list"],
        { description: t("toolDef.channel.actionDesc") },
      ),
      channel: Type.Optional(Type.String({
        description: t("toolDef.channel.channelDesc")
      })),
      content: Type.Optional(Type.String({
        description: t("toolDef.channel.contentDesc")
      })),
      blocks: Type.Optional(Type.Array(Type.Any({
        description: "Optional rich content blocks generated by tools, such as files, images, video, audio, artifacts, or plugin cards."
      }))),
      name: Type.Optional(Type.String({
        description: t("toolDef.channel.nameDesc")
      })),
      members: Type.Optional(Type.Array(Type.String(), {
        description: t("toolDef.channel.membersDesc")
      })),
      intro: Type.Optional(Type.String({
        description: t("toolDef.channel.introDesc")
      })),
      count: Type.Optional(Type.Number({
        description: t("toolDef.channel.countDesc")
      })),
    }),

    execute: async (_toolCallId, params) => {
      if (isEnabled && !isEnabled()) {
        return {
          content: [{ type: "text", text: t("error.channelsDisabled") }],
          details: { action: params.action, error: "channels disabled" },
        };
      }

      switch (params.action) {
        case "read": {
          const resolved = resolveChannelReference({
            channelsDir,
            agentsDir,
            agentId,
            channel: params.channel,
          });
          if (!resolved.ok) return channelResolveErrorResult("read", params.channel, resolved);

          const count = params.count || 20;
          const messages = getRecentMessages(resolved.filePath, count);
          const text = messages.length > 0
            ? formatMessagesForLLM(messages)
            : t("error.channelNoMessages");

          return {
            content: [{ type: "text", text }],
            details: { action: "read", channel: resolved.id, name: resolved.name, messageCount: messages.length },
          };
        }

        case "post": {
          const blocks = normalizeChannelBlocks(params.blocks);
          const content = typeof params.content === "string" ? params.content : "";
          if (!params.channel || (!content.trim() && blocks.length === 0)) {
            return {
              content: [{ type: "text", text: t("error.channelPostNeedParams") }],
              details: { action: "post", error: "missing params" },
            };
          }

          const resolved = resolveChannelReference({
            channelsDir,
            agentsDir,
            agentId,
            channel: params.channel,
          });
          if (!resolved.ok) return channelResolveErrorResult("post", params.channel, resolved);

          const { timestamp } = appendMessage(resolved.filePath, agentId, content, { blocks });

          if (onPost) {
            try {
              onPost(resolved.id, agentId, {
                sender: agentId,
                timestamp,
                body: content,
                ...(blocks.length > 0 ? { blocks } : {}),
              });
            } catch {
              // Posting succeeded; delivery notification is best-effort.
            }
          }

          return {
            content: [{ type: "text", text: t("error.channelPosted", { channel: resolved.name }) }],
            details: { action: "post", channel: resolved.id, name: resolved.name, timestamp, blocks },
          };
        }

        case "create": {
          if (!params.name || !params.members) {
            return {
              content: [{ type: "text", text: t("error.channelCreateNeedParams") }],
              details: { action: "create", error: "missing params" },
            };
          }

          try {
            const members = normalizeChannelMembers([agentId, ...params.members]);
            if (members.length < 2) {
              return {
                content: [{ type: "text", text: t("error.channelCreateNeedParams") }],
                details: { action: "create", error: "not enough members" },
              };
            }

            const missingMember = members.find((memberId) => !safeAgentDir(agentsDir, memberId));
            if (missingMember) return missingAgentResult(missingMember);

            const created = typeof createChannelEntry === "function"
              ? await createChannelEntry({
                name: params.name,
                members,
                intro: params.intro,
                addUserBookmark: true,
              })
              : createChannel(channelsDir, {
                name: params.name,
                members,
                intro: params.intro,
              });
            const channelId = created.id;

            if (typeof createChannelEntry !== "function") {
              for (const memberId of members) {
                const memberChannelsMd = path.join(agentsDir, memberId, "channels.md");
                if (safeAgentDir(agentsDir, memberId)) {
                  addBookmarkEntry(memberChannelsMd, channelId);
                }
              }
            }

            return {
              content: [{ type: "text", text: t("error.channelCreated", { name: params.name, id: channelId, members: members.join(", ") }) }],
              details: { action: "create", channel: channelId, members },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: t("error.channelCreateFailed", { msg: err.message }) }],
              details: { action: "create", error: err.message },
            };
          }
        }

        case "list": {
          const channels = listJoinedChannels({ channelsDir, agentsDir, agentId });
          if (channels.length === 0) {
            return {
              content: [{ type: "text", text: t("error.channelNoJoined") }],
              details: { action: "list", channels: [] },
            };
          }

          return {
            content: [{ type: "text", text: formatChannelList(channels) }],
            details: {
              action: "list",
              channels: channels.map(({ filePath: _filePath, ...channel }) => channel),
            },
          };
        }

        default:
          return {
            content: [{ type: "text", text: t("error.unknownAction", { action: params.action }) }],
            details: { action: params.action },
          };
      }
    },
  };
}
