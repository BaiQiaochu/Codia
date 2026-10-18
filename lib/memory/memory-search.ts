// @ts-nocheck
/**
 * memory-search.js -search_memory 工具（v2 标签棢索）
 *
  *
  * */

import { Type } from "@sinclair/typebox";
import { t } from "../i18n.ts";

/**
 * 创建 search_memory 工具定义
 * @param {import('./fact-store.ts').FactStore} factStore
 * @param {object} [opts]
  *
 */
export function createMemorySearchTool(factStore, opts = {}) {
  const conversationScope = opts?.conversationScope || null;
  const isChannelScope = conversationScope?.kind === "channel" && conversationScope?.channelId;
  const parameters = {
    query: Type.String({ description: t("error.memorySearchQueryDesc") }),
    tags: Type.Optional(
      Type.Array(Type.String(), {
        description: t("error.memorySearchTagsDesc"),
      }),
    ),
    date_from: Type.Optional(
      Type.String({ description: t("error.memorySearchDateFromDesc") }),
    ),
    date_to: Type.Optional(
      Type.String({ description: t("error.memorySearchDateToDesc") }),
    ),
  };
  if (isChannelScope) {
    parameters.cross_channel = Type.Optional(Type.Boolean({
      description: "Search across other channel memories instead of only this channel.",
    }));
  }
  return {
    name: "search_memory",
    label: t("error.memorySearchLabel"),
    description: t("error.memorySearchDesc"),
    parameters: Type.Object(parameters),
    execute: async (_toolCallId, params) => {
      try {
        const t0 = performance.now();

        if (factStore.size === 0) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
            details: {},
          };
        }

        const dateRange = {};
        if (params.date_from) dateRange.from = params.date_from;
        if (params.date_to) dateRange.to = params.date_to + "T23:59";

        let results = [];
        const seenIds = new Set();

 //
        if (params.tags && params.tags.length > 0) {
          const tagResults = factStore.searchByTags(
            params.tags,
            Object.keys(dateRange).length > 0 ? dateRange : undefined,
            15,
          );
          for (const r of tagResults) {
            seenIds.add(r.id);
            results.push({ ...r, retrieval: "tag" });
          }
        }

 // 策略 2：全文搜索补充（标签结果不足 3 条时-
        if (results.length < 3 && params.query) {
          const ftsResults = factStore.searchFullText(params.query, 10);
          for (const r of ftsResults) {
            if (seenIds.has(r.id)) continue;
            seenIds.add(r.id);
            results.push({ ...r, retrieval: "fts" });
          }
        }

 // 日期过滤（对 FTS 结果也应用）
        if (dateRange.from || dateRange.to) {
          results = results.filter((r) => {
            if (!r.time) return true; // 无时间的不做过滤
            if (!r.time) return true; if (dateRange.from && r.time < dateRange.from) return false;
            if (dateRange.to && r.time > dateRange.to) return false;
            return true;
          });
        }

        if (isChannelScope && params.cross_channel !== true) {
          const currentSessionId = `channel-${conversationScope.channelId}`;
          results = results.filter((r) => {
            const sessionId = r.session_id ?? r.sessionId ?? null;
            if (!sessionId) return true;
            if (sessionId === currentSessionId) return true;
            return !String(sessionId).startsWith("channel-");
          });
        }

        const elapsed = performance.now() - t0;
        console.log(
          `\x1b[90m[memory-search] ${elapsed.toFixed(0)}ms | ` +
          `hits: ${results.length} (tag: ${results.filter((r) => r.retrieval === "tag").length}, ` +
          `fts: ${results.filter((r) => r.retrieval === "fts").length})\x1b[0m`,
        );

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
            details: {},
          };
        }

        //
        const lines = results.map((r, i) => {
          const tagsStr = r.tags.length > 0 ? ` (${r.tags.join(", ")})` : "";
          const timeStr = r.time ? ` - ${r.time}` : "";
          return `${i + 1}. ${r.fact}${tagsStr}${timeStr}${r.status === "conflict" ? " [Conflict: needs user review]" : ""}${r.source ? ` [Source: ${r.source}]` : ""}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { resultCount: results.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.memorySearchError", { msg: err.message }) }],
          details: {},
        };
      }
    },
  };
}
