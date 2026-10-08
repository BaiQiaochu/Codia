// @ts-nocheck
/**
 * channels.js - channel REST API.
 *
 * Channel files are stored as Markdown with frontmatter metadata
 * (id/name/description/members).
 *
 * Endpoints:
 * GET    /channels              - list channels, user bookmarks, unread counts
 * POST   /channels              - create a channel
 * GET    /channels/:id          - read channel messages and members
 * POST   /channels/:id/messages - send a user message to a channel
 * POST   /channels/:id/read     - update the user's read bookmark
 * DELETE /channels/:id          - delete a channel
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { resolveMediaGenerationBlocksWithDeferredResults } from "../block-extractors.ts";
import { debugLog } from "../../lib/debug-log.ts";
import { t } from "../../lib/i18n.ts";
import {
  parseChannel,
  appendMessage,
  readBookmarks,
  updateBookmark,
  removeBookmarkEntry,
  getChannelMembers,
  getChannelMeta,
  getChannelMemberRoles,
  assertValidChannelMembers,
  removeChannelMember,
  updateChannelMeta,
} from "../../lib/channels/channel-store.ts";
import { extractMentionedAgentIds } from "../../lib/channels/channel-mentions.ts";
import { normalizeAgentPhoneToolMode } from "../../lib/conversations/agent-phone-session.ts";
import {
  DEFAULT_AGENT_PHONE_SETTINGS,
  defaultAgentPhoneGuardLimit,
  normalizeAgentPhoneModelOverride,
  positiveIntegerOrDefault,
  readBoolean,
  resolveAgentPhoneGuardLimit,
} from "../../lib/conversations/agent-phone-prompt.ts";
import {
  getAgentPhoneProjectionPath,
  readAgentPhoneProjection,
  updateAgentPhoneProjectionMeta,
} from "../../lib/conversations/agent-phone-projection.ts";
import { resolveAgent } from "../utils/resolve-agent.ts";
import { findModel } from "../../shared/model-ref.ts";

function normalizeOptionalPositiveInt(value: any, fieldName: any) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return Math.floor(num);
}

function readOptionalPositiveInt(value: any) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function normalizePhoneSettingsPayload(body: any = {}) {
  const replyMinChars = normalizeOptionalPositiveInt(body.replyMinChars, "replyMinChars");
  const replyMaxChars = normalizeOptionalPositiveInt(body.replyMaxChars, "replyMaxChars");
  if (replyMinChars && replyMaxChars && replyMinChars > replyMaxChars) {
    throw new Error("replyMinChars must be <= replyMaxChars");
  }
  const reminderIntervalMinutes = normalizeOptionalPositiveInt(
    body.reminderIntervalMinutes ?? DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes,
    "reminderIntervalMinutes",
  ) || DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes;
  const guardLimit = normalizeOptionalPositiveInt(body.guardLimit, "guardLimit");
  const proactiveEnabled = body.proactiveEnabled === undefined
    ? DEFAULT_AGENT_PHONE_SETTINGS.proactiveEnabled
    : readBoolean(body.proactiveEnabled);
  const override = normalizeAgentPhoneModelOverride({
    enabled: body.modelOverrideEnabled,
    id: body.modelOverrideModel?.id ?? body.modelOverrideId,
    provider: body.modelOverrideModel?.provider ?? body.modelOverrideProvider,
  });
  return {
    mode: normalizeAgentPhoneToolMode(body.mode),
    replyMinChars,
    replyMaxChars,
    proactiveEnabled,
    reminderIntervalMinutes,
    guardLimit,
    modelOverrideEnabled: override.enabled,
    modelOverrideModel: override.model,
  };
}

function readChannelPhoneSettingsFromMeta(meta) {
  const memberCount = Array.isArray(meta.members) ? meta.members.length : 3;
  const override = normalizeAgentPhoneModelOverride({
    enabled: meta.agentPhoneModelOverrideEnabled,
    id: meta.agentPhoneModelOverrideId,
    provider: meta.agentPhoneModelOverrideProvider,
  });
  return {
    mode: normalizeAgentPhoneToolMode(meta.agentPhoneToolMode),
    replyMinChars: readOptionalPositiveInt(meta.agentPhoneReplyMinChars),
    replyMaxChars: readOptionalPositiveInt(meta.agentPhoneReplyMaxChars),
    proactiveEnabled: meta.agentPhoneProactiveEnabled === undefined
      ? DEFAULT_AGENT_PHONE_SETTINGS.proactiveEnabled
      : readBoolean(meta.agentPhoneProactiveEnabled),
    reminderIntervalMinutes: positiveIntegerOrDefault(
      meta.agentPhoneReminderIntervalMinutes,
      DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes,
    ),
    guardLimit: resolveAgentPhoneGuardLimit(meta.agentPhoneGuardLimit, memberCount),
    modelOverrideEnabled: override.enabled,
    modelOverrideModel: override.model,
  };
}

function resolveChannelMessageDeferredBlocks(messages, deferredResults) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  return messages.map((message) => {
    if (!Array.isArray(message?.blocks) || message.blocks.length === 0) return message;
    const blocks = resolveMediaGenerationBlocksWithDeferredResults(message.blocks, deferredResults);
    return blocks === message.blocks ? message : { ...message, blocks };
  });
}

function assertAvailableModelOverride(engine, settings) {
  if (!settings.modelOverrideEnabled || !settings.modelOverrideModel) return;
  const { id, provider } = settings.modelOverrideModel;
  try {
    const found = findModel(engine.availableModels || [], id, provider);
    if (found) return;
  } catch {
    // Fall through to the explicit 400 below.
  }
  const err: any = new Error(`Model override not available: ${provider}/${id}`);
  err.status = 400;
  throw err;
}

function channelWorkflowActivitySessionPath(channelId: string) {
  return `channel:${channelId}`;
}

function safeWorkflowActivityText(value: any, fallback: string) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizeChannelWorkflowNodes(workflowPlan: any) {
  const nodes = Array.isArray(workflowPlan?.nodes) ? workflowPlan.nodes : [];
  return nodes
    .filter((node) => node && typeof node === "object")
    .slice(0, 80)
    .map((node, index) => {
      const id = safeWorkflowActivityText(node.id, `node-${index + 1}`);
      return {
        id,
        label: safeWorkflowActivityText(node.title ?? node.label, id),
        agentId: typeof node.agentId === "string" && node.agentId.trim() ? node.agentId.trim() : null,
      };
    });
}

function startChannelWorkflowActivity(hub: any, channelId: string, workflowPlan: any) {
  const activityHub = hub?.activityHub || hub?.engine?.activityHub || null;
  if (!activityHub?.upsert || !workflowPlan || typeof workflowPlan !== "object") return null;

  const sessionPath = channelWorkflowActivitySessionPath(channelId);
  const startedAt = Date.now();
  const taskId = `channel-workflow-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const summary = safeWorkflowActivityText(workflowPlan.title ?? workflowPlan.name ?? workflowPlan.id, "Channel workflow");
  const nodes = normalizeChannelWorkflowNodes(workflowPlan);

  activityHub.upsert({
    id: taskId,
    kind: "workflow",
    status: "running",
    sessionPath,
    agentId: null,
    summary,
    startedAt,
  });

  for (const node of nodes) {
    activityHub.upsert({
      id: `${taskId}::${node.id}`,
      kind: "workflow_agent",
      status: "running",
      sessionPath,
      parentTaskId: taskId,
      agentId: node.agentId,
      label: node.label,
      phaseLabel: summary,
      startedAt,
    });
  }

  return { activityHub, taskId, sessionPath, nodeIds: nodes.map((node) => `${taskId}::${node.id}`) };
}

function finishChannelWorkflowActivity(record: any, status: "done" | "failed", summary?: string) {
  if (!record?.activityHub?.upsert) return;
  const finishedAt = Date.now();
  record.activityHub.upsert({
    id: record.taskId,
    status,
    finishedAt,
    ...(summary ? { summary } : {}),
  });
  for (const nodeId of record.nodeIds || []) {
    record.activityHub.upsert({
      id: nodeId,
      status,
      finishedAt,
      ...(summary && status === "failed" ? { summary } : {}),
    });
  }
}

export function createChannelsRoute(engine: any, hub: any) {
  const route = new Hono<any>();

  function isPhoneEnabled() {
    return engine.isChannelsEnabled?.() !== false;
  }

  function phoneDisabledResponse(c) {
    return c.json({ error: "Agent phone is disabled" }, 503);
  }

  function requirePhoneEnabled(c) {
    return isPhoneEnabled() ? null : phoneDisabledResponse(c);
  }

  function resolveChannelText(value, key) {
    return value === key ? t(key) : value;
  }

  function channelIdFromDisplayName(name) {
    const slug = String(name || "")
      .trim()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    return slug || undefined;
  }

  /** User bookmark file path. */
  function userBookmarkPath() {
    return path.join(engine.userDir, "channel-bookmarks.md");
  }

  /** Validate that a channel id cannot escape channelsDir. */
  function safeChannelPath(id) {
    const filePath = path.join(engine.channelsDir, `${id}.md`);
    const resolved = path.resolve(filePath);
    const base = path.resolve(engine.channelsDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return null;
    }
    return resolved;
  }

  function safeAgentDir(agentId) {
    if (!agentId || /[/\\]|\.\./.test(agentId)) return null;
    const resolved = path.resolve(path.join(engine.agentsDir, agentId));
    const base = path.resolve(engine.agentsDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
    if (engine.getAgent?.(agentId)) return resolved;
    if (fs.existsSync(resolved)) return resolved;
    return null;
  }

  async function readConversationPhoneSettings(id, c) {
    if (id.startsWith("dm:")) {
      const agent = resolveAgent(engine, c);
      const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(agent.agentDir, id));
      return {
        mode: normalizeAgentPhoneToolMode(projection.meta.toolMode),
        replyMinChars: readOptionalPositiveInt(projection.meta.replyMinChars),
        replyMaxChars: readOptionalPositiveInt(projection.meta.replyMaxChars),
        proactiveEnabled: DEFAULT_AGENT_PHONE_SETTINGS.proactiveEnabled,
        reminderIntervalMinutes: DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes,
        guardLimit: DEFAULT_AGENT_PHONE_SETTINGS.guardLimit,
        modelOverrideEnabled: false,
        modelOverrideModel: null,
      };
    }
    const filePath = safeChannelPath(id);
    if (!filePath) {
      const err: any = new Error("Invalid conversation id");
      err.status = 400;
      throw err;
    }
    if (!fs.existsSync(filePath)) {
      const err: any = new Error("Channel not found");
      err.status = 404;
      throw err;
    }
    return readChannelPhoneSettingsFromMeta(getChannelMeta(filePath));
  }

  async function writeConversationPhoneSettings(id, settings, c) {
    if (id.startsWith("dm:")) {
      const peerId = id.slice(3);
      if (!peerId || /[/\\]|\.\./.test(peerId)) {
        const err: any = new Error("Invalid DM peer id");
        err.status = 400;
        throw err;
      }
      const agent = resolveAgent(engine, c);
      await updateAgentPhoneProjectionMeta({
        agentDir: agent.agentDir,
        agentId: agent.id,
        conversationId: id,
        conversationType: "dm",
        patch: {
          toolMode: settings.mode,
          replyMinChars: settings.replyMinChars || "",
          replyMaxChars: settings.replyMaxChars || "",
        },
      });
      return {
        ...settings,
        proactiveEnabled: DEFAULT_AGENT_PHONE_SETTINGS.proactiveEnabled,
        guardLimit: DEFAULT_AGENT_PHONE_SETTINGS.guardLimit,
      };
    }
    const filePath = safeChannelPath(id);
    if (!filePath) {
      const err: any = new Error("Invalid conversation id");
      err.status = 400;
      throw err;
    }
    if (!fs.existsSync(filePath)) {
      const err: any = new Error("Channel not found");
      err.status = 404;
      throw err;
    }
    assertAvailableModelOverride(engine, settings);
    const memberCount = getChannelMembers(filePath).length;
    const guardLimit = settings.guardLimit || defaultAgentPhoneGuardLimit(memberCount);
    updateChannelMeta(filePath, {
      agentPhoneToolMode: settings.mode,
      agentPhoneReplyMinChars: settings.replyMinChars || "",
      agentPhoneReplyMaxChars: settings.replyMaxChars || "",
      agentPhoneProactiveEnabled: settings.proactiveEnabled ? "true" : "false",
      agentPhoneReminderIntervalMinutes: settings.reminderIntervalMinutes,
      agentPhoneGuardLimit: guardLimit,
      agentPhoneModelOverrideEnabled: settings.modelOverrideEnabled ? "true" : "false",
      agentPhoneModelOverrideId: settings.modelOverrideEnabled && settings.modelOverrideModel ? settings.modelOverrideModel.id : "",
      agentPhoneModelOverrideProvider: settings.modelOverrideEnabled && settings.modelOverrideModel ? settings.modelOverrideModel.provider : "",
    });
    hub?.refreshChannelProactiveSchedule?.();
    hub?.channelRouter?.refreshProactiveSchedule?.();
    return { ...settings, guardLimit };
  }

  function roleCounts(memberRoles: any) {
    const counts: Record<string, number> = { project_manager: 0, admin: 0, worker: 0 };
    for (const role of Object.values(memberRoles || {})) {
      const key = String(role);
      if (key in counts) counts[key] += 1;
    }
    return counts;
  }

  async function syncChannelAvailability() {
    try {
      await hub?.channelRouter?.syncAvailability?.();
    } catch (err) {
      debugLog()?.warn?.("api", `channel availability sync failed: ${err.message}`);
    }
  }

  route.get("/conversations/:id/agent-activities", async (c) => {
    const disabled = requirePhoneEnabled(c);
    if (disabled) return disabled;
    const id = c.req.param("id");
    return c.json({
      activities: hub?.agentPhoneActivities?.snapshot?.(id) || [],
      ticker: hub?.channelRouter?.tickerSnapshot?.(id) || hub?.tickerSnapshot?.(id) || null,
    });
  });

  route.get("/conversations/:id/agent-phone-settings", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const id = c.req.param("id");
      return c.json(await readConversationPhoneSettings(id, c));
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.post("/conversations/:id/agent-phone-settings", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const id = c.req.param("id");
      const body = await safeJson(c);
      const settings = normalizePhoneSettingsPayload(body);
      const saved = await writeConversationPhoneSettings(id, settings, c);
      return c.json({ ok: true, ...(saved || settings) });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.get("/conversations/:id/agent-phone-tool-mode", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const settings = await readConversationPhoneSettings(c.req.param("id"), c);
      return c.json({ mode: settings.mode });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.post("/conversations/:id/agent-phone-tool-mode", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const id = c.req.param("id");
      const current = await readConversationPhoneSettings(id, c).catch(() => ({
        ...DEFAULT_AGENT_PHONE_SETTINGS,
        mode: DEFAULT_AGENT_PHONE_SETTINGS.toolMode,
      }));
      const body = await safeJson(c);
      const settings = { ...current, mode: normalizeAgentPhoneToolMode(body.mode) };
      await writeConversationPhoneSettings(id, settings, c);
      return c.json({ ok: true, mode: settings.mode });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  // List all channels.
  route.get("/channels", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const channelsDir = engine.channelsDir;
      if (!channelsDir || !fs.existsSync(channelsDir)) {
        return c.json({ channels: [], bookmarks: {} });
      }

      const files = fs.readdirSync(channelsDir).filter(f => f.endsWith(".md"));
      const bookmarks = readBookmarks(userBookmarkPath());

      const channels = [];
      for (const f of files) {
        const channelId = f.replace(".md", "");
        const filePath = path.join(channelsDir, f);
        const content = fs.readFileSync(filePath, "utf-8");
        const { meta, messages } = parseChannel(content);
        const members = Array.isArray(meta.members) ? meta.members : [];
        const memberRoles = getChannelMemberRoles(filePath);
        const displayName = resolveChannelText(meta.name || channelId, "error.defaultChannelName");
        const displayDescription = resolveChannelText(meta.description || "", "error.defaultChannelDesc");

        const lastMsg = messages[messages.length - 1];
        const bookmark = bookmarks.get(channelId);

        let newMessageCount = 0;
        if (bookmark && bookmark !== "never") {
          newMessageCount = messages.filter(m => m.timestamp > bookmark).length;
        } else {
          newMessageCount = messages.length;
        }

        channels.push({
          id: channelId,
          name: displayName,
          description: displayDescription,
          members,
          memberRoles,
          roleCounts: roleCounts(memberRoles),
          messageCount: messages.length,
          newMessageCount,
          lastMessage: lastMsg?.body?.slice(0, 60) || "",
          lastSender: lastMsg?.sender || "",
          lastTimestamp: lastMsg?.timestamp || "",
        });
      }

      channels.sort((a, b) =>
        (b.lastTimestamp || "").localeCompare(a.lastTimestamp || "")
      );

      const bookmarksObj = {};
      for (const [k, v] of bookmarks) bookmarksObj[k] = v;

      return c.json({ channels, bookmarks: bookmarksObj });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Create a channel.
  route.post("/channels", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const body = await safeJson(c);
      const { name, description, members, memberRoles, intro } = body;

      if (!name || typeof name !== "string") {
        return c.json({ error: "name is required" }, 400);
      }
      let normalizedMembers;
      try {
        normalizedMembers = assertValidChannelMembers(members);
      } catch (err) {
        return c.json({ error: err.message }, 400);
      }

      for (const memberId of normalizedMembers) {
        if (!safeAgentDir(memberId)) {
          return c.json({ error: `Agent not found: ${memberId}`, code: "CHANNEL_AGENT_NOT_FOUND" }, 404);
        }
      }

      const { id: channelId } = await engine.createChannelEntry({
        id: channelIdFromDisplayName(name),
        name,
        description: description || undefined,
        members: normalizedMembers,
        memberRoles,
        intro: intro || undefined,
      });


      debugLog()?.log("api", `POST /channels - created "${channelId}" (${name}) members=[${normalizedMembers}]`);
      return c.json({
        ok: true,
        id: channelId,
        name,
        members: normalizedMembers,
        memberRoles: engine.getChannelMemberRoles(channelId),
      });
    } catch (err) {
      if (/exists|already|已存在/i.test(String(err.message || ""))) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  // Read channel messages.
  route.get("/channels/:name", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      if (!fs.existsSync(filePath)) {
        return c.json({ error: "Channel not found" }, 404);
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const { meta, messages } = parseChannel(content);
      const resolvedMessages = resolveChannelMessageDeferredBlocks(messages, engine.deferredResults);
      const members = Array.isArray(meta.members) ? meta.members : [];
      const memberRoles = getChannelMemberRoles(filePath);
      const displayName = resolveChannelText(meta.name || name, "error.defaultChannelName");
      const displayDescription = resolveChannelText(meta.description || "", "error.defaultChannelDesc");

      return c.json({
        id: meta.id || name,
        name: displayName,
        description: displayDescription,
        messages: resolvedMessages,
        members,
        memberRoles,
        roleCounts: roleCounts(memberRoles),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/channels/:name/roles", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);
      if (!fs.existsSync(filePath)) return c.json({ error: "Channel not found" }, 404);

      const body = await safeJson(c);
      const { memberId, role } = body;
      if (!memberId || typeof memberId !== "string") {
        return c.json({ error: "memberId is required" }, 400);
      }
      if (!role || typeof role !== "string") {
        return c.json({ error: "role is required" }, 400);
      }

      const memberRoles = engine.updateChannelMemberRole(name, memberId, role);
      return c.json({
        ok: true,
        memberRoles,
        roleCounts: roleCounts(memberRoles),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/channels/:name/agents", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);
      if (!fs.existsSync(filePath)) return c.json({ error: "Channel not found" }, 404);

      const body = await safeJson(c);
      const { name: agentName, yuan, role, homeFolder, home_folder, cwd } = body;
      if (!agentName || typeof agentName !== "string" || !agentName.trim()) {
        return c.json({ error: "name is required" }, 400);
      }

      const created = await engine.createAgent({
        name: agentName.trim(),
        yuan,
        homeFolder: homeFolder ?? home_folder ?? cwd,
      });
      try {
        const memberRoles = engine.addAgentToChannel(name, created.id, role || "worker");
        await syncChannelAvailability();
        debugLog()?.log("api", `POST /channels/${name}/agents created "${created.id}" as ${memberRoles[created.id]}`);
        return c.json({
          ok: true,
          agent: created,
          memberRoles,
          roleCounts: roleCounts(memberRoles),
        });
      } catch (err) {
        try { await engine.deleteAgent(created.id); } catch { /* rollback best effort */ }
        throw err;
      }
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  // Add a member to a channel.
  route.post("/channels/:name/members", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);
      if (!fs.existsSync(filePath)) return c.json({ error: "Channel not found" }, 404);

      const body = await safeJson(c);
      const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
      const role = typeof body.role === "string" ? body.role : undefined;
      if (!memberId) return c.json({ error: "memberId is required" }, 400);

      const agentDir = safeAgentDir(memberId);
      if (!agentDir) return c.json({ error: "Agent not found" }, 404);

      const memberRoles = engine.addAgentToChannel(name, memberId, role);

      const nextMembers = getChannelMembers(filePath);
      await syncChannelAvailability();
      debugLog()?.log("api", `POST /channels/${name}/members member=${memberId}`);
      return c.json({
        ok: true,
        members: nextMembers,
        memberRoles,
        roleCounts: roleCounts(memberRoles),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.delete("/channels/:name/members/:memberId", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const memberId = c.req.param("memberId");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);
      if (!fs.existsSync(filePath)) return c.json({ error: "Channel not found" }, 404);
      if (!memberId || /[/\\]|\.\./.test(memberId)) return c.json({ error: "Invalid member id" }, 400);

      const members = getChannelMembers(filePath);
      if (!members.includes(memberId)) {
        const memberRoles = getChannelMemberRoles(filePath);
        return c.json({
          ok: true,
          members,
          memberRoles,
          roleCounts: roleCounts(memberRoles),
        });
      }

      const nextMembers = members.filter((id) => id !== memberId);

      removeChannelMember(filePath, memberId);
      const agentDir = safeAgentDir(memberId);
      if (agentDir) {
        removeBookmarkEntry(path.join(agentDir, "channels.md"), name);
      }
      hub?.abortAgentPhoneSessions?.("channel-member-removed", {
        agentId: memberId,
        conversationId: name,
        conversationType: "channel",
      });

      const memberRoles = getChannelMemberRoles(filePath);
      await syncChannelAvailability();
      debugLog()?.log("api", `DELETE /channels/${name}/members/${memberId}`);
      return c.json({
        ok: true,
        members: nextMembers,
        memberRoles,
        roleCounts: roleCounts(memberRoles),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/channels/:name/messages", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      const reqBody = await safeJson(c);
      const body = typeof reqBody.body === "string" ? reqBody.body : "";
      const blocks = Array.isArray(reqBody.blocks)
        ? reqBody.blocks.filter((block) => block && typeof block === "object" && typeof block.type === "string")
        : [];
      const resources = Array.isArray(reqBody.resources)
        ? reqBody.resources.filter((resource) => resource && typeof resource === "object" && typeof resource.resourceId === "string")
        : [];

      if (!body.trim() && blocks.length === 0 && resources.length === 0) {
        return c.json({ error: "body is required" }, 400);
      }

      if (!fs.existsSync(filePath)) {
        return c.json({ error: "Channel not found" }, 404);
      }

      const senderName = engine.userName || "user";
      const result = appendMessage(filePath, senderName, body, { blocks, resources });

      debugLog()?.log("api", `POST /channels/${name}/messages`);

      // Extract @ mentions.
      const mentionedAgents = extractMentionedAgentIds(body, {
        channelMembers: getChannelMembers(filePath),
        agents: engine.listAgents?.() || [],
      });

      const triggerDelivery = hub.triggerChannelDelivery || hub.triggerChannelTriage;
      triggerDelivery?.call(hub, name, { mentionedAgents })?.catch(err =>
        console.error(`[channel] trigger delivery failed: ${err.message}`)
      );

      return c.json({ ok: true, timestamp: result.timestamp });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Trigger channel delivery manually.
  route.post("/channels/:name/trigger", async (c) => {
    let workflowActivity = null;
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);
      if (!fs.existsSync(filePath)) return c.json({ error: "Channel not found" }, 404);

      const body = await safeJson(c).catch(() => ({}));
      const mentionedAgents = Array.isArray(body.mentionedAgents)
        ? body.mentionedAgents.filter((id) => typeof id === "string" && id)
        : [];
      const triggerDelivery = hub.triggerChannelDelivery || hub.triggerChannelTriage;
      workflowActivity = startChannelWorkflowActivity(hub, name, body.workflowPlan);
      await triggerDelivery?.call(hub, name, {
        mentionedAgents,
        source: body.source || "manual",
        force: true,
      });
      finishChannelWorkflowActivity(workflowActivity, "done");

      return c.json({
        ok: true,
        ...(workflowActivity
          ? { workflowActivity: { taskId: workflowActivity.taskId, sessionPath: workflowActivity.sessionPath } }
          : {}),
      });
    } catch (err) {
      finishChannelWorkflowActivity(workflowActivity, "failed", err.message);
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/channels/:name/read", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      const body = await safeJson(c);
      const { timestamp } = body;

      if (!timestamp) {
        return c.json({ error: "timestamp is required" }, 400);
      }

      updateBookmark(userBookmarkPath(), name, timestamp);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Delete a channel.
  route.delete("/channels/:name", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      engine.deleteChannelByName(name);
      debugLog()?.log("api", `DELETE /channels/${name}`);
      return c.json({ ok: true });
    } catch (err) {
      if (/not found|does not exist|不存在/i.test(String(err.message || ""))) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  // Toggle channels through engine.setChannelsEnabled.
  route.post("/channels/toggle", async (c) => {
    const body = await safeJson(c);
    const { enabled } = body;
    await engine.setChannelsEnabled(!!enabled);
    debugLog()?.log("api", `POST /channels/toggle enabled=${!!enabled}`);
    return c.json({ ok: true, enabled: !!enabled });
  });

  return route;
}
