// @ts-nocheck
import { assertResolvedRuntimeSnapshot } from "./runtime-snapshot.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createStructuredOutputTool } from "./structured-output.ts";
import { createWorkflowExecutionLimits, assertWorkflowWithinDuration, consumeWorkflowStep } from "./limits.ts";
import { WorkflowJournal } from "./journal.ts";
import { resolveSubagentToolAccess } from "../tools/subagent-tool-policy.ts";

export const WORKFLOW_RUNTIME_CONTRACT = Symbol.for("codia.workflow.runtimeContract");

const AGENT_OPTION_KEYS = new Set(["label", "model", "agentType", "toolFilter", "access", "schema"]);

function normalizeAgentOptions(rawOpts) {
  if (rawOpts == null) return {};
  if (typeof rawOpts !== "object" || Array.isArray(rawOpts)) {
    throw new Error("workflow agent(prompt, opts) options must be an object.");
  }
  for (const key of Object.keys(rawOpts)) {
    if (!AGENT_OPTION_KEYS.has(key)) {
      throw new Error(
        `workflow agent() unsupported option "${key}". ` +
        "Use agent(prompt, { label?, model?, agentType?, access?, schema?, toolFilter? }); " +
        "put the task instructions in the first prompt argument.",
      );
    }
  }
  if (rawOpts.access != null && rawOpts.access !== "read" && rawOpts.access !== "write") {
    throw new Error('workflow agent() access must be "read" or "write".');
  }
  return rawOpts;
}

function normalizeAgentPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("workflow agent(prompt, opts) requires a non-empty prompt string as the first argument.");
  }
  return prompt;
}

function createWorkflowRuntimeContract() {
  const calls = [];

  function trackAgentCall(meta, start) {
    const record = { ...meta, consumed: false };
    calls.push(record);
    let promise = null;

    const consume = () => {
      record.consumed = true;
      if (!promise) {
        promise = Promise.resolve().then(start);
      }
      return promise;
    };

    return new Proxy(Object.create(null), {
      get(_target, prop) {
        if (prop === "then") return (onFulfilled, onRejected) => consume().then(onFulfilled, onRejected);
        if (prop === "catch") return (onRejected) => consume().catch(onRejected);
        if (prop === "finally") return (onFinally) => consume().finally(onFinally);
        if (prop === Symbol.toStringTag) return "Promise";
        if (prop === "result") {
          throw new Error(
            "workflow agent() returns a Promise. Use \"const result = await agent(...)\" before reading the result; " +
            "do not use agent(...).result.",
          );
        }
        throw new Error(
          `workflow agent() returns a Promise. Await agent("${record.promptPreview}") before reading property "${String(prop)}".`,
        );
      },
    });
  }

  function assertNoUnawaitedAgentCalls() {
    const unawaited = calls.filter((call) => !call.consumed);
    if (!unawaited.length) return;
    const first = unawaited[0];
    throw new Error(
      `workflow agent() call ${first.nodeId} was not awaited. ` +
      'Use `const result = await agent("task prompt", { access, agentType })`; ' +
      "agent() does not return { result }.",
    );
  }

  return { trackAgentCall, assertNoUnawaitedAgentCalls };
}

export function createHostApi(deps) {
  const { executeIsolated, baseIsoOpts, limiter, budget, args, resolveAgentId } = deps;
  const failureController = new AbortController();
  const branchContext = new AsyncLocalStorage();
  const executionLimits = deps.executionLimits || createWorkflowExecutionLimits(args);
  const signal = deps.signal ? AbortSignal.any([deps.signal, failureController.signal]) : failureController.signal;
  const onAgentEvent = typeof deps.onAgentEvent === "function" ? deps.onAgentEvent : () => {};
  const onProgress = typeof deps.onProgress === "function" ? deps.onProgress : () => {};
  const journal = deps.journal || null;
  const replayJournal = deps.replayJournal || null;
  const runtimeContract = createWorkflowRuntimeContract();
  let branchFailure = null;
  runtimeContract.cancel = (reason) => failureController.abort(reason);
  runtimeContract.assertSuccessful = () => {
    if (branchFailure) throw branchFailure;
    if (signal.aborted) throw new Error("workflow aborted");
    assertWorkflowWithinDuration(executionLimits);
  };
  const nodeSequence = deps.nodeSequence || { value: 0 };
  let currentPhase = null;

  function agent(prompt, rawOpts = {}) {
    const branchPolicy = branchContext.getStore();
    const normalizedPrompt = normalizeAgentPrompt(prompt);
    const opts = structuredClone(normalizeAgentOptions(rawOpts));
    const seq = ++nodeSequence.value;
    const nodeId = `node-${seq}`;
    const parentTaskId = typeof baseIsoOpts.subagentTaskId === "string" && baseIsoOpts.subagentTaskId
      ? baseIsoOpts.subagentTaskId
      : null;
    const threadId = parentTaskId ? `${parentTaskId}::${nodeId}` : null;
    const threadKind = threadId ? "workflow_node" : null;
    const label = typeof opts.label === "string" && opts.label ? opts.label : null;

    const startAgentNode = async () => {
      const effectivePolicy = branchPolicy || branchContext.getStore();
      checkActive();
      deps.assertRuntimeSnapshot?.();
      if (replayJournal && !deps.requireRuntimeSnapshot) {
        const replayKey = WorkflowJournal.computeKey(normalizedPrompt, opts);
        const cached = replayJournal.tryReplay(seq, replayKey);
        if (cached) {
          onAgentEvent({ phase: "start", nodeId, threadId, threadKind, label, agentId: baseIsoOpts.agentId ?? null, phaseLabel: currentPhase });
          onAgentEvent({ phase: "done", nodeId, threadId, threadKind });
          journal?.record(seq, replayKey, cached.result, "ok", { access: opts.access, actionId: replayJournal.actionId(seq, replayKey) });
          return cached.result;
        }
      }

      return limiter.run(async () => {
        try {
        checkActive();
        if (budget?.total != null && budget.remaining() <= 0) {
          throw new Error(`workflow token budget exhausted (spent ${budget.spent()})`);
        }

        const isoOpts = { ...baseIsoOpts, signal, workflowRunId: journal?.metadata?.runId || baseIsoOpts.workflowRunId || baseIsoOpts.runId || null };
        if (threadId) {
          isoOpts.subagentThreadId = threadId;
          isoOpts.subagentThreadKind = threadKind;
        }
        if (opts.access === "read" || opts.access === "write") {
          const toolAccess = resolveSubagentToolAccess({
            access: opts.access,
            parentPermissionMode: baseIsoOpts.permissionMode || null,
          });
          isoOpts.permissionMode = toolAccess.permissionMode;
          if (toolAccess.customToolFilter) isoOpts.toolFilter = toolAccess.customToolFilter;
          if (toolAccess.builtinToolFilter) isoOpts.builtinFilter = toolAccess.builtinToolFilter;
        }
        if (opts.model) isoOpts.model = opts.model;

        let nodeAgentId = isoOpts.agentId ?? null;
        if (opts.agentType) {
          if (typeof resolveAgentId !== "function") {
            throw new Error(`workflow agentType "${opts.agentType}" cannot be resolved in this environment.`);
          }
          const id = resolveAgentId(opts.agentType);
          if (!id) throw new Error(`workflow agentType "${opts.agentType}" was not found.`);
          isoOpts.agentId = id;
          nodeAgentId = id;
        }
        if (opts.toolFilter) isoOpts.toolFilter = opts.toolFilter;
        if (baseIsoOpts.runBudget) {
          // Template authorization/model selection cannot be expanded by a
          // generated node, including nested workflow scripts.
          isoOpts.model = baseIsoOpts.model;
          isoOpts.agentId = baseIsoOpts.agentId;
          nodeAgentId = isoOpts.agentId ?? null;
          const intersect = (requested, authorized) => {
            if (!Array.isArray(authorized)) throw new Error("Bounded workflow requires explicit tool allowlists.");
            if (requested == null || requested === "*") return [...authorized];
            return authorized.filter(name => requested.includes(name));
          };
          isoOpts.toolFilter = intersect(isoOpts.toolFilter, baseIsoOpts.toolFilter);
          isoOpts.builtinFilter = intersect(isoOpts.builtinFilter, baseIsoOpts.builtinFilter);
        }


        onAgentEvent({ phase: "start", nodeId, threadId, threadKind, label, agentId: nodeAgentId, phaseLabel: currentPhase });
        isoOpts.onSessionReady = (sp, meta = {}) => onAgentEvent({
          phase: "session",
          nodeId,
          threadId,
          threadKind,
          childSessionId: typeof meta?.sessionId === "string" && meta.sessionId.trim() ? meta.sessionId.trim() : null,
          childSessionPath: sp,
        });

        let structured = null;
        let finalPrompt = normalizedPrompt;
        if (opts.schema) {
          structured = createStructuredOutputTool(opts.schema);
          isoOpts.extraCustomTools = [...(isoOpts.extraCustomTools || []), structured.tool];
          finalPrompt = `${normalizedPrompt}\n\nAfter completing the task, call the structured_output tool exactly once with a value that matches the requested schema.`;
        }

        const journalKey = journal ? WorkflowJournal.computeKey(normalizedPrompt, opts) : null;

        let runtimeSnapshot = null;
        let dispatched = false;
        let replayed = null;
        const beforeDispatch = () => {
          checkActive();
          consumeWorkflowStep(executionLimits);
          deps.onBudgetChange?.();
          if (journalKey) journal.record(seq, journalKey, null, "running", { access: opts.access, threadId, runtimeSnapshot });
          dispatched = true;
        };
        if (deps.requireRuntimeSnapshot) {
          isoOpts.workflowRuntimeGuard = (snapshot) => {
            if (runtimeSnapshot) throw new Error("Workflow runtime guard called more than once.");
            deps.assertRuntimeSnapshot?.();
            const previous = replayJournal?.getEntry(seq);
            if (previous) assertResolvedRuntimeSnapshot(previous.runtimeSnapshot, snapshot);
            runtimeSnapshot = structuredClone(snapshot);
            if (replayJournal) replayed = replayJournal.tryReplay(seq, journalKey);
            if (replayed) return { replay: true, result: replayed.result };
            beforeDispatch();
            return null;
          };
        } else beforeDispatch();
        try {
          const res = await executeIsolated(finalPrompt, isoOpts);
          if (deps.requireRuntimeSnapshot && !runtimeSnapshot) {
            throw new Error(res?.error || "Workflow executor did not enforce resolved runtime versions.");
          }
          if (signal.aborted) throw new Error("workflow aborted");
          if (res?.error) throw new Error(`agent failed: ${res.error}`);
          let result;
          if (replayed) {
            result = replayed.result;
          } else if (structured) {
            const out = structured.getResult();
            if (out === undefined) throw new Error("agent did not call structured_output");
            result = out;
          } else {
            result = res?.replyText ?? "";
          }
          if (journalKey) journal.record(seq, journalKey, result, "ok", { access: opts.access, threadId, runtimeSnapshot });
          deps.onBudgetChange?.();
          onAgentEvent({ phase: "done", nodeId, threadId, threadKind });
          return result;
        } catch (err) {
          onAgentEvent({ phase: "fail", nodeId, threadId, threadKind, error: err?.message || String(err) });
          if (journalKey && dispatched) journal.record(seq, journalKey, null, opts.access === "read" ? "error" : "unknown", { access: opts.access, threadId, runtimeSnapshot });
          deps.onBudgetChange?.();
          throw err;
        }
        } catch (err) {
          // Abort before the limiter releases its slot to a queued branch.
          if (effectivePolicy === "fail-fast") failureController.abort(err);
          throw err;
        }
      });
    };

    return runtimeContract.trackAgentCall(
      { nodeId, promptPreview: normalizedPrompt.slice(0, 80) },
      startAgentNode,
    );
  }

  function checkActive() {
    if (signal.aborted) throw new Error("workflow aborted");
    assertWorkflowWithinDuration(executionLimits);
  }

  function failurePolicy(options = {}) {
    const policy = options.failurePolicy ?? "fail-fast";
    if (!["fail-fast", "collect-errors"].includes(policy)) {
      throw new Error('failurePolicy must be "fail-fast" or "collect-errors"');
    }
    return policy;
  }

  async function runBranches(branches, policy) {
    const pending = branches.map((branch) => Promise.resolve().then(() => {
      checkActive();
      return branchContext.run(policy, async () => await branch());
    }).catch((err) => {
      if (policy === "fail-fast") failureController.abort(err);
      throw err;
    }));
    if (policy === "fail-fast") return Promise.all(pending);
    const results = await Promise.allSettled(pending);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length) {
      const error = new AggregateError(failures.map((r) => r.reason), `${failures.length} workflow branches failed`);
      // Preserve index-aligned successes and failures for diagnosis/recovery.
      error.results = results;
      throw error;
    }
    return results.map((r) => r.value);
  }

  async function parallel(thunks, options = {}) {
    const policy = failurePolicy(options);
    const stepNodeId = `step-${++nodeSequence.value}`;
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "parallel", phaseLabel: currentPhase });
    try {
      const result = await runBranches(thunks || [], policy);
      checkActive();
      onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "parallel" });
      return result;
    } catch (err) {
      branchFailure = err;
      onAgentEvent({ phase: "fail", nodeId: stepNodeId, stepKind: "parallel", error: err?.message || String(err) });
      throw err;
    }
  }

  // An optional final options object preserves the existing variadic stages API.
  async function pipeline(items, ...stages) {
    const options = stages.length && typeof stages.at(-1) === "object" ? stages.pop() : {};
    const policy = failurePolicy(options);
    const stepNodeId = `step-${++nodeSequence.value}`;
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "pipeline", phaseLabel: currentPhase });
    try {
      const result = await runBranches((items || []).map((item, index) => async () => {
        let cur = item;
        for (const stage of stages) {
          checkActive();
          cur = await stage(cur, item, index);
        }
        return cur;
      }), policy);
      checkActive();
      onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "pipeline" });
      return result;
    } catch (err) {
      branchFailure = err;
      onAgentEvent({ phase: "fail", nodeId: stepNodeId, stepKind: "pipeline", error: err?.message || String(err) });
      throw err;
    }
  }

  function log(message) {
    const seq = ++nodeSequence.value;
    const stepNodeId = `step-${seq}`;
    const text = String(message);
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "log", label: text, phaseLabel: currentPhase });
    onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "log" });
    onProgress({ type: "log", message: text });
  }

  function phase(title) {
    currentPhase = String(title);
    onProgress({ type: "phase", title: currentPhase });
  }

  async function workflow(script, childArgs) {
    checkActive();
    if (typeof deps.runWorkflow !== "function") {
      throw new Error("nested workflow is unavailable in this environment");
    }
    return deps.runWorkflow(script, childArgs);
  }

  const api = { agent, parallel, pipeline, workflow, log, phase, budget, args };
  Object.defineProperty(api, WORKFLOW_RUNTIME_CONTRACT, {
    value: runtimeContract,
    enumerable: false,
  });
  return api;
}
