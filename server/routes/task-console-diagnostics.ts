import { resolveModelInputModalities, modelSupportsImageInput } from '../../shared/model-capabilities.ts';

const finitePositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const rate = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
/** Configuration diagnostics, not a live provider qualification or a billing promise. */
export function diagnoseTemplateRuntime(engine: any, budget: any = {}) {
  budget = budget && typeof budget === 'object' && !Array.isArray(budget) ? budget : {};
  const model = engine.currentModel;
  const entries: any[] = model ? engine.usageLedger?.list?.({ modelId: model.id, provider: model.provider, limit: 100 })?.entries || [] : [];
  const inputRate = rate(model?.cost?.input);
  const outputRate = rate(model?.cost?.output);
  const tokensValid = finitePositive(budget.maxTokens) && Number.isSafeInteger(budget.maxTokens);
  const moneyValid = finitePositive(budget.maxUsd);
  // Worst input/output rate for an explicit token allowance; cache/tool fees are not covered.
  const estimateUsd = tokensValid && inputRate !== null && outputRate !== null && Math.max(inputRate, outputRate) > 0
    ? budget.maxTokens * Math.max(inputRate, outputRate) / 1_000_000 : null;
  const budgetState = !tokensValid || !moneyValid ? 'fail'
    : estimateUsd === null ? 'unknown' : estimateUsd > budget.maxUsd ? 'fail' : 'pass';
  return {
    model: {
      id: model?.id || null, provider: model?.provider || null,
      inputModalities: model ? resolveModelInputModalities(model) : [],
      visionConfigured: model ? modelSupportsImageInput(model) : false,
      toolCalling: typeof model?.toolCalling === 'boolean' ? (model.toolCalling ? 'configured' : 'unsupported') : 'unknown',
      structuredOutput: 'unknown', liveQualification: 'not-run',
      recentRecordedCalls: entries.length,
      recentSuccessfulCalls: entries.filter(entry => entry.status === 'ok').length,
      recentFailedCalls: entries.filter(entry => entry.status === 'error').length,
    },
    budget: {
      state: budgetState, maxTokens: tokensValid ? budget.maxTokens : null, maxUsd: moneyValid ? budget.maxUsd : null,
      estimateUsd, pricing: estimateUsd === null ? 'unknown' : 'configured-estimate',
      note: '按配置的输入/输出单价估算，不是供应商账单；不含缓存写入、工具或其他费用。聊天草稿中的预算不是硬性执行限额。',
    },
  };
}
