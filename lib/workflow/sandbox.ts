import vm from "node:vm";
import { extractMeta } from "./meta.ts";
import { WORKFLOW_RUNTIME_CONTRACT } from "./host-api.ts";

const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;

type WorkflowHostApi = Record<string, any>;

type WorkflowRunOptions = {
  signal?: AbortSignal;
  deadlineMs?: number;
};

export async function runWorkflowScript(
  script: string,
  hostApi: WorkflowHostApi,
  opts: WorkflowRunOptions = {},
) {
  const { meta, body } = extractMeta(script);
  const { signal, deadlineMs = DEFAULT_DEADLINE_MS } = opts;
  if (signal?.aborted) throw new Error(`workflow "${meta.name}" was aborted (中止)`);

  const sandbox = Object.create(null);
  for (const key of Object.keys(hostApi || {})) sandbox[key] = hostApi[key];
  sandbox.__wf_api = hostApi || {};
  const context = vm.createContext(sandbox);

  const wrapped =
    "(async () => {\n" +
    "'use strict';\n" +
    "const __nd = () => { throw new Error('workflow scripts cannot use non-deterministic APIs: Math.random/Date.now (非确定性)'); };\n" +
    "Math.random = __nd; Date.now = __nd;\n" +
    body +
    "\n})()";

  let scriptPromise: Promise<unknown>;
  try {
    scriptPromise = vm.runInContext(wrapped, context, {
      filename: `workflow:${meta.name}`,
      timeout: deadlineMs,
    });
  } catch (err) {
    if (isVmTimeoutError(err)) throw workflowTimeoutError(meta.name, deadlineMs);
    throw new Error(`workflow "${meta.name}" script error: ${err?.message || String(err)}`);
  }

  const contract = (hostApi as any)?.[WORKFLOW_RUNTIME_CONTRACT as any];
  try {
    const result = await raceDeadline(scriptPromise, { signal, deadlineMs, name: meta.name });
    contract?.assertNoUnawaitedAgentCalls?.();
    contract?.assertSuccessful?.();
    return { meta, result };
  } catch (error) {
    contract?.cancel?.(error);
    throw error;
  }
}

function raceDeadline(
  promise: Promise<unknown>,
  { signal, deadlineMs, name }: { signal?: AbortSignal; deadlineMs: number; name: string },
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: (value: unknown) => void, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, workflowTimeoutError(name, deadlineMs)),
      deadlineMs,
    );
    const onAbort = () => finish(reject, new Error(`workflow "${name}" was aborted (中止)`));
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then((value) => finish(resolve, value), (err) => finish(reject, err));
  });
}

function workflowTimeoutError(name: string, deadlineMs: number): Error {
  return new Error(`workflow "${name}" timed out after ${deadlineMs}ms (超时)`);
}

function isVmTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Script execution timed out/i.test(message);
}
