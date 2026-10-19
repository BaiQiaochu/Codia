import { normalizeProviderBaseUrl } from "./provider-endpoints.ts";
/** User-confirmed local estimates, never a promise about the provider invoice. */
export type PricingRates = { input: number; output: number; cacheRead?: number | null; cacheWrite?: number | null };
export type PricingBinding = { provider: string; modelId: string; api: string; baseUrl: string };
export interface ModelPricing {
  version: 1; currency: 'USD'; unit: 'per-million-tokens'; cost: PricingRates;
  source: string; confirmedAt: string; confirmedFree: boolean; binding: PricingBinding;
  invalidatedAt?: string;
}
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export const isKnownPriceRate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const endpoint = (value: unknown) => String(value || '').trim().replace(/\/+$/, '');
export function modelPricingBinding(model: any): PricingBinding {
  const provider = String(model?.provider || ''); const api = String(model?.api || '');
  const baseUrl = ((provider === 'ollama' && api === 'openai-completions') || (['minimax', 'minimax-token-plan'].includes(provider) && api === 'anthropic-messages'))
    ? normalizeProviderBaseUrl({ provider, baseUrl: endpoint(model?.baseUrl), api }) : endpoint(model?.baseUrl);
  return { provider, modelId: String(model?.id || model?.modelId || ''), api, baseUrl: endpoint(baseUrl) };
}
export function confirmModelPricing(value: unknown, binding: PricingBinding, now = new Date().toISOString()): ModelPricing | null {
  if (value === null) return null; // Explicitly remove a local rate; no catalog fallback.
  if (!record(value) || value.confirmed !== true || value.currency !== 'USD' || value.unit !== 'per-million-tokens') throw new Error('pricing must be explicitly confirmed in USD per million tokens');
  const cost = value.cost;
  if (!record(cost) || !isKnownPriceRate(cost.input) || !isKnownPriceRate(cost.output)) throw new Error('pricing input and output must be finite non-negative numbers');
  for (const key of ['cacheRead', 'cacheWrite']) if (cost[key] !== undefined && cost[key] !== null && !isKnownPriceRate(cost[key])) throw new Error(`invalid pricing ${key}`);
  const source = typeof value.source === 'string' ? value.source.trim() : '';
  if (!source || source.length > 500) throw new Error('pricing source is required (maximum 500 characters)');
  const zero = cost.input === 0 && cost.output === 0;
  if (zero && (value.confirmedFree !== true || cost.cacheRead !== 0 || cost.cacheWrite !== 0)) throw new Error('zero pricing requires explicit free confirmation for input, output and cache');
  if (!zero && value.confirmedFree === true) throw new Error('confirmed free pricing cannot have nonzero rates');
  if (!binding.provider || !binding.modelId || !binding.api) throw new Error('pricing model binding is incomplete');
  return { version: 1, currency: 'USD', unit: 'per-million-tokens', cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead ?? null, cacheWrite: cost.cacheWrite ?? null }, source, confirmedAt: now, confirmedFree: zero, binding: { ...binding, baseUrl: endpoint(binding.baseUrl) } };
}
export function resolveModelPricing(model: any): { state: 'known' | 'free' | 'unknown'; rates: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null }; reason: string } {
  const unknown = (reason: string) => ({ state: 'unknown' as const, rates: { input: null, output: null, cacheRead: null, cacheWrite: null }, reason });
  let cost = model?.cost;
  const pricing = model?.pricing;
  if (pricing !== undefined) {
    if (!record(pricing) || pricing.version !== 1 || pricing.currency !== 'USD' || pricing.unit !== 'per-million-tokens' || pricing.invalidatedAt || !Number.isFinite(Date.parse(pricing.confirmedAt)) || !pricing.source || !record(pricing.binding)) return unknown('local pricing is unconfirmed or invalidated');
    const expected = modelPricingBinding(model);
    if (Object.keys(expected).some(key => String(pricing.binding[key] ?? '') !== expected[key as keyof PricingBinding])) return unknown('pricing model or endpoint changed; confirm again');
    cost = pricing.cost;
  }
  if (!record(cost) || !isKnownPriceRate(cost.input) || !isKnownPriceRate(cost.output)) return unknown('input or output pricing is unknown');
  const rates = { input: cost.input, output: cost.output, cacheRead: isKnownPriceRate(cost.cacheRead) ? cost.cacheRead : null, cacheWrite: isKnownPriceRate(cost.cacheWrite) ? cost.cacheWrite : null };
  if (cost.input === 0 && cost.output === 0) {
    if (pricing?.confirmedFree === true && rates.cacheRead === 0 && rates.cacheWrite === 0) return { state: 'free', rates, reason: 'explicitly confirmed free local estimate' };
    return unknown('zero placeholder is not confirmed free pricing');
  }
  if (pricing?.confirmedFree === true) return unknown('inconsistent confirmed free pricing');
  return { state: 'known', rates, reason: pricing ? 'user-confirmed local estimate' : 'configured catalog estimate' };
}
/** SDK requires numeric cache rates. Metadata preserves unknown cache rates. */
export function projectModelPricing(model: any): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const result = resolveModelPricing(model);
  return { input: result.rates.input ?? 0, output: result.rates.output ?? 0, cacheRead: result.rates.cacheRead ?? 0, cacheWrite: result.rates.cacheWrite ?? 0 };
}
