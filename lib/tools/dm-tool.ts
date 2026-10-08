// @ts-nocheck
/**
 * Agent direct-message tool.
 *
 * Writes the same message into both agents' dm/ folders and then notifies the
 * DM router. The target can be the exact agent id or a unique display name.
 */

import { Type } from "@sinclair/typebox";
import { t } from "../i18n.ts";
import fs from "fs";
import path from "path";
import { appendMessage } from "../channels/channel-store.ts";
import { resolveAgentParam } from "./agent-id-resolver.ts";

const EXPLICIT_ONLY_DESCRIPTION =
  "Only use this tool when the user explicitly asks you to send a direct message to another agent. " +
  "Do not use this tool by default. ";

function ensureDmFile(dmDir, peerId) {
  fs.mkdirSync(dmDir, { recursive: true });
  const filePath = path.join(dmDir, `${peerId}.md`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `---\npeer: ${peerId}\n---\n`, "utf-8");
  }
  return filePath;
}

function formatAgentEntry(agent) {
  const label = agent.name && agent.name !== agent.id ? `${agent.id} (${agent.name})` : agent.id;
  const parts = [label];
  if (agent.model) parts.push(`[${agent.model}]`);
  if (agent.summary) parts.push(agent.summary);
  return parts.join(" - ");
}

export function createDmTool({ agentId, agentsDir, listAgents, onDmSent, isEnabled }) {
  return {
    name: "dm",
    label: t("toolDef.dm.label"),
    description: `${EXPLICIT_ONLY_DESCRIPTION}${t("toolDef.dm.description")}`,
    parameters: Type.Object({
      to: Type.String({ description: t("toolDef.dm.toDesc") }),
      message: Type.String({ description: t("toolDef.dm.messageDesc") }),
    }),

    execute: async (_toolCallId, params) => {
      if (isEnabled && !isEnabled()) {
        return {
          content: [{ type: "text", text: t("error.channelsDisabled") }],
          details: { action: "dm", error: "phone disabled" },
        };
      }
      const agents = listAgents();
      const resolved = resolveAgentParam(agents, params.to);
      if (!resolved.ok) {
        const candidates = resolved.ambiguous
          ? resolved.byName
          : agents.filter(agent => agent.id !== agentId);
        return {
          content: [{
            type: "text",
            text: t("error.agentNotFoundAvailable", {
              id: params.to,
              ids: candidates.map(formatAgentEntry).join("\n") || "(none)",
            }),
          }],
        };
      }

      const toId = resolved.agentId;
      if (toId === agentId) {
        return { content: [{ type: "text", text: t("error.cannotSelfDm") }] };
      }

      const target = agents.find(agent => agent.id === toId);

      const myDmDir = path.join(agentsDir, agentId, "dm");
      const myDmFile = ensureDmFile(myDmDir, toId);
      await appendMessage(myDmFile, agentId, params.message);

      const peerDmDir = path.join(agentsDir, toId, "dm");
      const peerDmFile = ensureDmFile(peerDmDir, agentId);
      await appendMessage(peerDmFile, agentId, params.message);

      if (onDmSent) {
        try {
          onDmSent(agentId, toId);
        } catch {
          // The message is already persisted; router notification is best effort.
        }
      }

      return {
        content: [{ type: "text", text: t("error.dmSent", { name: target?.name || toId }) }],
        details: { from: agentId, to: toId },
      };
    },
  };
}
