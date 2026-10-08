// @ts-nocheck
import { createStructuredOutputTool } from "./structured-output.ts";
import { WorkflowJournal } from "./journal.ts";
import { resolveSubagentToolAccess } from "../tools/subagent-tool-policy.ts";

export const WORKFLOW_RUNTIME_CONTRACT = Symbol.for("gsap.workflow.runtimeContract");

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
  const { executeIsolated, baseIsoOpts, limiter, signal, budget, args, resolveAgentId } = deps;
  const onAgentEvent = typeof deps.onAgentEvent === "function" ? deps.onAgentEvent : () => {};
  const onProgress = typeof deps.onProgress === "function" ? deps.onProgress : () => {};
  const journal = deps.journal || null;
  const replayJournal = deps.replayJournal || null;
  const runtimeContract = createWorkflowRuntimeContract();
  let nodeSeq = 0;
  let currentPhase = null;

  function agent(prompt, rawOpts = {}) {
    const normalizedPrompt = normalizeAgentPrompt(prompt);
    const opts = normalizeAgentOptions(rawOpts);
    const seq = ++nodeSeq;
    const nodeId = `node-${seq}`;
    const parentTaskId = typeof baseIsoOpts.subagentTaskId === "string" && baseIsoOpts.subagentTaskId
      ? baseIsoOpts.subagentTaskId
      : null;
    const threadId = parentTaskId ? `${parentTaskId}::${nodeId}` : null;
    const threadKind = threadId ? "workflow_node" : null;
    const label = typeof opts.label === "string" && opts.label ? opts.label : null;

    const startAgentNode = async () => {
      if (replayJournal) {
        const replayKey = WorkflowJournal.computeKey(normalizedPrompt, opts);
        const cached = replayJournal.tryReplay(seq, replayKey);
        if (cached) {
          onAgentEvent({ phase: "start", nodeId, threadId, threadKind, label, agentId: baseIsoOpts.agentId ?? null, phaseLabel: currentPhase });
          onAgentEvent({ phase: "done", nodeId, threadId, threadKind });
          journal?.record(seq, replayKey, cached.result, "ok");
          return cached.result;
        }
      }

      return limiter.run(async () => {
        if (signal?.aborted) throw new Error("workflow aborted");
        if (budget?.total != null && budget.remaining() <= 0) {
          throw new Error(`workflow token budget exhausted (spent ${budget.spent()})`);
        }

        const isoOpts = { ...baseIsoOpts, signal };
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

        try {
          const res = await executeIsolated(finalPrompt, isoOpts);
          if (res?.error) throw new Error(`agent failed: ${res.error}`);
          let result;
          if (structured) {
            const out = structured.getResult();
            if (out === undefined) throw new Error("agent did not call structured_output");
            result = out;
          } else {
            result = res?.replyText ?? "";
          }
          onAgentEvent({ phase: "done", nodeId, threadId, threadKind });
          if (journalKey) journal.record(seq, journalKey, result, "ok");
          return result;
        } catch (err) {
          onAgentEvent({ phase: "fail", nodeId, threadId, threadKind });
          if (journalKey) journal.record(seq, journalKey, null, "error");
          throw err;
        }
      });
    };

    return runtimeContract.trackAgentCall(
      { nodeId, promptPreview: normalizedPrompt.slice(0, 80) },
      startAgentNode,
    );
  }

  async function parallel(thunks) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "parallel", phaseLabel: currentPhase });
    try {
      const result = await Promise.all((thunks || []).map((thunk) =>
        Promise.resolve().then(thunk).catch(() => null)
      ));
      onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "parallel" });
      return result;
    } catch (err) {
      onAgentEvent({ phase: "fail", nodeId: stepNodeId, stepKind: "parallel" });
      throw err;
    }
  }

  async function pipeline(items, ...stages) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "pipeline", phaseLabel: currentPhase });
    try {
      const result = await Promise.all((items || []).map(async (item, index) => {
        let cur = item;
        for (const stage of stages) {
          try {
            cur = await stage(cur, item, index);
          } catch {
            return null;
          }
        }
        return cur;
      }));
      onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "pipeline" });
      return result;
    } catch (err) {
      onAgentEvent({ phase: "fail", nodeId: stepNodeId, stepKind: "pipeline" });
      throw err;
    }
  }

  function log(message) {
    const seq = ++nodeSeq;
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
