/** Existing Codia modelRegistry only; no new provider protocol or credential setup. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRunBudget } from '../lib/workflow/run-budget.ts';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function blocked(attempted = false) { const error = new Error('Model evaluation budget or configuration blocked.'); error.code = 'budget_blocked'; error.attempted = attempted; return error; }

/** Reusable with an initialized Engine. This adapter never executes model tools. */
export function createConfiguredModelTaskAdapter({ engine, modelRef, limits, versions = {} }) {
  if (typeof engine?.resolveModelWithCredentials !== 'function' || typeof engine?.modelRegistry?.streamSimple !== 'function') throw new Error('Existing Codia model runtime is required.');
  const resolved = engine.resolveModelWithCredentials(modelRef);
  const model = { ...resolved.model, provider: resolved.provider || resolved.model?.provider, api: resolved.api || resolved.model?.api, baseUrl: resolved.base_url || resolved.model?.baseUrl, headers: { ...resolved.model?.headers, ...resolved.headers } };
  const budget = createRunBudget({ ...limits, maxSteps: 30, maxModelCalls: 30, maxOutputTokensPerCall: 1024 }, model);
  const configFingerprint = fingerprint(resolved);
  return {
    mode: 'live',
    versions: { provider: model.provider, model: model.id.replaceAll('/', '_'), prompt: 'v1', template: 'bounded-json-v1', strategy: 'single-agent', ...versions },
    budgetSnapshot: () => budget.snapshot(),
    async generate(request) {
      if (request.signal.aborted || fingerprint(engine.resolveModelWithCredentials(modelRef)) !== configFingerprint) throw blocked();
      let reservation;
      try { reservation = budget.reserve(model); } catch { throw blocked(); }
      const remainingMs = Math.max(1, budget.limits.maxDurationMs - (Date.now() - budget.startedAt));
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(remainingMs)]);
      let payloadObserved = false;
      const usageRequest = engine.usageLedger?.start?.({ requestId: request.traceId, model: { provider: model.provider, modelId: model.id, api: model.api }, costRates: model.cost,
        usageContext: { source: { subsystem: 'utility', operation: 'model_task_evaluation', surface: 'developer', trigger: 'manual' }, attribution: { kind: 'utility', agentId: engine.currentAgentId || null } },
        metadata: { evaluationTraceId: request.traceId, caseId: request.caseId } });
      const onAbort = () => budget.uncertain(reservation.id, 'evaluation request aborted; provider usage unknown');
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const stream = await engine.modelRegistry.streamSimple(model, {
          systemPrompt: request.messages.find(message => message.role === 'system')?.content || '',
          messages: request.messages.filter(message => message.role === 'user').map(message => ({ role: 'user', content: message.content, timestamp: Date.now() })),
        }, {
          apiKey: resolved.api_key || undefined, headers: model.headers, signal,
          maxTokens: reservation.maxOutputTokens, maxRetries: 0, timeoutMs: remainingMs, cacheRetention: 'none', transport: 'sse', reasoning: 'off',
          onPayload: (payload, actualModel) => {
            budget.assertActive();
            if (signal.aborted || (actualModel && (actualModel.id !== model.id || actualModel.provider !== model.provider || actualModel.api !== model.api))) throw blocked();
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw blocked();
            const next = { ...payload };
            const fields = model.api === 'openai-responses' ? ['max_output_tokens'] : model.api === 'anthropic-messages' ? ['max_tokens'] : ['max_tokens', 'max_completion_tokens'];
            const present = fields.filter(field => Object.hasOwn(next, field));
            if (!present.length) throw blocked();
            for (const field of present) next[field] = reservation.maxOutputTokens;
            if (Object.hasOwn(next, 'n')) next.n = 1;
            // Only text responses are requested; never let provider-hosted tools run.
            delete next.tools; delete next.tool_choice;
            payloadObserved = true;
            return next;
          },
        });
        const response = await stream.result();
        if (signal.aborted || !payloadObserved || response?.model !== model.id || response?.provider !== model.provider || response?.api !== model.api || response?.stopReason !== 'stop' || !Array.isArray(response?.content) || response.content.some(block => block.type !== 'text' && block.type !== 'thinking')) throw blocked();
        budget.settle(reservation.id, response.usage);
        engine.usageLedger?.finish?.(usageRequest?.requestId, { usage: response.usage, model: { provider: model.provider, modelId: model.id, api: model.api }, costRates: model.cost });
        const usage = response.usage;
        const cost = (usage.input * model.cost.input + usage.output * model.cost.output + (usage.cacheRead || 0) * (model.cost.cacheRead || 0) + (usage.cacheWrite || 0) * (model.cost.cacheWrite || 0)) / 1_000_000;
        return { output: response.content.filter(block => block.type === 'text').map(block => block.text).join(''), usage: { inputTokens: usage.input + (usage.cacheRead || 0) + (usage.cacheWrite || 0), outputTokens: usage.output }, cost: { amount: cost, currency: 'USD', source: 'estimated' }, traceId: request.traceId };
      } catch {
        budget.uncertain(reservation.id, 'evaluation provider response or usage uncertain');
        engine.usageLedger?.recordError?.(usageRequest?.requestId, new Error('model_task_evaluation_failed'));
        throw blocked(true);
      } finally { signal.removeEventListener('abort', onAbort); }
    },
  };
}

/** CLI bootstrap: only reads an explicitly selected existing Codia configuration. */
export async function createAdapter({ env = process.env } = {}) {
  const home = env.CODIA_EVAL_HOME;
  const provider = env.CODIA_EVAL_PROVIDER;
  const id = env.CODIA_EVAL_MODEL;
  const limits = { maxUsd: Number(env.CODIA_EVAL_MAX_USD), maxTokens: Number(env.CODIA_EVAL_MAX_TOKENS), maxDurationMs: Number(env.CODIA_EVAL_MAX_DURATION_MS) };
  if (!home || !path.isAbsolute(home) || !provider || !id || !Number.isFinite(limits.maxUsd) || limits.maxUsd <= 0 || !Number.isSafeInteger(limits.maxTokens) || limits.maxTokens <= 0 || !Number.isSafeInteger(limits.maxDurationMs) || limits.maxDurationMs <= 0 || limits.maxDurationMs > 600_000) throw new Error('Existing configuration, model reference, and explicit budgets are required.');
  for (const filename of ['models.json', 'auth.json', 'added-models.yaml']) if (!fs.statSync(path.join(home, filename)).isFile()) throw new Error('Existing Codia configuration is incomplete.');
  const [{ ModelRuntime, createModelRegistry }, { ProviderRegistry }, { runtimeApiKeyRefProvider }, { allowsMissingApiKey }] = await Promise.all([
    import('../lib/pi-sdk/index.ts'), import('../core/provider-registry.ts'), import('../shared/runtime-api-key-ref.ts'), import('../shared/net-utils.ts'),
  ]);
  const providers = new ProviderRegistry(home);
  providers.reload();
  const runtime = await ModelRuntime.create({ authPath: path.join(home, 'auth.json'), modelsPath: path.join(home, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  const registry = createModelRegistry(runtime);
  const modelRef = { provider, id };
  const engine = {
    modelRegistry: registry,
    resolveModelWithCredentials() {
      const model = registry.find(provider, id);
      const credentials = providers.getCredentials(provider);
      if (!model || !credentials) throw new Error('Requested configured model unavailable.');
      // Existing runtime-reference aliases resolve in memory; no credentials are created or persisted.
      const alias = runtimeApiKeyRefProvider(credentials.apiKey);
      const key = alias ? providers.getCredentials(alias)?.apiKey : credentials.apiKey;
      if (alias && (!key || runtimeApiKeyRefProvider(key))) throw new Error('Configured credential reference unavailable.');
      return { model, provider, api: credentials.api || model.api, base_url: credentials.baseUrl || model.baseUrl, headers: credentials.headers || {}, api_key: credentials.authType === 'oauth' ? undefined : key || (allowsMissingApiKey({ baseUrl: credentials.baseUrl || model.baseUrl, authType: credentials.authType }) ? 'local' : undefined) };
    },
  };
  return createConfiguredModelTaskAdapter({ engine, modelRef, limits });
}
