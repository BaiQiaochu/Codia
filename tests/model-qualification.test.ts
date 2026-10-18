import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ModelQualificationService, getModelQualificationService, QUALIFICATION_TTL_MS } from '../lib/model-qualification/index.ts';
import { buildQualificationCase, buildQualificationPayload, validateQualificationResponse, QUALIFICATION_MARKER } from '../lib/model-qualification/cases.ts';
import { createModelQualificationRoute } from '../server/routes/model-qualification.ts';
import { createUsageLedger } from '../lib/llm/usage-ledger.ts';

const homes: string[] = [];
function home() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-qualification-')); homes.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const budget = { maxCalls: 4, maxTokens: 100_000, maxUsd: 1, maxDurationMs: 10_000 };
const usage = { input: 30, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 50 };
function reply(model: any, context: any) {
  const prompt = context.messages[0].content[0].text;
  const content = context.tools ? [{ type: 'toolCall', id: 'fixture-only', name: 'codia_capability_echo', arguments: { marker: QUALIFICATION_MARKER, count: 3 } }]
    : [{ type: 'text', text: context.messages[0].content.some((part: any) => part.type === 'image') ? 'red,blue'
      : prompt.includes('JSON') ? JSON.stringify({ marker: QUALIFICATION_MARKER, count: 3 }) : QUALIFICATION_MARKER }];
  return { role: 'assistant', provider: model.provider, model: model.id, api: model.api, content, usage, stopReason: context.tools ? 'toolUse' : 'stop' };
}
function engineFixture(override: Record<string, any> = {}) {
  const currentModel = { id: 'fixture-model', provider: 'configured-fixture', api: 'openai-completions', baseUrl: 'https://never-called.example/v1',
    input: ['text', 'image'], toolCalling: true, contextWindow: 1024, maxTokens: 2048, cost: { input: 1, output: 2 }, ...override };
  const captured: any[] = [];
  const engine: any = { currentModel, codiaHome: home(), usageLedger: createUsageLedger(),
    resolveModelWithCredentials: vi.fn((ref: any) => {
      if (ref.id !== engine.currentModel.id || ref.provider !== engine.currentModel.provider) throw new Error('not configured');
      return { model: engine.currentModel, api: engine.currentModel.api, api_key: 'NEVER_PERSIST_THIS_KEY', base_url: engine.currentModel.baseUrl, headers: { 'X-Fixture-Secret': 'NEVER_PERSIST_THIS_HEADER' } };
    }),
    modelRegistry: { streamSimple: vi.fn((model: any, context: any, options: any) => ({ result: async () => {
      const payload = await options.onPayload({ model: model.id, max_tokens: 9000, messages: context.messages, ...(context.tools ? { tools: context.tools } : {}) }, model);
      captured.push({ payload, model, context, options });
      options.onResponse({ status: 200 });
      return reply(model, context);
    } })) },
  };
  return { engine, captured };
}
async function qualify(service: ModelQualificationService, overrides: any = {}) {
  return await service.qualify({ manual: true, budget, mediaTokenAccountingConfirmed: true, ...overrides });
}

describe('configured model capability qualification', () => {
  it('runs four genuine provider-interface cases, validates actual results, persists provenance and reuses the usage ledger', async () => {
    const { engine, captured } = engineFixture();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No test may reach a provider'));
    const service = getModelQualificationService(engine);
    expect(service.inspect().state).toBe('unknown');
    const report = await qualify(service);
    expect(report.results.map(result => result.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(report).toMatchObject({ provenance: 'configured-provider', status: 'completed', mediaAccounting: 'fixture-input-token-estimate-confirmed' });
    expect(captured).toHaveLength(4);
    expect(captured[0].options).toMatchObject({ maxTokens: 256, maxRetries: 0, cacheRetention: 'none', reasoning: 'off' });
    expect(captured[0].payload.max_tokens).toBe(256);
    expect(captured[1].context.tools[0]).toMatchObject({ name: 'codia_capability_echo' });
    expect(captured[1].context.tools[0]).not.toHaveProperty('execute');
    const png = Buffer.from(captured[2].context.messages[0].content[1].data, 'base64');
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(captured[3].payload.response_format.json_schema).toMatchObject({ strict: true, schema: { additionalProperties: false } });
    expect(report.budget).toMatchObject({ calls: 4, committedTokens: 200, pendingCalls: 0, providerInvoiceHardCap: false });
    const entries = engine.usageLedger.list({}).entries;
    expect(entries).toHaveLength(4);
    expect(entries.every((entry: any) => entry.source.operation === 'model_capability_qualification' && entry.status === 'ok')).toBe(true);
    expect(new ModelQualificationService(engine).inspect({ requiredCapabilities: ['text', 'tool', 'vision', 'structured'] }).state).toBe('pass');
    expect(network).not.toHaveBeenCalled();
    const files = fs.readdirSync(path.join(engine.codiaHome, 'model-qualification'));
    const persisted = fs.readFileSync(path.join(engine.codiaHome, 'model-qualification', files[0]), 'utf8');
    expect(persisted).not.toMatch(/NEVER_PERSIST|never-called|codia_capability_17|red,blue/);
    expect(persisted).toContain('responseDigest');
  });

  it('cannot use the test-only injected transport as runtime qualification', async () => {
    const { engine } = engineFixture();
    const invoke = vi.fn(async (model, context, options) => {
      options.onPayload({ max_tokens: 256, messages: context.messages, ...(context.tools ? { tools: context.tools } : {}) }, model); return reply(model, context);
    });
    const service = new ModelQualificationService(engine, { invoke });
    const report = await qualify(service);
    expect(report.results.every(result => result.status === 'pass')).toBe(true);
    expect(report.provenance).toBe('test-injected');
    expect(new ModelQualificationService(engine).inspect()).toMatchObject({ state: 'unknown', reason: 'test_evidence_not_runtime_qualification' });
  });

  it('does not treat configured capabilities or caller reports as evidence', async () => {
    const { engine } = engineFixture();
    engine.modelQualification = { state: 'pass', text: true, tool: true };
    expect(getModelQualificationService(engine).inspect()).toMatchObject({ state: 'unknown', reason: 'qualification_not_run' });
    expect(engine.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });

  it.each(['baseUrl', 'cost', 'headers', 'apiKey'])('invalidates persisted results after %s configuration changes', async field => {
    const { engine } = engineFixture();
    const service = getModelQualificationService(engine);
    await qualify(service);
    if (field === 'apiKey') {
      engine.resolveModelWithCredentials.mockImplementation((ref: any) => ({ model: engine.currentModel, api: engine.currentModel.api, api_key: 'ROTATED', base_url: engine.currentModel.baseUrl }));
    } else engine.currentModel[field] = field === 'cost' ? { input: 3, output: 4 } : field === 'headers' ? { 'X-Test': 'changed' } : 'https://changed.example/v1';
    expect(service.inspect()).toMatchObject({ state: 'unknown', reason: 'model_configuration_changed' });
  });

  it('expires results and does not substitute another model by bare ID', async () => {
    const { engine } = engineFixture();
    let now = Date.now();
    const service = new ModelQualificationService(engine, { now: () => now });
    await qualify(service);
    now += QUALIFICATION_TTL_MS;
    expect(service.inspect()).toMatchObject({ state: 'unknown', reason: 'qualification_expired' });
    expect(service.inspect({ modelRef: 'fixture-model' }).state).toBe('unknown');
    engine.currentModel = { ...engine.currentModel, id: 'another-model' };
    expect(service.inspect().reason).toBe('qualification_not_run');
  });

  it('keeps failed answers failed, even with successful HTTP and usage', async () => {
    const { engine } = engineFixture();
    engine.modelRegistry.streamSimple.mockImplementation((model: any, context: any, options: any) => ({ result: async () => {
      options.onPayload({ max_tokens: 256 }, model);
      return { ...reply(model, context), content: [{ type: 'text', text: 'looks good' }] };
    } }));
    const service = getModelQualificationService(engine);
    const report = await qualify(service, { capabilities: ['text'] });
    expect(report.results[0]).toMatchObject({ status: 'fail', code: 'text_contract_failed' });
    expect(service.inspect({ requiredCapabilities: ['text'] }).state).toBe('fail');
  });

  it.each([{ input: undefined, output: undefined }, { input: 0, output: 0 }])('blocks unknown or placeholder pricing before any call', async cost => {
    const { engine } = engineFixture({ cost });
    const report = await qualify(getModelQualificationService(engine));
    expect(report.results.every(result => result.status === 'blocked')).toBe(true);
    expect(engine.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });

  it('enforces reservations and maximum calls instead of prompt-only budgets', async () => {
    const { engine } = engineFixture();
    const service = getModelQualificationService(engine);
    const tooSmall = await qualify(service, { budget: { ...budget, maxTokens: 100 } });
    expect(tooSmall.results[0].status).toBe('blocked');
    expect(engine.modelRegistry.streamSimple).not.toHaveBeenCalled();
    const oneCall = await qualify(service, { budget: { ...budget, maxCalls: 1 } });
    expect(oneCall.results.map(result => result.status)).toEqual(['pass', 'blocked', 'blocked', 'blocked']);
    expect(engine.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    expect(service.inspect().state).toBe('unknown');
  });

  it('keeps unknown usage reserved and blocks every later dispatch', async () => {
    const { engine } = engineFixture();
    engine.modelRegistry.streamSimple.mockImplementation((model: any, context: any, options: any) => ({ result: async () => {
      options.onPayload({ max_tokens: 256 }, model); return { ...reply(model, context), usage: undefined };
    } }));
    const report = await qualify(getModelQualificationService(engine));
    expect(engine.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    expect(report.results[0].status).toBe('fail');
    expect(report.results.slice(1).every(result => result.status === 'blocked')).toBe(true);
    expect(report.budget).toMatchObject({ state: 'blocked', pendingCalls: 1, reservedTokens: 1280 });
  });

  it('requires explicit fixture media accounting and fails unsupported native-schema APIs closed', async () => {
    const { engine } = engineFixture({ api: 'anthropic-messages' });
    const report = await qualify(getModelQualificationService(engine), { mediaTokenAccountingConfirmed: false });
    expect(report.results[2]).toMatchObject({ status: 'unsupported', code: 'media_pricing_unverified' });
    expect(report.results[3]).toMatchObject({ status: 'unsupported', code: 'native_schema_transport_unsupported' });
    expect(engine.modelRegistry.streamSimple).toHaveBeenCalledTimes(2);
  });

  it('requires a payload hook and matching actual model identity', async () => {
    const { engine } = engineFixture();
    engine.modelRegistry.streamSimple.mockImplementation((model: any, context: any) => ({ result: async () => reply(model, context) }));
    const service = getModelQualificationService(engine);
    expect((await qualify(service, { capabilities: ['text'] })).results[0].code).toBe('provider_payload_unobserved');
    engine.modelRegistry.streamSimple.mockImplementation((model: any, context: any, options: any) => ({ result: async () => {
      options.onPayload({ max_tokens: 256 }, model); return { ...reply(model, context), model: 'silent-fallback' };
    } }));
    expect((await qualify(service, { capabilities: ['text'] })).results[0].code).toBe('response_model_mismatch');
  });

  it('times out even if the provider ignores abort and prevents overlapping probes', async () => {
    const { engine } = engineFixture();
    engine.modelRegistry.streamSimple.mockImplementation(() => ({ result: () => new Promise(() => {}) }));
    const service = getModelQualificationService(engine);
    const pending = qualify(service, { budget: { ...budget, maxDurationMs: 20 } });
    await expect(qualify(service)).rejects.toThrow('qualification_already_running');
    const report = await pending;
    expect(report.status).toBe('interrupted');
    expect(report.results[0]).toMatchObject({ status: 'fail', code: 'request_aborted' });
    expect(engine.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    expect(service.inspect().reason).toBe('qualification_incomplete');
  });

  it('does not invoke an already-cancelled run or a nonmanual request', async () => {
    const { engine } = engineFixture();
    const service = getModelQualificationService(engine);
    await expect(service.qualify({ manual: false, budget } as any)).rejects.toThrow('manual_qualification_required');
    const controller = new AbortController(); controller.abort();
    const report = await qualify(service, { signal: controller.signal });
    expect(report.status).toBe('interrupted');
    expect(engine.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });

  it('invalidates old passes immediately and never trusts an interrupted or corrupt disk record', async () => {
    const { engine } = engineFixture();
    const service = getModelQualificationService(engine); await qualify(service);
    engine.modelRegistry.streamSimple.mockImplementation(() => ({ result: () => new Promise(() => {}) }));
    const next = qualify(service, { budget: { ...budget, maxDurationMs: 20 } });
    expect(new ModelQualificationService(engine).inspect().reason).toBe('qualification_incomplete');
    await next;
    const directory = path.join(engine.codiaHome, 'model-qualification');
    fs.writeFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'broken');
    expect(service.inspect().reason).toBe('qualification_not_run');
  });

  it('sanitizes provider errors and does not persist request auth or provider responses', async () => {
    const { engine } = engineFixture();
    engine.modelRegistry.streamSimple.mockImplementation((_m: any, _c: any, options: any) => ({ result: async () => {
      options.onResponse({ status: 401 }); throw new Error('NEVER_PERSIST_THIS_KEY https://private-host/?token=secret');
    } }));
    const report = await qualify(getModelQualificationService(engine));
    expect(report.results[0].code).toBe('provider_auth_failed');
    expect(JSON.stringify(report)).not.toMatch(/NEVER_PERSIST|private-host|secret/);
    expect(JSON.stringify(engine.usageLedger.list({}))).not.toMatch(/NEVER_PERSIST|private-host|secret/);
  });
});

describe('fixed capability validators and provider adapters', () => {
  it('does not mistake prose, extra properties or truncated JSON for structured/tool capability', () => {
    const model = { id: 'm', provider: 'p' };
    const tool = reply(model, buildQualificationCase('tool', 0));
    expect(validateQualificationResponse('tool', { ...tool, content: [{ type: 'text', text: 'calling tool' }] }, true)).toBe('tool_contract_failed');
    const structured = reply(model, buildQualificationCase('structured', 0));
    expect(validateQualificationResponse('structured', { ...structured, content: [{ type: 'text', text: JSON.stringify({ marker: QUALIFICATION_MARKER, count: 3, extra: true }) }] }, true)).toBe('schema_contract_failed');
    expect(validateQualificationResponse('structured', { ...structured, stopReason: 'length' }, true)).toBe('provider_response_failed');
  });
  it('uses native Responses schema and clamps output after existing compatibility normalization', () => {
    const model = { id: 'fixture', provider: 'fixture', api: 'openai-responses', maxTokens: 2048 };
    const payload = buildQualificationPayload({ input: [], max_output_tokens: 99999, n: 5 }, model, 'structured', 128);
    expect(payload).toMatchObject({ max_output_tokens: 128, n: 1, text: { format: { type: 'json_schema', strict: true } } });
  });
});

describe('model qualification REST route', () => {
  it('keeps reads noncalling, validates manual intent and ignores untrusted pass evidence', async () => {
    const { engine } = engineFixture(); const app = new Hono(); app.route('/api', createModelQualificationRoute(engine));
    expect((await (await app.request('/api/models/qualification')).json()).qualification.state).toBe('unknown');
    expect(engine.modelRegistry.streamSimple).not.toHaveBeenCalled();
    const request = (body: unknown) => app.request('/api/models/qualification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await request({ budget, qualification: { state: 'pass' } })).status).toBe(400);
    const response = await request({ manual: true, budget, capabilities: ['text', 'tool'], qualification: { state: 'pass' }, credentials: 'IGNORED', endpoint: 'https://evil.invalid' });
    expect(response.status).toBe(200);
    const data = await response.json(); expect(data.qualification.state).toBe('pass');
    expect(engine.modelRegistry.streamSimple).toHaveBeenCalledTimes(2);
    expect(data.report.results[2].status).toBe('not-run');
    expect((await app.request('/api/models/qualification?modelId=fixture-model')).status).toBe(400);
    expect((await app.request('/api/models/qualification', { method: 'POST', body: '{' })).status).toBe(400);
  });
  it('never reflects resolver secrets into HTTP errors', async () => {
    const { engine } = engineFixture(); engine.resolveModelWithCredentials.mockImplementation(() => { throw new Error('credential=NEVER_PERSIST_THIS_KEY'); });
    const app = new Hono(); app.route('/api', createModelQualificationRoute(engine));
    const response = await app.request('/api/models/qualification', { method: 'POST', body: JSON.stringify({ manual: true, budget }) });
    expect(response.status).toBe(422); expect(await response.text()).not.toContain('NEVER_PERSIST');
  });
});

describe('real SDK adapter with an injected deterministic HTTP transport', () => {
  it('serializes images/tools/native schemas and parses SSE through the existing provider adapter without network', async () => {
    const { streamSimple } = await import('@earendil-works/pi-ai/compat');
    const { engine } = engineFixture();
    const requests: any[] = [];
    const fetchFixture = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body); requests.push(body);
      const hasTool = body.tools?.length > 0;
      const hasImage = body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === 'image_url'));
      const text = body.response_format ? JSON.stringify({ marker: QUALIFICATION_MARKER, count: 3 }) : hasImage ? 'red,blue' : QUALIFICATION_MARKER;
      const delta = hasTool ? { tool_calls: [{ index: 0, id: 'fixture_tool', type: 'function', function: { name: 'codia_capability_echo', arguments: JSON.stringify({ marker: QUALIFICATION_MARKER, count: 3 }) } }] } : { content: text };
      const chunks = [
        { id: 'fixture_completion', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] },
        { id: 'fixture_completion', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: hasTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const service = new ModelQualificationService(engine, { invoke: async (model, context, options) => streamSimple(model, context, { ...options, fetch: fetchFixture as typeof fetch }).result() });
    const report = await qualify(service);
    expect(report.results.map(result => ({ status: result.status, code: result.code }))).toEqual(Array.from({ length: 4 }, () => ({ status: 'pass', code: 'case_passed' })));
    expect(fetchFixture).toHaveBeenCalledTimes(4);
    expect(requests[1].tools[0].function.name).toBe('codia_capability_echo');
    expect(requests[2].messages.some((message: any) => message.content?.some?.((part: any) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,')))).toBe(true);
    expect(requests[3].response_format.json_schema.strict).toBe(true);
    expect(report.provenance).toBe('test-injected');
    expect(service.inspect().state).toBe('unknown');
  });
});
