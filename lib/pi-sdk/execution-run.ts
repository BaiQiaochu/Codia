import { AsyncLocalStorage } from 'node:async_hooks';
import { isRetrySafeRead } from '../tools/tool-action-ledger.ts';
import { bindExecutionRun, RunController, executionContext } from '../execution/run-controller.ts';
import { getPiCodingAgentVersion } from './session-options.ts';

const modelAdmission = new AsyncLocalStorage<RunController>();
type ToolEvent = { toolCallId: string; toolName: string; isError?: boolean; parentToolCallId?: string };

function trackModelWork(control: RunController, operation: () => any): any {
  const finish = control.modelWork();
  const track = (value: any) => {
    if (!value?.[Symbol.asyncIterator]) { finish(); return value; }
    return new Proxy(value, {
      get(target, key) {
        if (key === Symbol.asyncIterator) return async function* () {
          try { yield* target; } finally { finish(); }
        };
        if (key === 'result') return async () => { try { return await target.result(); } finally { finish(); } };
        const field = Reflect.get(target, key);
        return typeof field === 'function' ? field.bind(target) : field;
      },
    });
  };
  try {
    const value = operation();
    return value?.then ? value.then(track, (error: unknown) => { finish(); throw error; }) : track(value);
  } catch (error) { finish(); throw error; }
}

/** Extension hooks also cover dynamic tools and Codemode's nested executeTool. */
export function createExecutionRunExtension(control: RunController, sessionPath: () => string | null) {
  let release: ((failed?: boolean) => void) | undefined;
  const key = (event: ToolEvent) => `${sessionPath() || 'memory'}:${event.toolCallId}`;
  const handlers = new Map<string, Array<(event: any) => unknown>>([
    ['agent_start', [() => {
      control.activateContinuation();
      release ??= control.enter();
    }]],
    ['agent_settled', [() => { release?.(); release = undefined; }]],
    ['message_end', [(event) => {
      if (event.message?.role === 'assistant') {
        control.markFailed(event.message.stopReason === 'error');
        if (event.message.stopReason === 'aborted' && control.canContinueAutomatically()) control.cancel();
      }
    }]],
    ['tool_call', [(event: ToolEvent) => {
      try {
        control.admitTool(key(event), event.toolName, !isRetrySafeRead({ name: event.toolName }));
      } catch {
        return { block: true, reason: 'Task paused: this tool was not executed. Continue the task explicitly.' };
      }
    }]],
    ['tool_result', [(event: ToolEvent) => {
      control.finishTool(key(event), event.isError === true && control.signal.aborted);
    }]],
    ['before_provider_request', [() => {
      control.assertActive();
    }]],
  ]);
  return { path: 'codia-execution-run', handlers, tools: new Map(), flags: new Map(),
    shortcuts: new Map(), commands: new Map(), messageRenderers: new Map() };
}

export function executionRunSessionOptions(options: any, control: RunController) {
  if (getPiCodingAgentVersion() !== '1.1.0') throw new Error('Execution adapter requires PI SDK 1.1.0; validate its transport contract before upgrading.');
  if (options.cwd) control.attachWorkspace(options.cwd);
  const base = options.resourceLoader;
  if (!base?.getExtensions) throw new Error('Execution control requires the production resource loader');
  const extension = createExecutionRunExtension(control, () => options.sessionManager?.getSessionFile?.() || null);
  const resourceLoader = Object.create(base, {
    getExtensions: { value: () => {
      const extensions = base.getExtensions();
      return { ...extensions, extensions: [extension, ...(extensions.extensions || [])] };
    } },
  });
  const wrap = (tool: any) => ({
    ...tool,
    execute: (id: string, args: unknown, signal: AbortSignal | undefined, ...rest: unknown[]) => {
      control.assertActive();
      const cancellable = !['write', 'edit'].includes(tool.name);
      const combined = cancellable ? (signal ? AbortSignal.any([signal, control.signal]) : control.signal) : signal;
      return control.run(() => tool.execute(id, args, combined, ...rest));
    },
  });
  // Compaction and retry summaries bypass agent.streamFunction. Wrap the per-session
  // runtime, never the shared provider registry. Provider errors propagate here.
  const runtime = options.modelRuntime;
  const modelRuntime = runtime && new Proxy(runtime, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (!['stream', 'streamSimple', 'complete', 'completeSimple'].includes(String(key))) return value.bind(target);
      return (model: unknown, context: unknown, opts: any = {}) => {
        const admitted = modelAdmission.getStore() === control;
        if (!admitted) control.admitModel();
        else control.assertActive();
        const signal = opts.signal ? AbortSignal.any([opts.signal, control.signal]) : control.signal;
        const invoke = () => modelAdmission.run(control, () => value.call(target, model, context, { ...opts, signal }));
        return admitted ? invoke() : trackModelWork(control, invoke);
      };
    },
  });
  return { ...options, ...(modelRuntime ? { modelRuntime } : {}), resourceLoader,
    tools: options.tools?.map(wrap), customTools: options.customTools?.map(wrap) };
}

/** Only SDK-specific transport access lives here; provider payload/cache settings are preserved. */
export function installExecutionRun(session: any, control: RunController) {
  session.codiaRunControl = control;
  bindExecutionRun(session.sessionManager?.getSessionFile?.(), control);
  const removeStop = control.onStop(() => { void Promise.resolve(session.abort()).catch(() => {}); });
  const dispose = session.dispose.bind(session);
  session.dispose = (...args: unknown[]) => { removeStop(); return dispose(...args); };
  const agent = session.agent;
  const slot = typeof agent?.streamFunction === 'function' ? 'streamFunction' : 'streamFn';
  if (typeof agent?.[slot] !== 'function') throw new Error('SDK execution transport unavailable');
  const original = agent[slot].bind(agent);
  agent[slot] = (model: unknown, context: unknown, options: any = {}) => {
    control.admitModel();
    const signal = options.signal ? AbortSignal.any([options.signal, control.signal]) : control.signal;
    return trackModelWork(control, () =>
      modelAdmission.run(control, () => control.run(() => original(model, context, { ...options, signal }))));
  };
  if (typeof session.compact === 'function') {
    const compact = session.compact.bind(session);
    session.compact = async (...args: unknown[]) => {
      control.activateContinuation();
      const release = control.enter();
      try { return await control.run(() => compact(...args)); }
      catch (error) { release(true); throw error; }
      finally { release(); }
    };
  }
  const prompt = session.prompt.bind(session);
  session.prompt = async (...args: unknown[]) => {
    if (executionContext.getStore() === control) control.activateContinuation();
    else control.begin();
    const manager = session.sessionManager;
    const runId = control.snapshot()!.runId;
    const marker = manager?.getBranch?.().findLast((entry: any) => entry.customType === 'codia-execution-run');
    if (marker?.data?.runId !== runId) manager?.appendCustomEntry?.('codia-execution-run', { schemaVersion: 1, runId });
    const release = control.enter();
    try { return await control.run(() => prompt(...args)); }
    catch (error) { release(true); throw error; }
    finally { release(); }
  };
}
