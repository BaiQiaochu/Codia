import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  createCodemodeExtension, createToolSearchExtension, emitSessionShutdown,
} from '../lib/pi-sdk/index.ts';
import { createSandboxedTools } from '../lib/sandbox/index.ts';
import { wrapWithCheckpoint } from '../lib/checkpoint-wrapper.ts';
import { CheckpointStore } from '../lib/checkpoint-store.ts';
import { wrapWithSessionPermission } from '../lib/tools/session-permission-wrapper.ts';
import { RunController } from '../lib/execution/run-controller.ts';
import { ToolActionLedger } from '../lib/tools/tool-action-ledger.ts';
import { DeferredResultStore } from '../lib/deferred-result-store.ts';
import { createDeferredResultExtension } from '../lib/extensions/deferred-result-ext.ts';
import type { ExecutionRunLimits } from '../shared/execution-run.ts';

export type ScriptedTurn = string | Array<{ name: string; arguments: object; id?: string }>;
export type LiveRuntimeConfig = {
  baseUrl: string; api: string; apiKeyEnv: string; model: string;
  reasoning?: boolean; contextWindow?: number; maxTokens?: number;
};
/** Isolated provider + production SDK/tool assembly. No user config or credentials. */
export async function createRuntimeFixture(turns: ScriptedTurn[], limits?: ExecutionRunLimits,
  extraTools: (workspace: string, context: { sessionPath: string; baseUrl: string }) => any[] = () => [],
  live?: LiveRuntimeConfig, parentControl?: RunController) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-runtime-eval-'));
  const workspace = path.join(root, '工作区 with spaces');
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(workspace); fs.mkdirSync(agentDir);
  let permissionMode = 'operate';
  let sandboxEnabled = false;
  const requests: unknown[] = [];
  const events: any[] = [];
  const deferred = new DeferredResultStore({ emit: event => events.push(event) }, path.join(root, 'deferred.json'));
  const server = http.createServer(async (req, res) => {
    if (req.url === '/page') { res.end('<!doctype html><title>Local fixture</title><main id="result">ready</main>'); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const turn = turns.shift() ?? 'Finished.';
    const tools = Array.isArray(turn);
    const content = tools ? null : turn;
    const calls = tools ? turn.map((tool, index) => ({
      index, id: tool.id || `call_${requests.length}_${index}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
    })) : undefined;
    const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
    if (!JSON.parse(body).stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: calls }, finish_reason: tools ? 'tool_calls' : 'stop' }], usage }));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    const send = (choices: unknown[], extra = {}) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices, ...extra })}\n\n`);
    send([{ index: 0, delta: { role: 'assistant', ...(tools ? { tool_calls: calls } : { content }) }, finish_reason: null }]);
    send([{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }]);
    send([], { usage }); res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const modelsPath = path.join(root, 'models.json');
  try {
  const liveKey = live ? process.env[live.apiKeyEnv] : null;
  if (live && (!liveKey || !/^https?:\/\//.test(live.baseUrl) || !live.model || !live.api)) {
    throw new Error('Explicit live config requires a model, API, base URL and named key environment variable.');
  }
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: { 'codia-runtime-eval': {
    baseUrl: live?.baseUrl || `${baseUrl}/v1`, api: live?.api || 'openai-completions', apiKey: liveKey || 'local-fixture-only',
    models: [{ id: live?.model || 'fixture', name: live ? 'Explicit live model' : 'Deterministic local fixture',
      reasoning: live?.reasoning === true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: live?.contextWindow || 32000, maxTokens: live?.maxTokens || 1024 }],
  } } }));
  const runtime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath,
    modelsStorePath: path.join(root, 'models-cache.json'), allowModelNetwork: false });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 1024 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ mode: 'on', inlineBudget: 3000 }), createToolSearchExtension(),
      createDeferredResultExtension(deferred)],
  });
  await loader.reload();
  const manager = SessionManager.create(workspace, path.join(root, 'sessions'));
  const sessionPath = manager.getSessionFile()!;
  let control = parentControl || new RunController({ file: `${sessionPath}.run.json`, limits,
    onChange: run => events.push({ type: 'execution_run', run }) });
  const assembly = createSandboxedTools(workspace, extraTools(workspace, { sessionPath, baseUrl }), {
    agentDir, workspace, codiaHome: root, getSandboxEnabled: () => sandboxEnabled,
    getSandboxNetworkEnabled: () => true,
    getSessionPath: () => sessionPath, emitEvent: event => { events.push(event); },
  } as Parameters<typeof createSandboxedTools>[2]);
  const actionLedger = new ToolActionLedger(path.join(root, 'actions'));
  const tools = wrapWithSessionPermission(wrapWithCheckpoint(assembly.tools, {
    store: new CheckpointStore(path.join(root, 'checkpoints')), maxFileSizeKb: 1024, cwd: workspace,
    getSessionPath: () => sessionPath,
  }), { actionLedger, cwd: workspace, getSessionPath: () => sessionPath, getPermissionMode: () => permissionMode });
  const sessionOptions = { cwd: workspace, agentDir, modelRuntime: runtime,
    model: runtime.getModel('codia-runtime-eval', live?.model || 'fixture'), tools,
    customTools: wrapWithSessionPermission(assembly.customTools, {
      actionLedger, cwd: workspace, getSessionPath: () => sessionPath, getPermissionMode: () => permissionMode,
    }),
    resourceLoader: loader, settingsManager: settings, sessionManager: manager, executionControl: control };
  let { session } = await createAgentSession(sessionOptions);
  session.subscribe(event => events.push(event));
  return { root, workspace, sessionPath, sessionOptions, actionLedger, deferred, get session() { return session; }, get control() { return control; }, requests, events, baseUrl, turns,
    setPermission: (mode: string) => { permissionMode = mode; },
    setSandbox: (enabled: boolean) => { sandboxEnabled = enabled; },
    async restart() {
      await session.abort(); await emitSessionShutdown(session); session.dispose();
      control = new RunController({ file: `${sessionPath}.run.json`, limits,
        onChange: run => events.push({ type: 'execution_run', run }) });
      ({ session } = await createAgentSession({ ...sessionOptions, executionControl: control,
        sessionManager: SessionManager.open(sessionPath) }));
      session.subscribe(event => events.push(event));
    },
    async close() {
      control.cancel();
      await session.abort(); await emitSessionShutdown(session); session.dispose();
      deferred.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      // All data was created under this unique temporary root.
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  } catch (error) {
    deferred.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
