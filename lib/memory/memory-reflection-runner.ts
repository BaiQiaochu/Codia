// @ts-nocheck
import { runSessionSnapshotSideTask } from "../llm/session-snapshot-side-task-runner.ts";
import { scrubPII } from "../pii-guard.ts";
import { getLocale } from "../i18n.ts";
import {
  MAX_ROLLING_SUMMARY_FORMAT_REPAIRS,
  buildRollingSummaryFormatRequirements,
  buildRollingSummaryRepairInput,
  validateRollingSummaryFormat,
} from "./rolling-summary-format.ts";

export const MEMORY_REFLECTION_TEMPLATE_VERSION = "memory-reflection.v1";

export function buildMemoryReflectionSuffix({ previousSummary = "", timeZone = "UTC", locale = getLocale() } = {}) {
  return {
    role: "user",
    content: [{
      type: "text",
      text: [
        "Internal memory reflection task.",
        "Read the session prefix above and produce an updated rolling memory summary.",
        "Do not call tools.",
        "Do not address the user.",
        `Time zone: ${timeZone}`,
        buildRollingSummaryFormatRequirements(locale),
        previousSummary ? `<previous-summary>\n${previousSummary}\n</previous-summary>` : "<previous-summary>\n\n</previous-summary>",
        "Return only the summary text.",
      ].join("\n\n"),
    }],
  };
}

export async function runMemoryReflection({
  snapshot,
  model,
  cacheKeyParams,
  previousSummary = "",
  sessionId,
  messages = [],
  sourceTimeRange = null,
  timeZone,
  streamFn,
  options = {},
  usageLedger,
  usageContext,
}: Record<string, any> = {}) {
  const locale = getLocale();
  let sideTask = await runSessionSnapshotSideTask({
    snapshot,
    model,
    cacheKeyParams,
    suffixMessage: buildMemoryReflectionSuffix({ previousSummary, timeZone, locale }),
    streamFn,
    options: {
      ...options,
      toolChoice: "none",
    },
    cacheGroup: "memory.reflection",
    templateVersion: MEMORY_REFLECTION_TEMPLATE_VERSION,
    usageLedger,
    usageContext,
  });

  let summary = sideTask.text.trim();
  let validation = validateRollingSummaryFormat(summary);
  for (let attempt = 0; summary && !validation.ok && attempt < MAX_ROLLING_SUMMARY_FORMAT_REPAIRS; attempt++) {
    const repairUsageContext = usageContext
      ? {
        ...usageContext,
        source: {
          ...(usageContext.source || {}),
          operation: "cache_snapshot_reflection_repair",
        },
      }
      : usageContext;
    sideTask = await runSessionSnapshotSideTask({
      snapshot,
      model,
      cacheKeyParams,
      suffixMessage: {
        role: "user",
        content: [{
          type: "text",
          text: buildRollingSummaryRepairInput({
            locale,
            issues: validation.issues,
            summaryText: summary,
          }),
        }],
      },
      streamFn,
      options: {
        ...options,
        toolChoice: "none",
      },
      cacheGroup: "memory.reflection",
      templateVersion: "memory-reflection-repair.v1",
      usageLedger,
      usageContext: repairUsageContext,
    });
    summary = sideTask.text.trim();
    validation = validateRollingSummaryFormat(summary);
  }
  if (summary && !validation.ok) {
    throw new Error(`rolling summary format validation failed: ${validation.issues.join("; ")}`);
  }

  const { cleaned, detected } = scrubPII(summary);
  if (detected.length > 0) summary = cleaned.trim();
  const now = new Date().toISOString();
  return {
    summary,
    changed: summary.length > 0,
    data: summary
      ? {
        session_id: sessionId,
        created_at: now,
        updated_at: now,
        summary,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        source_time_range: sourceTimeRange,
        snapshot: "",
        snapshot_at: null,
      }
      : null,
    usage: sideTask.response?.usage || null,
    metadata: sideTask.metadata,
    reason: detected.length > 0 ? "pii_redacted" : "",
  };
}
