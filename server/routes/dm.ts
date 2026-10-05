// @ts-nocheck
/**
 * DM REST API.
 *
 * DM files live under agents/{agentId}/dm/{peerId}.md.
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { parseChannel } from "../../lib/channels/channel-store.ts";
import { resolveAgent } from "../utils/resolve-agent.ts";
import {
  getAgentPhoneProjectionPath,
  readAgentPhoneProjection,
  resetAgentPhoneProjection,
} from "../../lib/conversations/agent-phone-projection.ts";
import { resetAgentPhoneRuntime } from "../../lib/conversations/agent-phone-runtime.ts";

function requestedAgentId(c) {
  const value = c.req.query("agentId");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveDmOwnerAgent(engine, c) {
  if (requestedAgentId(c)) return resolveAgent(engine, c);
  const primaryAgentId = engine.getPrimaryAgentId?.() || null;
  if (!primaryAgentId) return resolveAgent(engine, c);
  const agent = engine.getAgent(primaryAgentId);
  if (!agent) throw new Error(`primary agent "${primaryAgentId}" not found`);
  return agent;
}

export function createDmRoute(engine, hub = null) {
  const route = new Hono();

  function isPhoneEnabled() {
    return engine.isChannelsEnabled?.() !== false;
  }

  function phoneDisabledResponse(c) {
    return c.json({ error: "Agent phone is disabled" }, 503);
  }

  function invalidPeerId(peerId) {
    return !peerId || /[/\\]|\.\./.test(peerId);
  }

  function dmProjectionMeta(agent, peerId) {
    try {
      return readAgentPhoneProjection(getAgentPhoneProjectionPath(agent.agentDir, `dm:${peerId}`)).meta;
    } catch {
      return {};
    }
  }

  function filterVisibleDmMessages(agent, peerId, messages) {
    const visibleAfterTimestamp = dmProjectionMeta(agent, peerId).visibleAfterTimestamp;
    if (!visibleAfterTimestamp || typeof visibleAfterTimestamp !== "string") return messages;
    return messages.filter((message) => !message.timestamp || message.timestamp > visibleAfterTimestamp);
  }

  route.get("/dm", async (c) => {
    try {
      if (!isPhoneEnabled()) return phoneDisabledResponse(c);
      const agent = resolveDmOwnerAgent(engine, c);
      if (!agent) return c.json({ dms: [] });

      const ownerAgentId = agent.id || path.basename(agent.agentDir);
      const dmDir = path.join(agent.agentDir, "dm");

      const existingDms = new Map();
      if (fs.existsSync(dmDir)) {
        for (const f of fs.readdirSync(dmDir).filter((name) => name.endsWith(".md"))) {
          const peerId = f.replace(".md", "");
          const filePath = path.join(dmDir, f);
          const content = fs.readFileSync(filePath, "utf-8");
          const { messages } = parseChannel(content);
          const visibleMessages = filterVisibleDmMessages(agent, peerId, messages);
          const lastMsg = visibleMessages[visibleMessages.length - 1];

          existingDms.set(peerId, {
            lastMessage: lastMsg?.body?.slice(0, 60) || "",
            lastSender: lastMsg?.sender || "",
            lastTimestamp: lastMsg?.timestamp || "",
            messageCount: visibleMessages.length,
          });
        }
      }

      const allAgents = engine.listAgents?.() || [];
      const dms = allAgents
        .filter((a) => a.id !== ownerAgentId)
        .map((a) => {
          const existing = existingDms.get(a.id);
          return {
            ownerAgentId,
            peerId: a.id,
            peerName: a.name || a.agentName || a.id,
            lastMessage: existing?.lastMessage || "",
            lastSender: existing?.lastSender || "",
            lastTimestamp: existing?.lastTimestamp || "",
            messageCount: existing?.messageCount || 0,
          };
        });

      dms.sort((a, b) => {
        if (a.lastTimestamp && !b.lastTimestamp) return -1;
        if (!a.lastTimestamp && b.lastTimestamp) return 1;
        if (a.lastTimestamp && b.lastTimestamp) return b.lastTimestamp.localeCompare(a.lastTimestamp);
        return a.peerName.localeCompare(b.peerName);
      });

      return c.json({ ownerAgentId, dms });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/dm/:peerId", async (c) => {
    try {
      if (!isPhoneEnabled()) return phoneDisabledResponse(c);
      const peerId = c.req.param("peerId");
      const agent = resolveDmOwnerAgent(engine, c);
      if (!agent) return c.json({ error: "No active agent" }, 400);
      const ownerAgentId = agent.id || path.basename(agent.agentDir);

      if (invalidPeerId(peerId)) {
        return c.json({ error: "Invalid peerId" }, 400);
      }

      const dmFile = path.join(agent.agentDir, "dm", `${peerId}.md`);
      const peerAgent = engine.getAgent(peerId);
      const peerName = peerAgent?.agentName || peerAgent?.name || peerId;
      if (!fs.existsSync(dmFile)) {
        return c.json({
          ownerAgentId,
          peerId,
          peerName,
          messages: [],
        });
      }

      const content = fs.readFileSync(dmFile, "utf-8");
      const { messages } = parseChannel(content);
      const visibleMessages = filterVisibleDmMessages(agent, peerId, messages);

      return c.json({
        ownerAgentId,
        peerId,
        peerName,
        messages: visibleMessages,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/dm/:peerId/reset", async (c) => {
    try {
      if (!isPhoneEnabled()) return phoneDisabledResponse(c);
      const peerId = c.req.param("peerId");
      if (invalidPeerId(peerId)) {
        return c.json({ error: "Invalid peerId" }, 400);
      }

      const agent = resolveDmOwnerAgent(engine, c);
      if (!agent) return c.json({ error: "No active agent" }, 400);
      const ownerAgentId = agent.id || path.basename(agent.agentDir);
      const dmFile = path.join(agent.agentDir, "dm", `${peerId}.md`);
      let visibleAfterTimestamp = "";
      if (fs.existsSync(dmFile)) {
        const content = fs.readFileSync(dmFile, "utf-8");
        const { messages } = parseChannel(content);
        visibleAfterTimestamp = messages[messages.length - 1]?.timestamp || "";
      }

      await resetAgentPhoneProjection({
        agentDir: agent.agentDir,
        agentId: ownerAgentId,
        conversationId: `dm:${peerId}`,
        conversationType: "dm",
        visibleAfterTimestamp,
        resetBy: ownerAgentId,
      });
      await resetAgentPhoneRuntime({
        agentDir: agent.agentDir,
        conversationId: `dm:${peerId}`,
      });
      hub?.abortAgentPhoneSessions?.("dm-reset", {
        agentId: ownerAgentId,
        conversationId: `dm:${peerId}`,
        conversationType: "dm",
      });

      return c.json({
        ok: true,
        ownerAgentId,
        peerId,
        visibleAfterTimestamp,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
