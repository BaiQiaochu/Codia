import { t } from '../../helpers';
import type { TranslationVars } from '../../shared-types';

type Vars = TranslationVars;

const USAGE_ZH_FALLBACK: Record<string, string> = {
  'settings.usage.title': '用量统计',
  'settings.usage.note': '用量仅作参考，具体以供应商统计为准。',
  'settings.usage.refresh': '刷新',
  'settings.usage.total': '总览',
  'settings.usage.requests': '请求数',
  'settings.usage.totalTokens': '总 Token',
  'settings.usage.cacheRead': '缓存命中',
  'settings.usage.cacheHitRate': '命中率',
  'settings.usage.estimatedCost': '预估成本',
  'settings.usage.uncached': '未缓存消耗',
  'settings.usage.modelMix': '模型分布',
  'settings.usage.dailyUsage': '每日用量',
  'settings.usage.window.week': '最近 7 天',
  'settings.usage.window.month': '最近 30 天',
  'settings.usage.period.week': '7 天',
  'settings.usage.period.month': '30 天',
  'settings.usage.requestLedger': '请求明细',
  'settings.usage.loading': '正在加载用量记录...',
  'settings.usage.empty': '暂无用量记录',
  'settings.usage.groupMeta': '{requests} 次 / {errors} 错误',
  'settings.usage.cacheShort': '缓存 {tokens}',
  'settings.usage.tokensShort': '{tokens} token',
  'settings.usage.cacheSummary': '缓存 {cache} / 未缓存 {uncached}',
  'settings.usage.view.overall': '总览',
  'settings.usage.view.daily': '按日期',
  'settings.usage.view.category': '按类别',
  'settings.usage.view.model': '按模型',
  'settings.usage.category.session': '会话',
  'settings.usage.category.phone': '手机',
  'settings.usage.category.memory': '记忆',
  'settings.usage.category.automation': '自动化',
  'settings.usage.category.subagent': '子代理',
  'settings.usage.category.compaction': '压缩',
  'settings.usage.category.plugin': '插件',
  'settings.usage.category.utility': '工具',
  'settings.usage.category.vision': '视觉',
  'settings.usage.category.unknown': '未知',
  'settings.usage.status.ok': '完成',
  'settings.usage.status.error': '错误',
  'settings.usage.status.aborted': '已中止',
  'settings.usage.status.usage_missing': '无用量',
};

function interpolate(template: string, params?: Vars): string {
  if (!params) return template;
  return template.replace(/\{([^}]+)\}/g, (match, key) => {
    const value = params[key];
    return value === undefined || value === null ? match : String(value);
  });
}

export function usageT(key: string, params?: Vars): string {
  const fallback = USAGE_ZH_FALLBACK[key];
  if (fallback) return interpolate(fallback, params);

  const value = t(key, params);
  if (typeof value === 'string' && value && value !== key && !value.startsWith('settings.usage.')) {
    return value;
  }
  return key;
}
