// @ts-nocheck
import { createAssistantMessageEventStream } from '../pi-sdk/index.ts';
const installed = Symbol.for('codia.usageBudgetGuard');
const accounted = Symbol.for('codia.usageAccounted');
export const USAGE_RESERVATION = Symbol.for('codia.usageReservation');
export function hasUsageBudgetGuard(session) { return session?.agent?.[installed] === true; }
export function isUsageAccounted(message) { return message?.[accounted] === true; }
/** Reserve before dispatch, including retries/tool turns. Existing memory/payload guards remain intact. */
export function installUsageBudgetGuard(session, getLedger, getUsageContext, getCurrentModel) {
  const agent = session?.agent;
  const slot = typeof agent?.streamFunction === 'function' ? 'streamFunction' : 'streamFn';
  if (!agent || typeof agent[slot] !== 'function' || agent[installed]) return;
  const original = agent[slot];
  agent[installed] = true;
  agent[slot] = async (model, context, options = {}) => {
    const ledger = getLedger?.();
    if (typeof ledger?.start !== 'function') return original.call(agent, model, context, options);
    const parent = options[USAGE_RESERVATION];
    const current = getCurrentModel?.(model);
    if (current && (current.api !== model.api || String(current.baseUrl || '').replace(/\/+$/, '') !== String(model.baseUrl || '').replace(/\/+$/, ''))) throw new Error('Model endpoint changed; refresh the session before retrying');
    const accountingModel = current ? { ...model, contextWindow: current.contextWindow, maxTokens: current.maxTokens, cost: current.cost, pricing: current.pricing } : typeof getCurrentModel === 'function' ? { ...model, cost: null, pricing: null } : model;
    if (parent?.ledger === ledger && ledger.hasPending?.(parent.requestId)) {
      if (typeof ledger.assertReservationMatches !== 'function') throw new Error('Cannot validate the parent usage reservation');
      ledger.assertReservationMatches(parent.requestId, accountingModel, options.maxTokens);
      return original.call(agent, model, context, options);
    }
    const usageContext = getUsageContext?.() || {};
    const request = ledger.start({ model: accountingModel, usageContext, costRates: model?.cost, maxOutputTokens: options.maxTokens });
    let inner;
    try { inner = await original.call(agent, model, context, options); }
    catch (error) { ledger.recordError(request.requestId, error); throw error; }
    const outer = createAssistantMessageEventStream();
    void (async () => {
      let settled = false;
      try {
        for await (const event of inner) {
          if (event.type === 'done' || event.type === 'error') {
            const message = event.type === 'done' ? event.message : event.error;
            if (message && typeof message === 'object') Object.defineProperty(message, accounted, { value: true, configurable: true, enumerable: true });
            if (!settled) {
              if (event.type === 'done') ledger.finish(request.requestId, { usage: message?.usage, model: accountingModel, costRates: accountingModel?.cost });
              else ledger.recordError(request.requestId, new Error('Provider request failed; usage may be incomplete'), 'error', {
                usage: message?.usage?.totalTokens > 0 ? message.usage : null, costRates: accountingModel?.cost,
              });
              settled = true;
            }
          }
          outer.push(event);
        }
      } catch (error) {
        if (!settled) { ledger.recordError(request.requestId, error); settled = true; }
        outer.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], stopReason: 'error', errorMessage: error?.message || 'Stream failed', [accounted]: true } });
      } finally {
        if (!settled) ledger.recordError(request.requestId, new Error('Provider stream ended without reliable final usage'));
        outer.end();
      }
    })();
    return outer;
  };
}
