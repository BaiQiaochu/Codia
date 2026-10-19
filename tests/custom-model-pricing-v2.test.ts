import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { Hono } from 'hono';
import { createProvidersRoute } from '../server/routes/providers.ts';
import os from 'node:os';
import path from 'node:path';
import { ModelManager } from '../core/model-manager.ts';
import { installRunBudgetStreamGuard } from '../lib/workflow/run-budget-stream.ts';
import { resolveQualificationModel } from '../lib/model-qualification/index.ts';
import { ProviderRegistry } from '../core/provider-registry.ts';
import { syncModels } from '../core/model-sync.ts';
import { confirmModelPricing, modelPricingBinding, resolveModelPricing } from '../shared/model-pricing.ts';
import { createRunBudget, inspectRunBudget } from '../lib/workflow/run-budget.ts';
const roots: string[] = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-pricing-v2-')); roots.push(home);
  const registry = new ProviderRegistry(home);
  registry.saveProvider('local-price-fixture', { base_url: 'http://localhost:11434/v1', api: 'openai-completions', models: [{ id: 'custom-model', context: 1000, maxOutput: 500 }] });
  return { home, registry };
}
const pricing = { expectedBinding: { provider: 'local-price-fixture', modelId: 'custom-model', api: 'openai-completions', baseUrl: 'http://localhost:11434/v1' }, currency: 'USD', unit: 'per-million-tokens', cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 2 }, source: 'User supplied test rate', confirmed: true, confirmedFree: false };
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
describe('custom model pricing end-to-end regression', () => {
  it('persists validated pricing and projects costs to actual SDK configuration', () => {
    const { home, registry } = fixture();
    registry.updateModelEntry('local-price-fixture', 'custom-model', { pricing });
    const raw = registry.getAllProvidersRaw();
    expect(raw['local-price-fixture'].models[0].pricing).toMatchObject({ cost: pricing.cost, currency: 'USD' });
    syncModels(raw, { modelsJsonPath: path.join(home, 'models.json') });
    const synced = JSON.parse(fs.readFileSync(path.join(home, 'models.json'), 'utf8'));
    expect(synced.providers['local-price-fixture'].models[0].cost).toEqual(pricing.cost);
  });
  it('rejects negative, missing and unconfirmed zero prices without changing persisted metadata', () => {
    const { registry } = fixture();
    for (const cost of [{ input: -1, output: 1 }, { input: 1 }, { input: 0, output: 0 }]) {
      expect(() => registry.updateModelEntry('local-price-fixture', 'custom-model', { pricing: { ...pricing, cost } })).toThrow(/price|pricing|价格|free/i);
    }
    expect(registry.getAllProvidersRaw()['local-price-fixture'].models[0].pricing).toBeUndefined();
  });
  it('permits an explicitly confirmed free model while unknown zero placeholders still fail', () => {
    const { registry } = fixture();
    registry.updateModelEntry('local-price-fixture', 'custom-model', { pricing: { ...pricing, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, confirmedFree: true } });
    const p = registry.getAllProvidersRaw()['local-price-fixture'].models[0].pricing;
    const model = { id: 'custom-model', provider: 'local-price-fixture', api: 'openai-completions', baseUrl: 'http://localhost:11434/v1', contextWindow: 1000, maxTokens: 500, cost: p?.cost, pricing: p };
    const limits = { maxTokens: 2000, maxUsd: 1, maxSteps: 2, maxDurationMs: 10000, maxOutputTokensPerCall: 100 };
    expect(inspectRunBudget(limits, model).state).toBe('pass');
  });
});


describe('pricing binding and estimate integrity', () => {
  const model = { id: 'custom', provider: 'local', api: 'openai-completions', baseUrl: 'http://localhost:11434/v1', contextWindow: 1000, maxTokens: 500, cost: pricing.cost };
  const limits = { maxTokens: 4000, maxUsd: 1, maxSteps: 2, maxDurationMs: 10000, maxOutputTokensPerCall: 100 };
  it('rejects copied model identities, endpoints and invalidated confirmations', () => {
    const confirmed = confirmModelPricing(pricing, modelPricingBinding(model));
    for (const current of [{ ...model, id: 'other' }, { ...model, baseUrl: 'https://different.example/v1' }, { ...model, api: 'anthropic-messages' }]) expect(resolveModelPricing({ ...current, pricing: confirmed }).state).toBe('unknown');
    expect(resolveModelPricing({ ...model, pricing: { ...confirmed, invalidatedAt: new Date().toISOString() } }).state).toBe('unknown');
  });
  it('invalidates persisted pricing on a provider endpoint edit and permits fresh confirmation', () => {
    const { registry } = fixture(); registry.updateModelEntry('local-price-fixture', 'custom-model', { pricing });
    registry.saveProvider('local-price-fixture', { base_url: 'http://localhost:11435/v1' });
    expect(registry.getAllProvidersRaw()['local-price-fixture'].models[0].pricing.invalidatedAt).toBeTruthy();
    expect(() => registry.updateModelEntry('local-price-fixture', 'custom-model', { pricing })).toThrow(/configuration changed/);
    registry.updateModelEntry('local-price-fixture', 'custom-model', { pricing: { ...pricing, expectedBinding: { ...pricing.expectedBinding, baseUrl: 'http://localhost:11435/v1' } } });
    const result = registry.getAllProvidersRaw()['local-price-fixture'].models[0].pricing;
    expect(result.invalidatedAt).toBeUndefined(); expect(result.binding.baseUrl).toBe('http://localhost:11435/v1');
  });
  it('uses confirmed rates rather than a mismatched SDK placeholder and rejects a changed confirmation mid-run', () => {
    const confirmed = confirmModelPricing(pricing, modelPricingBinding(model));
    const current = { ...model, cost: { input: 0, output: 0 }, pricing: confirmed };
    const budget = createRunBudget(limits, current);
    expect(budget.reserve(current).reservedUsd).toBeCloseTo(.0024);
    expect(() => budget.reserve({ ...current, pricing: { ...confirmed!, source: 'Changed rate source' } })).toThrow(/changed/);
  });
  it('preserves missing cache pricing as unknown and blocks cache settlement', () => {
    const confirmed = confirmModelPricing({ ...pricing, cost: { input: 2, output: 4 } }, modelPricingBinding(model));
    const current = { ...model, pricing: confirmed };
    expect(resolveModelPricing(current).rates.cacheRead).toBeNull();
    const budget = createRunBudget(limits, current); const reservation = budget.reserve(current);
    expect(() => budget.settle(reservation.id, { input: 10, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 25 })).toThrow(/cache price/);
  });
  it('rejects null, strings, infinity and non-USD rates without coercion', () => {
    for (const cost of [{ input: null, output: 1 }, { input: '2', output: 1 }, { input: Infinity, output: 1 }, { input: 2, output: 1, cacheRead: -1 }]) expect(() => confirmModelPricing({ ...pricing, cost }, modelPricingBinding(model))).toThrow(/pricing/);
    expect(() => confirmModelPricing({ ...pricing, currency: 'CNY' }, modelPricingBinding(model))).toThrow(/USD/);
  });
});


describe('real SDK runtime pricing metadata', () => {
  it('retains pricing through the SDK reload and invalidates the qualification fingerprint on edit', async () => {
    const { home, registry } = fixture();
    registry.updateModelEntry('local-price-fixture', 'custom-model', { pricing });
    const manager = new ModelManager({ codiaHome: home }) as ModelManager & { providerRegistry: ProviderRegistry }; await manager.init(); await manager.syncAndRefresh();
    const selected = () => manager.availableModels.find((m: any) => m.provider === 'local-price-fixture' && m.id === 'custom-model');
    expect(selected()).toMatchObject({ cost: pricing.cost, pricing: { cost: pricing.cost, source: pricing.source } });
    expect(resolveModelPricing(selected()).state).toBe('known');
    const engine = { currentModel: { provider: 'local-price-fixture', id: 'custom-model' }, resolveModelWithCredentials: () => manager.resolveModelWithCredentials('local-price-fixture/custom-model') };
    const before = resolveQualificationModel(engine).fingerprint;
    manager.providerRegistry.updateModelEntry('local-price-fixture', 'custom-model', { pricing: { ...pricing, cost: { ...pricing.cost, input: 7 } } }); await manager.syncAndRefresh();
    expect(selected().cost.input).toBe(7); expect(resolveQualificationModel(engine).fingerprint).not.toBe(before);
    manager.providerRegistry.updateModelEntry('local-price-fixture', 'custom-model', { pricing: null }); await manager.syncAndRefresh();
    expect(selected().pricing).toBeNull(); expect(resolveModelPricing(selected()).state).toBe('unknown');
  });
  it('rejects a still-frozen SDK session before its next request when the live price changes', async () => {
    const model = { id: 'custom', provider: 'local', api: 'openai-completions', contextWindow: 1000, maxTokens: 500, cost: pricing.cost };
    const budget = createRunBudget({ maxTokens: 4000, maxUsd: 1, maxSteps: 2, maxDurationMs: 10000, maxOutputTokensPerCall: 100 }, model);
    let calls = 0; const session: any = { agent: { streamFn: async () => { calls++; } } };
    installRunBudgetStreamGuard(session, budget, () => ({ ...model, cost: { ...model.cost, input: 99 } }));
    await expect(session.agent.streamFn(model, { messages: [] })).rejects.toThrow(/price configuration changed/);
    expect(calls).toBe(0); expect(budget.snapshot().calls).toBe(0);
  });
});


describe('custom pricing HTTP validation', () => {
  it('returns validation/conflict errors without persisting a price and preserves provider authorization', async () => {
    const { registry } = fixture(); const engine = { providerRegistry: registry, onProviderChanged: async () => {} };
    const app = new Hono(); let scopes = ['providers.manage'];
    app.use('*', async (c, next) => { c.set('authPrincipal' as never, { kind: 'account_user', principalId: 'owner', scopes } as never); await next(); });
    app.route('/api', createProvidersRoute(engine));
    const put = (p: unknown) => app.request('/api/providers/local-price-fixture/models/custom-model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pricing: p }) });
    expect((await put({ ...pricing, cost: { input: -1, output: 2 } })).status).toBe(400);
    expect((await put({ ...pricing, expectedBinding: { ...pricing.expectedBinding, baseUrl: 'http://localhost:9999/v1' } })).status).toBe(409);
    expect(registry.getAllProvidersRaw()['local-price-fixture'].models[0].pricing).toBeUndefined();
    scopes = ['settings.read']; expect((await put(pricing)).status).toBe(403);
  });
});
