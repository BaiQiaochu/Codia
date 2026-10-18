// @ts-nocheck
// lib/tools/workflow-tool.js
import path from "node:path";
import { assertResolvedRuntimeSnapshot } from "../workflow/runtime-snapshot.ts";
import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import { runWorkflowScript } from "../workflow/sandbox.ts";
import { extractMeta } from "../workflow/meta.ts";
import { createHostApi } from "../workflow/host-api.ts";
import { createLimiter } from "../workflow/concurrency.ts";
import { createWorkflowExecutionLimits } from "../workflow/limits.ts";
import { WorkflowJournal } from "../workflow/journal.ts";
import { getToolSessionPath, getToolSessionCwd } from "./tool-session.ts";
import { toolOk, toolError } from "./tool-result.ts";

const WORKFLOW_DEADLINE_MS = 10 * 60 * 1000;
const WORKFLOW_TIMEOUT_BACKSTOP_MS = WORKFLOW_DEADLINE_MS + 30 * 1000;
const WORKFLOW_AGENT_MAX_CONCURRENT = 256;
const AGENT_TOTAL_BACKSTOP = 1000;
const WORKFLOW_DESCRIPTION = [
  "Run a deterministic JavaScript orchestration script that delegates all real work to workflow agent() nodes.",
  "Use this for controlled fan-out, cross-verification, staged synthesis, or dynamic loops where each item must be handled.",
  "The script must start with: export const meta = { name: string, description: string }.",
  "Available globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), workflow(script, args), phase(title), log(message), budget, args.",
  'agent() signature is agent(prompt, { label?, model?, agentType?, access?: "read"|"write", schema?, toolFilter? }).',
  'parallel(thunks, { failurePolicy?: "fail-fast"|"collect-errors" }) and pipeline(items, ...stages, options?) default to fail-fast. collect-errors waits for all branches then throws AggregateError with indexed results; failures never become null successes.',
  "Optional args.budgetTokens, args.maxSteps (1-1000), args.maxDurationMs (1-600000) bound dispatch; in-flight usage may exceed a token estimate.",
  "Always await agent(): const result = await agent('task prompt', { access: 'read', agentType: 'codia' }); agent() does not return { result }.",
  "To choose a target agent, use opts.agentType. Do not pass task in opts; put complete task instructions in the first prompt argument.",
  "The script cannot import modules or access require/process/fs/net. To read/write files or run tools, ask an agent() node to do it.",
].join("\n");

function buildParameters() {
  return Type.Object({
    script: Type.String({ description: t("toolDef.workflow.scriptDesc") }),
    args: Type.Optional(Type.Any({ description: t("toolDef.workflow.argsDesc") })),
    resumeFromRunId: Type.Optional(Type.String({
      description: t("toolDef.workflow.resumeFromRunIdDesc"),
    })),
  });
}

function makeLimiter() {
  return createLimiter({ maxConcurrent: WORKFLOW_AGENT_MAX_CONCURRENT, maxTotal: AGENT_TOTAL_BACKSTOP });
}

function usageTokens(usage) {
  if (!usage) return 0;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  return (usage.input?.totalTokens || 0) + (usage.output?.totalTokens || 0);
}

function sumNodeTokens(ledger, { childSessionId = null, childSessionPath = null } = {}) {
  if (!ledger?.list || (!childSessionId && !childSessionPath)) return null;
  const filter = childSessionId ? { childSessionId } : { childSessionPath };
  const { entries } = ledger.list(filter);
  if (!entries?.length) return null;
  return entries.reduce((sum, entry) => sum + usageTokens(entry.usage), 0);
}

function sessionIdForPath(deps, sessionPath) {
  const sessionId = deps.getSessionIdForPath?.(sessionPath);
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function sessionRefForPath(deps, sessionPath) {
  const sessionId = sessionIdForPath(deps, sessionPath);
  return sessionId ? { sessionId, sessionPath } : null;
}

function sessionInputForPath(deps, sessionPath) {
  return sessionRefForPath(deps, sessionPath) || sessionPath;
}

function journalPath(journalDir, runId) {
  if (!journalDir || !runId) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("Invalid workflow run ID");
  return path.join(journalDir, `${runId}.jsonl`);
}

function workflowSessionDir(deps, runId) {
  const root = deps.getWorkflowSessionDir?.();
  return root && runId ? path.join(root, runId) : null;
}

function assertWorkflowResult(result) {
  if (result === undefined) {
    throw new Error("workflow returned undefined. Return a string, object, array, number, boolean, or null.");
  }
  return result;
}

function workflowResultToText(result) {
  assertWorkflowResult(result);
  if (typeof result === "string") return result;
  let text;
  try {
    text = JSON.stringify(result, null, 2);
  } catch (err) {
    throw new Error(`workflow result is not JSON-serializable: ${err?.message || err}`);
  }
  if (text === undefined) {
    throw new Error("workflow returned a non-serializable result. Return a string, object, array, number, boolean, or null.");
  }
  return text;
}

function makeBudget(ledger, taskId, budgetTotal) {
  const total = typeof budgetTotal === "number" && budgetTotal > 0 ? budgetTotal : null;
  function spent() {
    if (!ledger?.list || !taskId) return 0;
    const { entries } = ledger.list({ attributionKind: "subagent" });
    if (!entries?.length) return 0;
    let sum = 0;
    for (const entry of entries) {
      const attr = entry.attribution;
      if (attr?.parentTaskId === taskId || attr?.subagentTaskId === taskId) {
        sum += usageTokens(entry.usage);
      }
    }
    return sum;
  }
  return {
    total,
    spent,
    remaining: () => total == null ? Infinity : Math.max(0, total - spent()),
  };
}

/**
 * @param {{
 *   executeIsolated: (prompt: string, isoOpts: object) => Promise<object>,
  *
 * }} deps
 */
export function createWorkflowTool(deps) {
  const activeRuns = new Map();
  return {
    cancelRun(runId) {
      const controller = activeRuns.get(runId);
      if (!controller) return false;
      controller.abort("cancelled by user");
      return true;
    },
    name: "workflow",
    label: t("toolDef.workflow.label"),
    description: WORKFLOW_DESCRIPTION,
    parameters: buildParameters(),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const parentSessionPath = getToolSessionPath(ctx) || deps.getSessionPath?.() || null;
      const parentSessionRef = sessionRefForPath(deps, parentSessionPath);
      const parentSessionId = parentSessionRef?.sessionId || null;
      const cwd = getToolSessionCwd(ctx) || deps.getParentCwd?.() || null;
      const agentId = deps.getAgentId?.() || undefined;
      // Trusted server context only; never accept executable budget objects from
      // serialized model arguments or script globals.
      const boundedContext = ctx?.runBudget ? {
        runBudget: ctx.runBudget,
        model: ctx.executionModel,
        workspaceFolders: ctx.workspaceFolders,
        authorizedFolders: ctx.authorizedFolders,
        toolFilter: ctx.toolFilter,
        builtinFilter: ctx.builtinFilter,
        forceLocalRuntime: true,
      } : {};


      let meta;
      let executionLimits;
      let runtimeSnapshot;
      try {
        runtimeSnapshot = structuredClone(deps.getRuntimeSnapshot?.());
        if (deps.requireRuntimeSnapshot && !runtimeSnapshot) throw new Error("Workflow runtime registry snapshot is unavailable.");
        executionLimits = createWorkflowExecutionLimits(params.args);
        ({ meta } = extractMeta(params.script));
      } catch (err) {
        return toolError(t("tool.workflow.scriptInvalid", { message: err.message }));
      }

      const store = deps.getDeferredStore?.();
      const runStore = deps.getSubagentRunStore?.();
      const threadStore = deps.getSubagentThreadStore?.();

      if ((!store || !parentSessionPath) && params.resumeFromRunId) {
        return toolError("Workflow recovery requires a persisted run and session.");
      }
      if (!store || !parentSessionPath) {
        if (ctx?.runBudget) return toolError("Budgeted templates require a persisted parent session and deferred run store.");
        return _syncRun(deps, params, meta, { agentId, cwd, parentSessionPath }, executionLimits);
      }

      const taskId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const summary = meta.name;
      const runBudgetEvidence = () => ctx?.runBudget ? { runBudget: ctx.runBudget.snapshot() } : {};
      const hub = deps.getActivityHub?.();
      const startedAt = Date.now();

      const journalDir = deps.getJournalDir?.() || null;
      let replayJournal = null;
      let journal;
      const metadata = {
        version: 1, runId: taskId, originRunId: taskId, ownerPid: process.pid,
        definitionKey: WorkflowJournal.computeKey(params.script, { args: params.args, agentId, cwd, parentSessionId, parentSessionPath, runtimeVersion: deps.requireRuntimeSnapshot ? 2 : 1, runtimeSnapshot, ...(ctx?.runBudget ? { budgetContract: { limits: ctx.runBudget.limits, model: ctx.runBudget.model } } : {}) }),
        runtimeSnapshot: runtimeSnapshot ?? null,
        ...(ctx?.runBudget ? { budgetContract: { limits: ctx.runBudget.limits, modelId: ctx.runBudget.model.id } } : {}),
        createdAt: startedAt,
        definition: { script: params.script, args: params.args ?? null, hasArgs: params.args !== undefined, agentId: agentId ?? null, parentSessionPath },
      };
      try {
        if (params.resumeFromRunId) {
          if (!journalDir) throw new Error("Workflow recovery requires persistent journals.");
          replayJournal = WorkflowJournal.load(journalPath(journalDir, params.resumeFromRunId));
          replayJournal.assertCompatible(metadata);
          replayJournal.assertRecoveryBudgetSupported(params.args);
          metadata.originRunId = replayJournal.metadata.originRunId || params.resumeFromRunId;
          replayJournal.claimRecovery(taskId);
        }
        journal = new WorkflowJournal(journalPath(journalDir, taskId));
        journal.setMetadata(metadata);
        if (replayJournal) journal.inherit(replayJournal);
      } catch (err) {
        return toolError(`Workflow recovery unavailable: ${err.message}`);
      }
      store.defer(taskId, sessionInputForPath(deps, parentSessionPath), { type: "workflow", summary });
      runStore?.register?.(taskId, { parentSessionId, parentSessionPath, summary });
      hub?.upsert({ id: taskId, kind: "workflow", status: "running", sessionId: parentSessionId, sessionPath: parentSessionPath, agentId, summary, startedAt, ...runBudgetEvidence() });
      const unsubscribeBudget = ctx?.runBudget?.subscribe?.(() => hub?.upsert({ id: taskId, ...runBudgetEvidence() }));
      const nodeSequence = { value: 0 };

      const controller = new AbortController();
      activeRuns.set(taskId, controller);
      const timeoutTimer = setTimeout(() => controller.abort(), Math.min(WORKFLOW_TIMEOUT_BACKSTOP_MS, executionLimits.maxDurationMs));
      if (timeoutTimer.unref) timeoutTimer.unref();

      const ledger = deps.getUsageLedger?.();
      const budget = makeBudget(ledger, taskId, params.args?.budgetTokens ?? null);
      const limiter = makeLimiter();
      const nodeSessionDir = workflowSessionDir(deps, taskId);
      const onAgentEvent = buildAgentEventHandler({ taskId, parentSessionId, parentSessionPath, summary, hub, threadStore, deps });

      const runWorkflow = (childScript, childArgs) => {
        const childHostApi = createHostApi({
          executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
          baseIsoOpts: {
            agentId,
            cwd,
            parentSessionId,
            parentSessionPath,
            subagentContext: true,
            subagentTaskId: taskId,
            emitEvents: true,
            ...boundedContext,
            ...(nodeSessionDir ? { persist: nodeSessionDir } : {}),
          },
          limiter,
          signal: controller.signal,
          onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress", taskId }, parentSessionPath),
          onAgentEvent,
          budget,
          args: childArgs,
          resolveAgentId: deps.resolveAgentId,
          journal,
          replayJournal,
          nodeSequence,
          requireRuntimeSnapshot: deps.requireRuntimeSnapshot === true,
          assertRuntimeSnapshot: deps.getRuntimeSnapshot ? () => assertResolvedRuntimeSnapshot(runtimeSnapshot, deps.getRuntimeSnapshot()) : undefined,
          executionLimits,
        });
        return runWorkflowScript(childScript, childHostApi, {
          signal: controller.signal,
          deadlineMs: executionLimits.maxDurationMs,
        }).then(({ result }) => assertWorkflowResult(result));
      };

      const hostApi = createHostApi({
        executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
        baseIsoOpts: {
          agentId,
          cwd,
          parentSessionId,
          parentSessionPath,
          subagentContext: true,
          subagentTaskId: taskId,
          emitEvents: true,
          ...boundedContext,
          ...(nodeSessionDir ? { persist: nodeSessionDir } : {}),
        },
        limiter,
        signal: controller.signal,
        onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress", taskId }, parentSessionPath),
        onAgentEvent,
        budget,
        args: params.args,
        resolveAgentId: deps.resolveAgentId,
        journal,
        replayJournal,
        nodeSequence,
        requireRuntimeSnapshot: deps.requireRuntimeSnapshot === true,
        assertRuntimeSnapshot: deps.getRuntimeSnapshot ? () => assertResolvedRuntimeSnapshot(runtimeSnapshot, deps.getRuntimeSnapshot()) : undefined,
        executionLimits,
        runWorkflow,
      });

      runWorkflowScript(params.script, hostApi, { signal: controller.signal, deadlineMs: executionLimits.maxDurationMs })
        .then(({ result }) => {
          const text = workflowResultToText(result);
          journal.finish();
          const finishedAt = Date.now();
          const replayHits = (replayJournal?.replayHits ?? 0) + (journal?.replayHits ?? 0);
          store.resolve(taskId, text);
          runStore?.resolve?.(taskId, text);
          hub?.upsert({ id: taskId, status: "done", finishedAt, ...runBudgetEvidence() });
          deps.emitEvent?.({
            type: "block_update",
            taskId,
            patch: {
              streamStatus: "done",
              finishedAt,
              ...(replayHits > 0 ? { journalReplayHits: replayHits } : {}),
            },
          }, parentSessionPath);
        })
        .catch((err) => {
          const cancelled = controller.signal.reason === "cancelled by user";
          controller.abort();
          let reason = err?.message || String(err);
          try { journal.finish(); } catch (persistError) { reason += `; journal persistence failed: ${persistError.message}`; }
          const finishedAt = Date.now();
          store.fail(taskId, reason);
          if (cancelled) runStore?.abort?.(taskId, reason);
          else runStore?.fail?.(taskId, reason);
          const terminalStatus = cancelled ? "aborted" : "failed";
          hub?.upsert({ id: taskId, status: terminalStatus, finishedAt, ...runBudgetEvidence() });
          deps.emitEvent?.({ type: "block_update", taskId, patch: { streamStatus: terminalStatus, finishedAt } }, parentSessionPath);
        })
        .finally(() => { clearTimeout(timeoutTimer); activeRuns.delete(taskId); unsubscribeBudget?.(); });

      return toolOk(
        t("tool.workflow.dispatched", { summary, taskId }),
        { taskId, runId: taskId, workflow: summary, streamStatus: "running", startedAt },
      );
    },
  };
}

function buildAgentEventHandler({ taskId, parentSessionId, parentSessionPath, summary, hub, threadStore, deps }) {
  return (evt) => {
    const childId = `${taskId}::${evt.nodeId}`;
    if (evt.phase === "start") {
      const isStep = typeof evt.stepKind === "string" && evt.stepKind;
      const kind = isStep ? "workflow_step" : "workflow_agent";
      if (!isStep && evt.threadId) {
        threadStore?.beginRun?.(evt.threadId, {
          kind: evt.threadKind || "workflow_node",
          parentTaskId: taskId,
          nodeId: evt.nodeId,
          parentSessionId,
          parentSessionPath,
          agentId: evt.agentId || null,
          label: evt.label || null,
          summary: evt.label || evt.phaseLabel || summary,
        });
      }
      hub?.upsert({
        id: childId,
        kind,
        status: "running",
        sessionId: parentSessionId,
        sessionPath: parentSessionPath,
        parentTaskId: taskId,
        threadId: isStep ? null : (evt.threadId || null),
        threadKind: isStep ? null : (evt.threadKind || null),
        agentId: isStep ? null : (evt.agentId || null),
        label: evt.label || null,
        phaseLabel: evt.phaseLabel || null,
        stepKind: evt.stepKind || null,
        startedAt: Date.now(),
      });
    } else if (evt.phase === "session") {
      if (evt.threadId) {
        threadStore?.attachSession?.(evt.threadId, evt.childSessionPath || null, {
          parentTaskId: taskId,
          nodeId: evt.nodeId,
          parentSessionId,
          parentSessionPath,
          childSessionId: evt.childSessionId || null,
        });
      }
      hub?.upsert({
        id: childId,
        childSessionId: evt.childSessionId || null,
        childSessionPath: evt.childSessionPath || null,
      });
    } else if (evt.phase === "done") {
      const isStep = typeof evt.stepKind === "string" && evt.stepKind;
      if (!isStep) {
        const node = hub?.get?.(childId);
        const tokens = sumNodeTokens(deps.getUsageLedger?.(), {
          childSessionId: node?.childSessionId || null,
          childSessionPath: node?.childSessionPath || null,
        });
        if (evt.threadId) {
          threadStore?.finishRun?.(evt.threadId, { status: "resolved", close: true });
        }
        hub?.upsert({ id: childId, status: "done", finishedAt: Date.now(), ...(tokens != null ? { tokens } : {}) });
      } else {
        hub?.upsert({ id: childId, status: "done", finishedAt: Date.now(), stepKind: evt.stepKind || null });
      }
    } else if (evt.phase === "fail") {
      const isStep = typeof evt.stepKind === "string" && evt.stepKind;
      if (!isStep && evt.threadId) {
        threadStore?.finishRun?.(evt.threadId, { status: "failed", close: true });
      }
      hub?.upsert({ id: childId, status: "failed", error: evt.error || null, finishedAt: Date.now(), ...(isStep ? { stepKind: evt.stepKind || null } : {}) });
    }
  };
}

async function _syncRun(deps, params, meta, { agentId, cwd, parentSessionPath }, executionLimits) {
  const limiter = makeLimiter();
  const ledger = deps.getUsageLedger?.();
  const budget = makeBudget(ledger, null, params.args?.budgetTokens ?? null);
  const parentSessionId = sessionIdForPath(deps, parentSessionPath);
  const hostApi = createHostApi({
    executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
    baseIsoOpts: { agentId, cwd, parentSessionId, parentSessionPath, subagentContext: true, emitEvents: true },
    limiter,
    signal: undefined,
    onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress" }, parentSessionPath),
    budget,
    args: params.args,
    resolveAgentId: deps.resolveAgentId,
    requireRuntimeSnapshot: deps.requireRuntimeSnapshot === true,
    executionLimits,
  });
  try {
    const { result } = await runWorkflowScript(params.script, hostApi, { deadlineMs: executionLimits.maxDurationMs });
    const text = workflowResultToText(result);
    return toolOk(
      t("tool.workflow.syncComplete", { name: meta.name, count: limiter.totalSpawned, result: text }),
      { workflow: meta.name, agentsSpawned: limiter.totalSpawned, result },
    );
  } catch (err) {
    return toolError(t("tool.workflow.executionFailed", { message: err.message }), { agentsSpawned: limiter.totalSpawned });
  }
}
