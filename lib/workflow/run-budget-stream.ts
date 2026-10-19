import { createAssistantMessageEventStream } from '../pi-sdk/index.ts';
import { RunBudget, safeRunBudgetFailure } from './run-budget.ts';

function hasUnsupportedMedia(value: any, depth = 0): boolean {
  if (depth > 64) return true;
  if (!value || typeof value !== 'object') return false;
  if (['image', 'image_url', 'input_image', 'input_audio', 'audio', 'video', 'input_file', 'document'].includes(value.type)) return true;
  if (Array.isArray(value.modalities) && value.modalities.some((item: unknown) => item !== 'text')) return true;
  return Object.values(value).some(child => child && typeof child === 'object' && hasUnsupportedMedia(child, depth + 1));
}

/** Install on the actual isolated session before its first provider request.
 * The object is only supplied through trusted server context, never script args.
 */
export function installRunBudgetStreamGuard(session: any, budget: RunBudget, getCurrentModel?: () => any) {
  const agent = session?.agent;
  // SDK 1.x exposes the active transport as streamFunction; streamFn is the
  // constructor option and an older-runtime compatibility slot only.
  const streamSlot = typeof agent?.streamFunction === 'function' ? 'streamFunction' : 'streamFn';
  if (!(budget instanceof RunBudget) || typeof agent?.[streamSlot] !== 'function') throw new Error('bounded model execution unavailable');
  const original = agent[streamSlot].bind(agent);
  agent[streamSlot] = async (model: any, context: any, options: any = {}) => {
    // Media and opaque provider inputs need separate accounting, not text guesses.
    const messages = context?.messages || [];
    if (messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => ['image', 'audio', 'video'].includes(part.type)))) throw new Error('media budget accounting is unsupported');
    if (options.signal?.aborted) throw new Error('run aborted before model admission');
    if (getCurrentModel) budget.assertModel(getCurrentModel());
    const reservation = budget.reserve(model);
    const outer = createAssistantMessageEventStream();
    const remainingMs = Math.max(1, budget.limits.maxDurationMs - (Date.now() - budget.startedAt));
    const deadline = AbortSignal.timeout(remainingMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const errorEvent = (reason: string, aborted = false) => ({
      type: 'error' as const, reason: aborted ? 'aborted' as const : 'error' as const, error: {
        role: 'assistant' as const, content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: aborted ? 'aborted' as const : 'error' as const, errorMessage: safeRunBudgetFailure(reason), timestamp: Date.now(),
      },
    });
    const onAbort = () => {
      budget.uncertain(reservation.id, 'request aborted; provider usage unknown');
      // Release SDK consumers even if a provider ignores cancellation forever.
      // Remote work is still unknown, so its reservation is deliberately retained.
      outer.push(errorEvent('request aborted; provider usage unknown', true));
      outer.end();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    let settled = false;
    let failed = false;
    let payloadGuardCalled = false;
    void (async () => {
      try {
        if (signal.aborted) return;
        const inner = await original(model, context, {
          ...options, signal, timeoutMs: remainingMs, maxTokens: reservation.maxOutputTokens, maxRetries: 0,
          cacheRetention: 'none', transport: 'sse',
          onPayload: async (payload: any, resolved: any) => {
            budget.assertActive();
            if (getCurrentModel) budget.assertModel(getCurrentModel());
            // Preserve the host's observer, but clamp after it and after sampling overrides.
            const candidate = await options.onPayload?.(payload, resolved) ?? payload;
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid bounded provider payload');
            const next = { ...candidate, model: model.id };
            if (hasUnsupportedMedia(next)) throw new Error('media budget accounting is unsupported');
            const fields = model.api === 'openai-responses' ? ['max_output_tokens'] : model.api === 'anthropic-messages' ? ['max_tokens'] : ['max_tokens', 'max_completion_tokens'];
            const present = fields.filter(field => Object.hasOwn(next, field));
            if (!present.length) throw new Error('provider adapter omitted output cap');
            for (const field of present) next[field] = reservation.maxOutputTokens;
            if (Object.hasOwn(next, 'n')) next.n = 1;
            if (Object.hasOwn(next, 'best_of')) next.best_of = 1;
            // Server-managed tools incur charges beyond token accounting.
            if (Array.isArray(next.tools) && next.tools.some((tool: any) => tool.type && !['function', 'custom'].includes(tool.type))) throw new Error('provider-hosted tool pricing is unsupported');
            payloadGuardCalled = true;
            return next;
          },
        });
        for await (const event of inner) {
          if (signal.aborted) break;
          if (event.type === 'done') {
            if (failed || signal.aborted) throw new Error('provider completed after an error or deadline');
            if (!payloadGuardCalled) throw new Error('provider adapter bypassed the bounded payload guard');
            budget.settle(reservation.id, event.message?.usage);
            settled = true;
          } else if (event.type === 'error') {
            failed = true;
            throw new Error('provider error or aborted response');
          }
          outer.push(event);
        }
        if (!settled) throw new Error('provider response ended without reliable final usage');
      } catch (error) {
        const safeReason = safeRunBudgetFailure(error);
        budget.uncertain(reservation.id, safeReason);
        outer.push(errorEvent(safeReason));
      } finally { signal.removeEventListener('abort', onAbort); outer.end(); }
    })();
    return outer;
  };
}
