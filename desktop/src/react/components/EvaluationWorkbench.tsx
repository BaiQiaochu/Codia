import { useRef, useState } from 'react';
import { downloadJson } from '../utils/download-json';
import { parseEvaluationReport, compareEvaluationReports, compareModelTaskReports, type EvaluationReport, type EvaluationCase } from '../../../../shared/task-console/evaluation-report';

const metric = (value: number | null, suffix = '') => value === null ? '未知／未测量' : `${Number(value.toPrecision(6))}${suffix}`;
function ReportSummary({ report }: { report: EvaluationReport }) {
  const cases: EvaluationCase[] = report.cases;
  return <div>
    <p>Trace：{report.traceId} · 版本：{report.revision || '未记录'} · 工作区：{report.workingTree}</p>
    <p>通过 {cases.filter(c => c.status === 'passed').length} / {cases.length}；得分 {cases.reduce((n, c) => n + c.score, 0)} / {cases.reduce((n, c) => n + c.maximumScore, 0)}</p>
    {report.kind === 'model-task-evaluation' && <>
      <p>执行来源：{report.executionMode === 'mock' ? '模拟参考答案回放，仅验证评测工具，不代表真实模型质量' : report.executionMode === 'disabled' ? '未执行，真实模型验证待完成' : '报告声明为已配置模型调用，限固定文本任务，不代表端到端工具验收'}</p>
      <p>数据集：{report.dataset.id} / {report.dataset.version} · 模型：{report.versions.provider}/{report.versions.model} · 提示词：{report.versions.prompt} · 模板：{report.versions.template} · 策略：{report.versions.strategy}</p>
      <p>成功率：{metric(report.summary.successRate === null ? null : report.summary.successRate * 100, '%')} · 质量得分率：{metric(report.summary.qualityRate === null ? null : report.summary.qualityRate * 100, '%')} · 平均耗时：{metric(report.summary.averageDurationMs, ' ms')}</p>
      <p>成功任务平均费用：{metric(report.summary.successfulTaskAverageCostUsd, ' USD')} · 已知成功费用样本均值：{metric(report.summary.knownSuccessfulTaskAverageCostUsd, ' USD')}（{report.summary.knownSuccessfulCostCases} 个样本）</p>
      <p>费用未知：{report.summary.unknownCostCases} 个已调用任务 · 配置估算：{report.summary.estimatedCostCases} · 供应商报告：{report.summary.providerReportedCostCases}。未知费用不记为免费。</p>
      {report.budget && <p>本地预算状态：{report.budget.state} · 已计费用：{metric(report.budget.committedUsd, ' USD')} · 未决预留：{metric(report.budget.reservedUsd, ' USD')}。本地预留不保证供应商账单硬上限。</p>}
    </>}
  </div>;
}

export function EvaluationWorkbench() {
  const [reports, setReports] = useState<(EvaluationReport | null)[]>([null, null]);
  const [error, setError] = useState('');
  const loadSequence = useRef([0, 0]);
  const load = async (file: File | undefined, index: number) => {
    const sequence = ++loadSequence.current[index];
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('报告不能超过 1 MiB');
      const report = parseEvaluationReport(JSON.parse(await file.text()));
      if (sequence !== loadSequence.current[index]) return;
      setReports(current => current.map((r, i) => i === index ? report : r)); setError('');
    } catch {
      if (sequence === loadSequence.current[index]) setError('报告格式无效或超过 1 MiB；旧报告未被替换。');
    }
  };
  let comparison: ReturnType<typeof compareEvaluationReports> = [];
  let comparisonError = '';
  let modelComparison: ReturnType<typeof compareModelTaskReports> | null = null;
  if (reports[0] && reports[1]) {
    try {
      comparison = compareEvaluationReports(reports[0], reports[1]);
      if (reports[0].kind === 'model-task-evaluation' && reports[1].kind === 'model-task-evaluation') modelComparison = compareModelTaskReports(reports[0], reports[1]);
    } catch { comparisonError = '这两个报告不可比较。请使用同类型、同数据集、同评分契约且执行完整的报告；模拟回放不能与真实模型混比。'; }
  }
  const download = () => {
    // Re-apply the allowlist at the export boundary; imported summary/extra fields never survive.
    downloadJson({ reports: reports.map(report => report ? parseEvaluationReport(report) : null), comparison, modelComparison }, 'codia-evaluation-comparison.json');
  };
  return <section aria-label="评测与诊断工作台"><h3>评测与诊断工作台</h3>
    <p>导入 scripts/evaluation-gate.mjs 或 scripts/model-task-evaluation-cli.mjs 生成的 JSON 报告。报告留在此页面，不上传。确定性回归、模拟参考回放和真实模型任务分别标明，不能互相代替。</p>
    {[0, 1].map(i => <div key={i}><label>{i === 0 ? '基线报告' : '候选报告'}<input type="file" accept="application/json,.json" onChange={e => void load(e.target.files?.[0], i)} /></label>{reports[i] && <ReportSummary report={reports[i]!} />}</div>)}
    {error && <p role="alert">{error}</p>}
    {comparisonError && <p role="alert">{comparisonError}</p>}
    {comparison.length > 0 && <section aria-label="评测对比"><h4>用例变化</h4><p>回归 {comparison.filter(c => c.regression).length}；改善 {comparison.filter(c => c.improved).length}</p>
      {modelComparison && <p>候选减基线：成功率 {metric(modelComparison.successRateDelta === null ? null : modelComparison.successRateDelta * 100, ' 个百分点')}；质量得分率 {metric(modelComparison.qualityRateDelta === null ? null : modelComparison.qualityRateDelta * 100, ' 个百分点')}；平均耗时 {metric(modelComparison.averageDurationMsDelta, ' ms')}；成功任务平均费用 {metric(modelComparison.successfulTaskAverageCostUsdDelta, ' USD')}。</p>}
      <ul>{comparison.map(c => <li key={c.id}>{c.id}：{c.previous} → {c.current}{c.regression ? '（回归）' : ''}</li>)}</ul></section>}
    <button type="button" disabled={!reports.some(Boolean)} onClick={download}>导出脱敏摘要与比较</button>
    <p>导出仅含白名单指标、版本与 Trace 关联；不包含原始提示词、回复、凭据、工具参数、绝对路径或模型隐藏推理。导入文件中的执行来源由报告声明，页面不会独立验证供应商调用。</p>
  </section>;
}
