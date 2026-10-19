import { createHash } from 'node:crypto';
import { redactLogText } from '../log-redactor.ts';
import { resolveModelPricing } from '../../shared/model-pricing.ts';
/** Preserve unknown cache prices and explicit free confirmation through SDK numeric projections. */
export function usageCostRates(model: any, fallbackRates?: any) {
  if (!model?.cost && model?.pricing === undefined && !fallbackRates) return null;
  const resolved = resolveModelPricing({ ...model, cost: model?.cost || fallbackRates });
  return { ...resolved.rates, currency: 'USD', zeroCostConfirmed: resolved.state === 'free',
    needsReview: resolved.state === 'unknown', source: redactLogText(String(model?.pricing?.source || 'model configuration')), confirmedAt: model?.pricing?.confirmedAt || null };
}

/** Opaque binding; endpoint URLs and headers must never enter the durable ledger. */
export function usageReservationBinding(model: any, maxOutputTokens?: number) {
  const output = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : model?.maxTokens ?? null;
  return createHash('sha256').update(JSON.stringify({ provider: model?.provider ?? null, modelId: model?.id ?? model?.modelId ?? null,
    api: model?.api ?? null, endpoint: String(model?.baseUrl || '').replace(/\/+$/, ''),
    contextWindow: model?.contextWindow ?? null, output, rates: usageCostRates(model) })).digest('hex');
}
