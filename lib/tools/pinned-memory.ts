// @ts-nocheck
/**
  *
 *
 * Lets agents manage pinned memory through tool calls while keeping
 * pinned.md readable and maintaining a structured entity store.
 */

import { Type } from "@sinclair/typebox";
import { t } from "../i18n.ts";
import { scrubPII } from "../pii-guard.ts";
import { createModuleLogger } from "../debug-log.ts";
import {
  addPinnedMemoryItem,
  readPinnedMemoryItems,
  removePinnedMemoryItems,
} from "../memory/pinned-memory-store.ts";

const log = createModuleLogger("pin_memory");

/**
 * Create pin_memory + unpin_memory tools.
 * @param {string} agentDir - Agent data directory.
 * @returns {[import('../pi-sdk/index.ts').ToolDefinition, import('../pi-sdk/index.ts').ToolDefinition]}
 */
export function createPinnedMemoryTools(agentDir) {
  const pinTool = {
    name: "pin_memory",
    label: t("toolDef.pinnedMemory.pinLabel"),
    description: t("toolDef.pinnedMemory.pinDescription"),
    parameters: Type.Object({
      content: Type.String({ description: t("toolDef.pinnedMemory.pinContentDesc") }),
    }),
    execute: async (_toolCallId, params) => {
      const { cleaned, detected } = scrubPII(params.content);
      if (detected.length > 0) {
        log.warn(`PII detected (${detected.join(", ")}), redacted before storage`);
      }

      const content = cleaned;
      const result = addPinnedMemoryItem(agentDir, content);
      if (result.alreadyExists) {
        return {
          content: [{ type: "text", text: t("error.pinnedAlreadyExists") }],
          details: {},
        };
      }

      return {
        content: [{ type: "text", text: t("error.pinnedAdded", { content }) }],
        details: { item: result.item },
      };
    },
  };

  const unpinTool = {
    name: "unpin_memory",
    label: t("toolDef.pinnedMemory.unpinLabel"),
    description: t("toolDef.pinnedMemory.unpinDescription"),
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Pinned memory entity id returned by pin_memory" })),
      keyword: Type.Optional(Type.String({ description: t("toolDef.pinnedMemory.unpinKeywordDesc") })),
    }),
    execute: async (_toolCallId, params) => {
      const existing = readPinnedMemoryItems(agentDir);
      if (existing.length === 0) {
        return {
          content: [{ type: "text", text: t("error.pinnedEmpty") }],
          details: {},
        };
      }

      const result = removePinnedMemoryItems(agentDir, params);
      const removed = result.removed;

      if (removed.length === 0) {
        const keyword = params.keyword || params.id || "";
        return {
          content: [{ type: "text", text: t("error.pinnedNotFound", { keyword }) }],
          details: {},
        };
      }

      return {
        content: [{
          type: "text",
          text: t("error.pinnedRemoved", {
            count: removed.length,
            items: removed.map(item => item.content).join(", "),
          }),
        }],
        details: { removedCount: removed.length, removedItems: removed },
      };
    },
  };

  return [pinTool, unpinTool];
}
