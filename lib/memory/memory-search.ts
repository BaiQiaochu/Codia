// @ts-nocheck
import { Type } from '@sinclair/typebox';
import { t } from '../i18n.ts';
import { MemoryQueryService, estimateMemoryTokens } from './query-service.ts';
import { normalizeToolRuntimeContext } from '../tools/tool-session.ts';
import { memoryGenerationMarker } from './prompt-guard.ts';

/** Scope is supplied by the host runtime, never widened by model-authored project IDs. */
export function createMemorySearchTool(factStore, opts = {}) {
  const conversationScope = opts.conversationScope || null;
  const isChannelScope = conversationScope?.kind === 'channel' && conversationScope?.channelId;
  const queryService = new MemoryQueryService(factStore, opts);
  const parameters = {
    query: Type.String({ description: t('error.memorySearchQueryDesc') }),
    tags: Type.Optional(Type.Array(Type.String(), { description: t('error.memorySearchTagsDesc') })),
    date_from: Type.Optional(Type.String({ description: t('error.memorySearchDateFromDesc') })),
    date_to: Type.Optional(Type.String({ description: t('error.memorySearchDateToDesc') })),
  };
  if (isChannelScope) parameters.cross_channel = Type.Optional(Type.Boolean({
    description: 'Search across other channel memories instead of only this channel.',
  }));
  return {
    name: 'search_memory', label: t('error.memorySearchLabel'),
    description: t('error.memorySearchDesc'), parameters: Type.Object(parameters),
    execute: async (_toolCallId, params, _signal = undefined, _onUpdate = undefined, runtimeContext = undefined) => {
      try {
        for (const value of [params.date_from, params.date_to]) {
          if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)))) {
            throw new Error('Memory dates must use YYYY-MM-DD');
          }
        }
        if (params.date_from && params.date_to && params.date_from > params.date_to) {
          throw new Error('Memory date_from must not be later than date_to');
        }
        const { ctx } = normalizeToolRuntimeContext(_signal, runtimeContext);
        const context = typeof opts.getContext === 'function' ? opts.getContext(ctx) || {} : {};
        const marker = memoryGenerationMarker(factStore.generation || '0');
        const budget = opts.tokenBudget ?? 2400;
        const result = queryService.query({
          query: params.query, tags: params.tags,
          projectId: context.projectId || opts.projectId || null,
          channelId: isChannelScope ? conversationScope.channelId : context.channel || null,
          excludeChannels: !isChannelScope && !context.channel,
          crossChannel: isChannelScope && params.cross_channel === true,
          dateRange: {
            from: params.date_from || undefined,
            to: params.date_to ? `${params.date_to}T23:59:59.999Z` : undefined,
          },
          tokenBudget: Math.max(0, budget - estimateMemoryTokens(marker + '\n') - 80), limit: opts.limit ?? 8,
        });
        const validUntil = result.results.flatMap(fact => [fact.expiresAt, fact.expires_at, fact.validTo]).filter(Boolean).sort()[0] || 'none';
        const text = result.text ? marker + `\n[codia-memory-valid-until:${validUntil}]\n` + result.text : t('error.memorySearchEmpty');
        return {
          content: [{ type: 'text', text }],
          details: {
            resultCount: result.results.length, memoryIds: result.injectedIds,
            retrievedIds: result.retrievedIds, injectedIds: result.injectedIds,
            estimatedTokens: result.text ? estimateMemoryTokens(text) : 0, tokenBudget: budget,
            tokenEstimateMethod: result.tokenEstimateMethod, omittedCount: result.omittedCount,
            capabilities: result.capabilities, elapsedMs: result.elapsedMs,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: t('error.memorySearchError', { msg: err.message }) }],
          details: { error: true, resultCount: 0, injectedIds: [] },
        };
      }
    },
  };
}
