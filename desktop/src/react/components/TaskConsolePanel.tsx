import { useCallback, useEffect, useRef, useState } from 'react';
import { codiaFetch } from '../hooks/use-codia-fetch';
import { useStore } from '../stores';
import { requestInputDraft } from '../utils/input-draft-events';
import { clearPendingTemplateLaunch, markPendingTemplateLaunchUnknown, preparePendingTemplateLaunch, readPendingTemplateLaunch, type PendingTemplateLaunch } from '../utils/template-launch-pending';
import { switchSession } from '../stores/session-actions';
import { TASK_TEMPLATES } from '../../../../shared/task-console/templates';
import type { ConsoleRun } from '../../../../shared/task-console/records';
import styles from './TaskConsolePanel.module.css';
import { EvaluationWorkbench } from './EvaluationWorkbench';
import { TaskResultsPanel } from './TaskResultsPanel';
import { ToolActionLedgerPanel } from './ToolActionLedgerPanel';
import { WorkflowRecoveryPanel } from './WorkflowRecoveryPanel';

type Approval = { id: string; kind: string; sessionPath: string | null };
type Snapshot = { runs: ConsoleRun[]; approvals: Approval[]; interruptedApprovals?: Approval[]; limitations: string[] };
type Preflight = { executionAllowed?: boolean; budgetContract?: { reason: string; note: string; reservationTokens: number | null; reservationUsd: number | null }; qualificationEvidence?: { reason: string };  environment?: { tools: { note: string; checks: { name: string; state: string; connection: string | null }[] }; directory: { reason: string } }; plan?: { steps: { id: string; instruction: string }[] }; checks: { id: string; label: string; state: string }[]; reason: string; modelId: string | null; draft: string; diagnostics?: { model: { inputModalities: string[]; visionConfigured: boolean; toolCalling: string; recentRecordedCalls: number; recentSuccessfulCalls: number; recentFailedCalls: number }; budget: { estimateUsd: number | null; note: string } } };
const labels: Record<string, string> = { queued: '排队', running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消', waiting_approval: '待审批', awaiting_approval: '待审批', blocked: '受阻', assigned: '已分配', partial_failure: '部分失败', recovery_required: '需恢复', unknown: '未知' };
const pendingLaunchState = (): { record: PendingTemplateLaunch | null; issue: string } => {
  try { return { record: readPendingTemplateLaunch(), issue: '' }; } catch (error) { return { record: null, issue: String(error) }; }
};
const date = (value: number | null) => value === null ? '未知' : new Date(value).toLocaleString();

export function TaskConsolePanel() {
  const [data, setData] = useState<Snapshot>({ runs: [], approvals: [], limitations: [] });
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'runs' | 'templates' | 'evaluations'>('runs');
  const [templateId, setTemplateId] = useState(TASK_TEMPLATES[0].id);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [maxTokens, setMaxTokens] = useState('');
  const [maxUsd, setMaxUsd] = useState('');
  const [maxSteps, setMaxSteps] = useState('8');
  const [maxDurationSeconds, setMaxDurationSeconds] = useState('300');
  const [maxOutputTokens, setMaxOutputTokens] = useState('1024');
  const [maxModelCalls, setMaxModelCalls] = useState('32');
  const [launchNotice, setLaunchNotice] = useState('');
  const [pendingLaunch, setPendingLaunch] = useState(pendingLaunchState);
  const launchInFlight = useRef(false);
  const [probeCapabilities, setProbeCapabilities] = useState(['text', 'tool']);
  const [confirmMediaPricing, setConfirmMediaPricing] = useState(false);
  const [probeBudgetReason, setProbeBudgetReason] = useState('');
  const [probeResults, setProbeResults] = useState<{ capability: string; status: string; code: string; suggestion: string }[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [connectorTools, setConnectorTools] = useState('');
  const [messages, setMessages] = useState<string | null>(null);
  const template = TASK_TEMPLATES.find(t => t.id === templateId)!;
  const selected = data.runs.find(run => run.id === selectedId);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const close = () => useStore.getState().setActivePanel(null);
  const refresh = useCallback(async () => {
    try {
      const response = await codiaFetch('/api/task-console');
      if (!response.ok) throw new Error(`读取失败 (${response.status})`);
      setData(await response.json()); setError('');
    } catch (err) { setError(String(err)); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { setMessages(null); }, [selectedId]);
  const stopRun = async (runId: string) => {
    setBusy(true);
    try {
      const response = await codiaFetch(`/api/workflow-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `停止失败 (${response.status})`);
      setLaunchNotice('已请求停止后续步骤。进行中的外部操作可能已经生效，请核对已有产物。');
      await refresh(); setError('');
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  };
  const openSession = async (sessionPath: string) => {
    try { await switchSession(sessionPath); close(); } catch (err) { setError(String(err)); }
  };
  const loadTranscript = async (run: ConsoleRun) => {
    try {
      const response = await codiaFetch(`/api/desk/activities/${encodeURIComponent(run.sourceId)}/session`);
      if (!response.ok) throw new Error(`会话读取失败 (${response.status})`);
      const result = await response.json();
      if (result.error) throw new Error('会话读取失败');
      if (selectedIdRef.current !== run.id) return;
      setMessages((result.messages || []).map((m: { role: string; content: string }) => `${m.role}: ${m.content}`).join('\n\n') || '暂无会话消息');
    } catch (err) { setError(String(err)); }
  };
  const requestBody = () => ({ templateId, version: template.version, inputs, workspace, connectorTools: connectorTools.split(',').map(name => name.trim()).filter(Boolean), budget: { maxTokens: Number(maxTokens), maxUsd: Number(maxUsd), maxSteps: Number(maxSteps), maxDurationMs: Number(maxDurationSeconds) * 1000, maxOutputTokensPerCall: Number(maxOutputTokens), maxModelCalls: Number(maxModelCalls) } });
  const launch = async () => {
    if (launchInFlight.current) return;
    launchInFlight.current = true;
    setBusy(true); setLaunchNotice('');
    try {
      const body = requestBody();
      // Save the receipt before sending. Network errors, reloads and changed
      // form inputs must never silently mint a replacement launch ID.
      const pending = await preparePendingTemplateLaunch(body);
      setPendingLaunch({ record: pending, issue: '' });
      const response = await codiaFetch('/api/task-console/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, confirmExperimental: true, requestId: pending.requestId }) });
      const result = await response.json();
      if (!response.ok) {
        if (result.checks) setPreflight(result);
        if (result.error === 'template_launch_result_unknown') {
          markPendingTemplateLaunchUnknown(pending.requestId);
          throw new Error('服务端无法确认旧启动结果。请先检查运行与成果，已阻止再次派发。');
        }
        throw new Error(result.error || `执行失败 (${response.status})`);
      }
      if (typeof result.runId !== 'string' || !result.runId.trim()) throw new Error('启动响应缺少运行 ID，结果尚未确认；重试将复用原请求。');
      clearPendingTemplateLaunch(pending.requestId);
      setPendingLaunch(pendingLaunchState());
      setLaunchNotice(`已启动 ${result.runId}。请在运行与成果中查看真实状态；尚未完成。`);
      setSelectedId(`workflow:${result.runId}`); setPreflight(null);
      await refresh(); setError('');
    } catch (err) {
      setPendingLaunch(pendingLaunchState());
      setError(String(err));
    } finally { launchInFlight.current = false; setBusy(false); }
  };
  const confirmReviewedPendingLaunch = () => {
    try {
      clearPendingTemplateLaunch(pendingLaunch.record?.requestId);
      setPendingLaunch(pendingLaunchState()); setPreflight(null); setError('');
      setLaunchNotice('已确认核查旧请求。请重新预检后再创建新启动请求；已有运行不会被取消。');
    } catch (err) { setError(String(err)); }
  };
  const qualify = async () => {
    setBusy(true); setLaunchNotice('');
    try {
      const response = await codiaFetch('/api/models/qualification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manual: true, capabilities: probeCapabilities, mediaTokenAccountingConfirmed: confirmMediaPricing, budget: { maxCalls: probeCapabilities.length, maxTokens: Number(maxTokens), maxUsd: Number(maxUsd), maxDurationMs: Math.min(Number(maxDurationSeconds) * 1000, 120000) } }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `能力探测失败 (${response.status})`);
      setProbeResults(result.report?.results || []);
      setProbeBudgetReason(result.report?.budget?.reason || '');
      setLaunchNotice(`模型能力探测：${result.qualification?.state === 'pass' ? '通过' : '未通过'}。这不代表模板端到端交付已通过验收。`);
      await check();
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true); setPreflight(null);
    try {
      const response = await codiaFetch('/api/task-console/preflight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody()) });
      if (!response.ok) throw new Error(`预检失败 (${response.status})`);
      setPreflight(await response.json()); setError('');
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  };
  return <section className={styles.panel} aria-label="任务与成果中心">
    <header className={styles.header}><h2>任务与成果中心</h2><button type="button" onClick={close} aria-label="关闭任务中心">关闭</button></header>
    <nav className={styles.toolbar} aria-label="任务中心导航">
      <button type="button" aria-pressed={tab === 'runs'} onClick={() => setTab('runs')}>运行与成果</button>
      <button type="button" aria-pressed={tab === 'templates'} onClick={() => setTab('templates')}>任务模板</button>
      <button type="button" aria-pressed={tab === 'evaluations'} onClick={() => setTab('evaluations')}>评测</button>
      <button type="button" onClick={() => void refresh()}>刷新</button>
    </nav>
    {launchNotice && <p role="status">{launchNotice}</p>}
    {(pendingLaunch.record || pendingLaunch.issue) && <aside aria-label="未确认的模板启动"><p>{pendingLaunch.issue || `启动请求 ${pendingLaunch.record!.requestId} 尚未确认。${pendingLaunch.record!.state === 'unknown' ? '服务端结果未知，已阻止再次派发。' : '恢复原输入后重试会复用同一请求；改变输入不会自动创建新请求。'} 请先检查运行与成果。`}</p>{pendingLaunch.record && <button type="button" disabled={busy} onClick={confirmReviewedPendingLaunch}>已核查已有运行，允许新建启动请求</button>}</aside>}
    {error && <p role="alert">{error}。已有记录可能不是最新状态。</p>}
    <div className={styles.body}>
      {tab === 'runs' ? <>
        <section aria-label="待我审批"><h3>待我审批 ({data.approvals.length})</h3>
          {data.approvals.length === 0 && <p>当前进程没有待处理审批。</p>}
          {data.approvals.map(a => <div className={styles.card} key={a.id}><span>{a.kind} · {a.id}</span>{a.sessionPath ? <button type="button" onClick={() => void openSession(a.sessionPath!)}>进入原会话审核</button> : <span>请在原设置页面审核</span>}</div>)}
          {(data.interruptedApprovals || []).map(a => <div className={styles.card} key={a.id}><p>{a.kind} · 重启中断，需重新请求批准</p>{a.sessionPath && <button type="button" onClick={() => void openSession(a.sessionPath!)}>进入原会话重新请求</button>}</div>)}
        </section>
        <ToolActionLedgerPanel openSession={openSession} />
        <div className={styles.columns}>
          <section aria-label="已有运行"><h3>已有运行 ({data.runs.length})</h3>{data.runs.length === 0 && <p>尚无可展示的活动记录。</p>}
            {data.runs.map(run => <button type="button" className={styles.run} aria-pressed={run.id === selectedId} key={run.id} onClick={() => setSelectedId(run.id)}><strong>{run.title}</strong><span>{labels[run.status] || run.status} · {run.owner}</span><small>{date(run.startedAt)}</small></button>)}
          </section>
          <section aria-label="运行详情"><h3>运行详情</h3>{!selected ? <p>选择一个运行，查看状态、来源和交付物。</p> : <>
            <h4>{selected.title}</h4><dl><dt>记录 ID</dt><dd>{selected.id}</dd><dt>状态</dt><dd>{labels[selected.status] || selected.status}</dd><dt>负责人</dt><dd>{selected.owner}</dd><dt>开始 / 结束</dt><dd>{date(selected.startedAt)} / {date(selected.finishedAt)}</dd><dt>费用</dt><dd>未知。{selected.cost.reason}</dd><dt>Token</dt><dd>{selected.tokens ?? '未记录'}</dd>{selected.parentTaskId && <><dt>父任务</dt><dd>{selected.parentTaskId}</dd></>}</dl>
            {selected.budget && <p>本地预算：已记录 {selected.budget.committedTokens} tokens / {selected.budget.committedUsd} USD；待确认预留 {selected.budget.reservedTokens} tokens / {selected.budget.reservedUsd} USD。{selected.budget.blockedReason || ''} {selected.budget.note}</p>}
            <p>{selected.summary}</p><h4>产物引用</h4>{selected.artifacts.length ? <ul>{selected.artifacts.map((a, i) => <li key={`${a}-${i}`}>{a}</li>)}</ul> : <p>该记录尚无结构化产物引用；可查看原会话中的结果。</p>}
            {selected.sessionPath && <TaskResultsPanel sessionPath={selected.sessionPath} />}
            {selected.sessionPath && <button type="button" onClick={() => void openSession(selected.sessionPath!)}>打开原会话</button>}
            {selected.source === 'workflow' && !selected.parentTaskId && selected.status === 'running' && <button type="button" disabled={busy} onClick={() => void stopRun(selected.sourceId)}>请求停止后续步骤</button>}
            {selected.source === 'workflow' && <WorkflowRecoveryPanel runId={selected.parentTaskId || selected.sourceId} onPrepared={close} />}
            {selected.source === 'activity' && <button type="button" onClick={() => void loadTranscript(selected)}>读取结果会话</button>}
            {messages !== null && <pre className={styles.transcript}>{messages}</pre>}
          </>}</section>
        </div><aside>{data.limitations.map(text => <p key={text}>{text}</p>)}</aside>
      </> : tab === 'evaluations' ? <EvaluationWorkbench /> : <section aria-label="版本化任务模板">
        <p>实验模板 · mock-only。尚未通过真实端到端模型验收。能力探测与预检通过后可显式启动实验运行；周报运行仅生成本次草稿，定时计划需另行配置。</p>
        <label>模板 <select disabled={busy} value={templateId} onChange={event => { setTemplateId(event.target.value); setInputs({}); setPreflight(null); }}>{TASK_TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.title} · v{t.version}</option>)}</select></label>
        <p>所需工具：{template.tools.join('；')}</p><p>交付物：{template.outputs.join('；')}</p><p>预计耗时 / 成本：未知</p>
        {template.inputs.map(key => <label className={styles.field} key={key}>{key}<input disabled={busy} value={inputs[key] || ''} onChange={e => { setInputs({ ...inputs, [key]: e.target.value }); setPreflight(null); }} /></label>)}
        <label className={styles.field}>已授权工作目录（绝对路径）<input disabled={busy} value={workspace} onChange={e => { setWorkspace(e.target.value); setPreflight(null); }} /></label>
        <label className={styles.field}>所需 MCP 工具完整名称（可选，逗号分隔）<input disabled={busy} value={connectorTools} onChange={e => { setConnectorTools(e.target.value); setPreflight(null); }} /></label>
        <label className={styles.field}>总 token 本地预算<input disabled={busy} type="number" min="1" step="1" value={maxTokens} onChange={e => { setMaxTokens(e.target.value); setPreflight(null); }} /></label>
        <label className={styles.field}>模型费用本地预算（USD）<input disabled={busy} type="number" min="0.01" step="0.01" value={maxUsd} onChange={e => { setMaxUsd(e.target.value); setPreflight(null); }} /></label>
        <label className={styles.field}>工作流步骤上限<input disabled={busy} type="number" min="1" max="1000" value={maxSteps} onChange={e => { setMaxSteps(e.target.value); setPreflight(null); }} /></label>
        <label className={styles.field}>时长上限（秒）<input disabled={busy} type="number" min="1" max="600" value={maxDurationSeconds} onChange={e => { setMaxDurationSeconds(e.target.value); setPreflight(null); }} /></label>
        <label className={styles.field}>单次模型输出 token 上限<input disabled={busy} type="number" min="1" value={maxOutputTokens} onChange={e => { setMaxOutputTokens(e.target.value); setPreflight(null); }} /></label>
        <label className={styles.field}>模型调用次数上限<input disabled={busy} type="number" min="1" max="1000" value={maxModelCalls} onChange={e => { setMaxModelCalls(e.target.value); setPreflight(null); }} /></label>
        <p>每次调用保守预留完整上下文窗口与输出上限；预算小于一次预留会被阻止。配置价格本地上限不等于供应商账单硬上限。</p>
        <p>失败处理：{template.failure}</p><ul>{template.acceptance.map(a => <li key={a}>{a}</li>)}</ul>
        <fieldset disabled={busy}><legend>手动模型能力体检</legend>{[['text', '文本'], ['tool', '工具调用'], ['structured', '原生结构化输出'], ['vision', '视觉']].map(([id, label]) => <label key={id}><input type="checkbox" checked={probeCapabilities.includes(id)} onChange={e => setProbeCapabilities(current => e.target.checked ? [...current, id] : current.filter(item => item !== id))} />{label}</label>)}
          {probeCapabilities.includes('vision') && <label><input type="checkbox" checked={confirmMediaPricing} onChange={e => setConfirmMediaPricing(e.target.checked)} />确认固定测试图片的费用按输入 token 估算；供应商账单可能不同</label>}
        </fieldset>
        <p>能力探测最多调用模型 {probeCapabilities.length} 次，单独使用上述 token/USD 预算，可能产生费用；不执行探测中的工具。结构化输出和视觉不支持时会明确显示原因。</p>
        <button type="button" disabled={busy || !probeCapabilities.length || (probeCapabilities.includes('vision') && !confirmMediaPricing)} onClick={() => void qualify()}>使用独立预算检测模型能力</button>
        {probeBudgetReason && <p>{probeBudgetReason}</p>}
        {!!probeResults.length && <ul aria-label="能力体检结果">{probeResults.map(result => <li key={result.capability}>{result.capability}：{result.status} · {result.code} · {result.suggestion}</li>)}</ul>}
        <button type="button" disabled={busy} onClick={() => void check()}>{busy ? '检查中…' : '检查输入并准备草稿'}</button>
        {preflight && <section aria-label="预检结果"><h3>预检结果</h3><p>当前配置模型：{preflight.modelId || '未配置'}</p><ul>{preflight.checks.map(c => <li key={c.id}>{c.label}：{c.state === 'pass' ? '通过' : c.state === 'fail' ? '未通过' : '尚未验证'}</li>)}</ul><p>{preflight.reason}</p>{preflight.qualificationEvidence && <p>{preflight.qualificationEvidence.reason}</p>}{preflight.budgetContract && <p>单次预留：{preflight.budgetContract.reservationTokens ?? '未知'} tokens / {preflight.budgetContract.reservationUsd ?? '未知'} USD。{preflight.budgetContract.reason} {preflight.budgetContract.note}</p>}<button type="button" disabled={busy || !preflight.executionAllowed || pendingLaunch.record?.state === 'unknown' || !!pendingLaunch.issue} onClick={() => void launch()}>确认预算并启动实验运行</button>{preflight.environment && <><p>{preflight.environment.directory.reason}</p><ul>{preflight.environment.tools.checks.map(t => <li key={t.name}>{t.name}：{t.state}{t.connection ? ` · MCP ${t.connection}` : ""}</li>)}</ul><p>{preflight.environment.tools.note}</p></>}{preflight.plan && <ol>{preflight.plan.steps.map(step => <li key={step.id}>{step.instruction}</li>)}</ol>}{preflight.diagnostics && <><p>模型配置输入：{preflight.diagnostics.model.inputModalities.join('、') || '未知'}；工具调用：{preflight.diagnostics.model.toolCalling}；结构化输出：尚未验证。</p><p>当前账本最近记录：{preflight.diagnostics.model.recentRecordedCalls} 次，成功 {preflight.diagnostics.model.recentSuccessfulCalls} 次，失败 {preflight.diagnostics.model.recentFailedCalls} 次。这不等于模板实测通过。</p><p>配置单价估算：{preflight.diagnostics.budget.estimateUsd === null ? '未知' : `${preflight.diagnostics.budget.estimateUsd} USD`}。{preflight.diagnostics.budget.note}</p></>}<label className={styles.field}>可复制的任务草稿<textarea readOnly rows={14} value={preflight.draft} /></label><button type="button" onClick={() => { requestInputDraft({ text: preflight.draft, mode: 'append', source: `template:${template.id}@${template.version}` }); close(); }}>填入聊天草稿，审核后发送</button><p>只追加到当前输入，不自动执行。发送后仍需先完成未通过的预检。</p></section>}
      </section>}
    </div>
  </section>;
}
