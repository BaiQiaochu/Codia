// @ts-nocheck
import {
  buildNotifyAgentRunPrompt,
  buildPluginActionAgentRunPrompt,
  createAgentSessionAutomationExecutor,
} from "./agent-run-automation.ts";

export const AUTOMATION_SCHEMA_VERSION = 3;

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeSchemaVersion(value) {
  if (Number.isInteger(value) && value > AUTOMATION_SCHEMA_VERSION) return value;
  return AUTOMATION_SCHEMA_VERSION;
}

function normalizeActorAgentId(job) {
  if (typeof job?.actorAgentId === "string" && job.actorAgentId.trim()) return job.actorAgentId.trim();
  if (typeof job?.legacyRef?.agentId === "string" && job.legacyRef.agentId.trim()) return job.legacyRef.agentId.trim();
  return null;
}

function deriveTriggerFromLegacyCronJob(job = {}) {
  if (job.type === "at") return { kind: "at", schedule: job.schedule };
  if (job.type === "every") {
    const intervalMs = typeof job.schedule === "number" ? job.schedule : parseInt(job.schedule, 10);
    return { kind: "every", intervalMs };
  }
  if (job.type === "cron") return { kind: "cron", expression: job.schedule };
  return null;
}

export function triggerFromLegacyCronJob(job = {}) {
  const existing = job.trigger && typeof job.trigger === "object" && !Array.isArray(job.trigger)
    ? clone(job.trigger)
    : null;
  const derived = deriveTriggerFromLegacyCronJob(job);
  if (existing && derived && existing.kind === derived.kind) return { ...existing, ...derived };
  if (derived) return derived;
  if (existing) return existing;
  return { kind: "unknown", schedule: job.schedule };
}

export function executorFromLegacyCronJob(job = {}) {
  const existing = job.executor && typeof job.executor === "object" && !Array.isArray(job.executor)
    ? clone(job.executor)
    : null;
  const actorAgentId = normalizeActorAgentId(job);

  if (existing?.kind === "direct_action" && existing.action === "notify") {
    const prompt = buildNotifyAgentRunPrompt(existing.params || {});
    return createAgentSessionAutomationExecutor({
      agentId: existing.agentId || actorAgentId,
      prompt,
      model: hasOwn(job, "model") ? clone(job.model ?? "") : "",
      executionContext: hasOwn(job, "executionContext") ? clone(job.executionContext || null) : null,
      migratedFrom: {
        kind: "direct_action",
        action: "notify",
      },
    });
  }

  if (existing?.kind === "plugin_action") {
    const pluginId = typeof existing.pluginId === "string" ? existing.pluginId.trim() : "";
    const actionId = typeof existing.actionId === "string" ? existing.actionId.trim() : "";
    if (pluginId && actionId) {
      const prompt = buildPluginActionAgentRunPrompt({
        pluginId,
        actionId,
        params: existing.params && typeof existing.params === "object" && !Array.isArray(existing.params)
          ? existing.params
          : {},
      });
      return createAgentSessionAutomationExecutor({
        agentId: existing.agentId || actorAgentId,
        prompt,
        model: hasOwn(job, "model") ? clone(job.model ?? "") : "",
        executionContext: hasOwn(job, "executionContext") ? clone(job.executionContext || null) : null,
        migratedFrom: {
          kind: "plugin_action",
          pluginId,
          actionId,
        },
      });
    }
  }

  if (existing && existing.kind !== "agent_session") return existing;

  if (existing?.kind === "agent_session") {
    const existingAgentId = typeof existing.agentId === "string" && existing.agentId.trim()
      ? existing.agentId.trim()
      : null;
    return {
      ...existing,
      kind: "agent_session",
      agentId: actorAgentId || existingAgentId,
      prompt: typeof job.prompt === "string"
        ? job.prompt
        : typeof existing.prompt === "string"
          ? existing.prompt
          : "",
      model: hasOwn(job, "model") ? clone(job.model ?? "") : clone(existing.model ?? ""),
      executionContext: hasOwn(job, "executionContext")
        ? clone(job.executionContext || null)
        : clone(existing.executionContext ?? null),
    };
  }

  return {
    kind: "agent_session",
    agentId: actorAgentId,
    prompt: typeof job.prompt === "string" ? job.prompt : "",
    model: clone(job.model ?? ""),
    executionContext: clone(job.executionContext || null),
  };
}

export function createdByFromLegacyCronJob(job = {}) {
  if (job.createdBy && typeof job.createdBy === "object" && !Array.isArray(job.createdBy)) {
    return clone(job.createdBy);
  }
  const agentId = normalizeActorAgentId(job);
  return agentId ? { kind: "agent", agentId } : { kind: "unknown" };
}

export function normalizeAutomationJob(job = {}) {
  const executor = executorFromLegacyCronJob(job);
  const prompt = typeof job.prompt === "string" && job.prompt
    ? job.prompt
    : executor?.kind === "agent_session" && typeof executor.prompt === "string"
      ? executor.prompt
      : job.prompt;
  return {
    ...job,
    prompt,
    schemaVersion: normalizeSchemaVersion(job.schemaVersion),
    trigger: triggerFromLegacyCronJob(job),
    executor,
    createdBy: createdByFromLegacyCronJob(job),
  };
}

export function normalizeAutomationJobs(jobs = []) {
  return Array.isArray(jobs) ? jobs.map((job) => normalizeAutomationJob(job)) : [];
}

export function patchAutomationJobForMigration(job = {}) {
  const normalized = normalizeAutomationJob(job);
  return {
    ...job,
    prompt: normalized.prompt,
    schemaVersion: normalized.schemaVersion,
    trigger: normalized.trigger,
    executor: normalized.executor,
    createdBy: normalized.createdBy,
  };
}
