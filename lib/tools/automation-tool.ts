// @ts-nocheck
import { Type, StringEnum } from "../pi-sdk/index.ts";
import { getToolSessionCwd, getToolSessionPath } from "./tool-session.ts";
import { createAgentSessionAutomationExecutor } from "../desk/agent-run-automation.ts";
import { applyConfirmedAutomationDraft } from "./automation-draft.ts";

function normalizeSchedule(params, existing = null) {
  const type = params.scheduleType || params.type || existing?.type;
  let schedule = params.schedule ?? existing?.schedule;
  if (!type || schedule === undefined || schedule === null || schedule === "") {
    throw new Error("scheduleType and schedule are required");
  }
  if (type === "every" && params.schedule !== undefined) {
    const minutes = parseInt(schedule, 10);
    if (Number.isNaN(minutes) || minutes <= 0) {
      throw new Error("every schedule must be a positive number of minutes");
    }
    schedule = minutes * 60_000;
  }
  return { type, schedule };
}

function contextForTool(ctx, {
  getSessionPath,
  getAgentId,
  getSessionCwd,
  getSessionWorkspaceFolders,
  getHomeCwd,
  targetAgentId,
} = {}) {
  const sessionPath = getToolSessionPath(ctx) || getSessionPath?.() || null;
  const sourceAgentId = getAgentId?.() || null;
  const actorAgentId = typeof targetAgentId === "string" && targetAgentId.trim()
    ? targetAgentId.trim()
    : sourceAgentId;
  const usesDifferentAgent = !!actorAgentId && !!sourceAgentId && actorAgentId !== sourceAgentId;
  const sessionCwd = getToolSessionCwd(ctx)
    || (sessionPath ? getSessionCwd?.(sessionPath) : null)
    || null;
  const agentHomeCwd = actorAgentId ? getHomeCwd?.(actorAgentId) : null;
  const cwd = usesDifferentAgent
    ? (agentHomeCwd || null)
    : (sessionCwd || agentHomeCwd || null);
  const workspaceFolders = sessionPath
    ? (usesDifferentAgent ? [] : (getSessionWorkspaceFolders?.(sessionPath) || []))
    : [];
  const bridgeContext = ctx?.bridgeContext?.isBridgeSession === true ? ctx.bridgeContext : null;
  return {
    sessionPath,
    bridgeContext,
    actorAgentId,
    executionContext: {
      kind: "session_workspace",
      cwd,
      workspaceFolders,
      sourceSessionPath: sessionPath,
      createdByAgentId: actorAgentId,
    },
  };
}

function targetAgentIdFor(params, fallbackAgentId) {
  return typeof params.agentId === "string" && params.agentId.trim()
    ? params.agentId.trim()
    : fallbackAgentId;
}

function pendingConfirmationText(label, confirmId) {
  const base = `Automation pending confirmation: ${label}`;
  if (!confirmId) return base;
  return `${base}\nConfirmation ID: ${confirmId}\nDesktop users can handle it in the confirmation card. Bridge users can reply /confirm ${confirmId} or /reject ${confirmId}.`;
}

function pendingSuggestionText(bridgeContext = null, suggestion = null) {
  if (bridgeContext?.interactionCapabilities?.confirmationMode === "text_command" && suggestion) {
    const shortCode = typeof suggestion.shortCode === "string" && suggestion.shortCode.trim()
      ? suggestion.shortCode.trim()
      : "";
    const applyVariants = shortCode ? `/apply or /apply ${shortCode}` : "/apply";
    return `I prepared an automation suggestion${shortCode ? ` (suggestion ID: ${shortCode})` : ""}. `
      + `This bridge platform is text-only. `
      + `The task will only be created after the user replies ${applyVariants}.`;
  }
  return "I prepared an automation suggestion and will wait for the user to apply it.";
}

function suggestionDetails({ suggestion, operation, jobData, jobs }) {
  const suggestionId = suggestion?.suggestionId || "";
  const shortCode = suggestion?.shortCode || suggestion?.suggestionShortCode || "";
  return {
    action: operation === "update" ? "pending_update" : "pending_add",
    operation,
    jobs,
    jobData,
    suggestionId,
    suggestionShortCode: shortCode,
    automationSuggestion: {
      suggestionId,
      shortCode,
      operation,
      jobData,
    },
  };
}

function labelFor(params, prompt = "", existing = null) {
  if (typeof params.label === "string" && params.label.trim()) return params.label;
  if (typeof existing?.label === "string" && existing.label.trim()) return existing.label;
  return typeof prompt === "string" ? prompt.slice(0, 40) : "";
}

function isDraftMutationAction(params) {
  return params?.action === "create" || params?.action === "update";
}

function automationDraftSideEffect() {
  return {
    kind: "deferred_mutation_draft",
    commit: "requires_user_confirmation",
    ruleId: "automation-draft-no-write",
    summary: "Automation create/update generates a pending suggestion; cron store writes only after the suggestion is applied.",
  };
}

function genericAgentRun(params, context, existing = null) {
  const prompt = typeof params.prompt === "string" && params.prompt.trim()
    ? params.prompt
    : (typeof existing?.prompt === "string" ? existing.prompt : "");
  if (!prompt) throw new Error("prompt is required");
  const model = params.model ?? existing?.model ?? "";
  return {
    prompt,
    executor: createAgentSessionAutomationExecutor({
      agentId: context.actorAgentId,
      prompt,
      model,
      executionContext: context.executionContext,
    }),
  };
}

function jobDataFieldsForMutation(jobData) {
  const {
    id: _id,
    createdAt: _createdAt,
    lastRunAt: _lastRunAt,
    nextRunAt: _nextRunAt,
    consecutiveErrors: _consecutiveErrors,
    legacyRef: _legacyRef,
    ...fields
  } = jobData || {};
  return fields;
}

function commitAutomationDraft({ cronStore, operation, jobData, confirmationValue }) {
  const confirmedJobData = applyConfirmedAutomationDraft(jobData, confirmationValue);
  if (operation === "update") {
    if (!confirmedJobData?.id) throw new Error("id is required");
    return cronStore.updateJob(confirmedJobData.id, jobDataFieldsForMutation(confirmedJobData));
  }
  return cronStore.addJob(confirmedJobData);
}

function attachDeferredMutation({ promise, cronStore, operation, jobData }) {
  void promise.then((result) => {
    if (result?.action !== "confirmed") return;
    commitAutomationDraft({ cronStore, operation, jobData, confirmationValue: result.value });
  }).catch(() => {});
}

export function createAutomationTool(cronStore, {
  getAutoApprove,
  autoApprove = false,
  confirmStore,
  getConfirmStore,
  automationSuggestionStore,
  getAutomationSuggestionStore,
  getSessionPath,
  getAgentId,
  getSessionCwd,
  getSessionWorkspaceFolders,
  getHomeCwd,
} = {}) {
  return {
    name: "automation",
    label: "Automation",
    description: "Create and update scheduled automation suggestions. The task is written only after the user applies the suggestion. Automations run as background Agent sessions.",
    sessionPermission: {
      describeSideEffect: (params) => {
        if (!isDraftMutationAction(params)) return null;
        const directlyCommits = getAutoApprove ? getAutoApprove() === true : autoApprove === true;
        return directlyCommits ? null : automationDraftSideEffect();
      },
    },
    parameters: Type.Object({
      action: StringEnum(["list", "create", "update"], {
        description: "Action to perform. create/update produce a pending suggestion instead of directly saving.",
      }),
      id: Type.Optional(Type.String({ description: "Automation job id for update." })),
      agentId: Type.Optional(Type.String({ description: "Target Agent id. Defaults to the current Agent." })),
      scheduleType: Type.Optional(StringEnum(["at", "every", "cron"], {
        description: "Trigger type for create/update actions.",
      })),
      schedule: Type.Optional(Type.String({
        description: "Trigger schedule. For every, use minutes. For cron, use a 5-field cron expression.",
      })),
      label: Type.Optional(Type.String({ description: "Short display label." })),
      prompt: Type.Optional(Type.String({ description: "What the target Agent should do when this automation runs." })),
      model: Type.Optional(Type.Any({ description: "Optional execution model for the background Agent run." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        if (params.action === "list") {
          const jobs = cronStore.listJobs();
          return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }], details: { action: "list", jobs } };
        }

        if (!["create", "update"].includes(params.action)) {
          throw new Error(`unknown automation action: ${params.action}`);
        }

        const operation = params.action === "update" ? "update" : "create";
        const existingJob = operation === "update" ? cronStore.getJob?.(params.id) : null;
        if (operation === "update" && !params.id) throw new Error("id is required");
        if (operation === "update" && !existingJob) throw new Error(`Automation not found: ${params.id}`);

        const sourceAgentId = getAgentId?.() || null;
        const targetAgentId = targetAgentIdFor(params, existingJob?.actorAgentId || sourceAgentId);
        const context = contextForTool(ctx, {
          getSessionPath,
          getAgentId,
          getSessionCwd,
          getSessionWorkspaceFolders,
          getHomeCwd,
          targetAgentId,
        });
        const { type, schedule } = normalizeSchedule(params, existingJob);
        const run = genericAgentRun(params, context, existingJob);
        const jobData = {
          ...(existingJob || {}),
          type,
          schedule,
          prompt: run.prompt,
          label: labelFor(params, run.prompt, existingJob),
          model: params.model ?? existingJob?.model ?? "",
          actorAgentId: context.actorAgentId,
          executionContext: context.executionContext,
          executor: run.executor,
          createdBy: {
            kind: "agent",
            agentId: context.actorAgentId,
            sourceSessionPath: context.sessionPath,
          },
        };

        if (getAutoApprove ? getAutoApprove() : autoApprove) {
          const job = commitAutomationDraft({ cronStore, operation, jobData });
          return {
            content: [{ type: "text", text: `Automation ${operation === "update" ? "updated" : "created"}: ${job.label} (${job.id})` }],
            details: { action: operation === "update" ? "updated" : "added", operation, job, jobs: cronStore.listJobs(), jobData, confirmed: true },
          };
        }

        const runtimeSuggestionStore = getAutomationSuggestionStore?.() || automationSuggestionStore || null;
        if (runtimeSuggestionStore?.create && context.sessionPath) {
          const suggestion = runtimeSuggestionStore.create({
            sessionPath: context.sessionPath,
            bridgeSessionKey: context.bridgeContext?.sessionKey || null,
            operation,
            jobData,
            apply: (value) => commitAutomationDraft({
              cronStore,
              operation,
              jobData,
              confirmationValue: value,
            }),
          });
          return {
            content: [{ type: "text", text: pendingSuggestionText(context.bridgeContext, suggestion) }],
            details: suggestionDetails({
              suggestion,
              operation,
              jobs: cronStore.listJobs(),
              jobData,
            }),
          };
        }

        const runtimeConfirmStore = getConfirmStore?.() || confirmStore || null;
        if (runtimeConfirmStore && context.sessionPath) {
          const { confirmId, promise } = runtimeConfirmStore.create("cron", { jobData, operation }, context.sessionPath);
          attachDeferredMutation({ promise, cronStore, operation, jobData });
          return {
            content: [{ type: "text", text: pendingConfirmationText(jobData.label, confirmId) }],
            details: { action: operation === "update" ? "pending_update" : "pending_add", operation, jobs: cronStore.listJobs(), jobData, confirmId },
          };
        }

        return {
          content: [{ type: "text", text: pendingConfirmationText(jobData.label, null) }],
          details: suggestionDetails({
            suggestion: null,
            operation,
            jobs: cronStore.listJobs(),
            jobData,
          }),
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: err.message }],
          details: { action: params.action, error: err.message, jobs: cronStore.listJobs() },
        };
      }
    },
  };
}
