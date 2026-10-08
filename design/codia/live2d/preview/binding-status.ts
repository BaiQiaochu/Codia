import { coreParameterIds, extraParameterIds } from './timeline';
import type { BindingValidation } from './validate-bindings';

export function coreBindingStatus(report: BindingValidation) {
  const results = new Map(report.parameters.map(item => [item.id, item.status]));
  const responsive = coreParameterIds.filter(id => results.get(id) === 'responsive');
  const inactive = coreParameterIds.filter(id => results.get(id) === 'no-change-detected');
  const missing = coreParameterIds.filter(id => !results.has(id) || results.get(id) === 'missing');
  return { total: coreParameterIds.length, responsive, inactive, missing,
    ready: report.state === 'checked' && responsive.length === coreParameterIds.length };
}

export function bindingStatusText(report: BindingValidation): string {
  return coreBindingStatus(report).ready
    ? '模型已载入 · 9 个核心动作参数有响应，待视觉验收'
    : '模型已载入 · 核心动作参数响应仍需补齐';
}

export function bindingSummaryText(report: BindingValidation): string {
  const core = coreBindingStatus(report);
  const extra = report.parameters.filter(item => (extraParameterIds as readonly string[]).includes(item.id));
  const extraResponsive = extra.filter(item => item.status === 'responsive').length;
  return `核心动作参数：${core.responsive.length}/${core.total} 项有变化，${core.inactive.length} 项未检测到变化，${core.missing.length} 项缺失。`
    + `扩展调试参数：${extraResponsive}/${extraParameterIds.length} 项有变化；这 4 项不参与自动循环。`;
}
