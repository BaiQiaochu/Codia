import { useEffect, useRef, useState } from 'react';
import type { CloudRecord } from './CloudRecords';
import {
  CLOUD_TASK_INPUT_COUNT, CLOUD_TASK_INPUT_LIMIT, CloudApiError, cloudOperationAvailable, cloudOperationLabel,
  cloudUtcDate, inspectCloudContent, isActiveCloudRun,
  type CloudFile, type CloudHealth, type CloudOperation, type CloudRun, type CloudSchedule,
  type CloudTaskPlan, type CloudTaskSession, type CloudWorkspaceClient,
} from './cloud-workspace-api';

type Input = { name: string; version: string; size: number; fileId: string };
type RequestIdentity = { fingerprint: string; key: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : '连接未完成，请重试。';
function requestKey(ref: { current: RequestIdentity | null }, payload: unknown): string {
  const fingerprint = JSON.stringify(payload);
  if (ref.current?.fingerprint !== fingerprint) ref.current = { fingerprint, key: crypto.randomUUID() };
  return ref.current!.key;
}
function localStart(): string {
  const date = new Date(Date.now() + 5 * 60_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
const scheduleState = (state: CloudSchedule['state']) => ({ enabled: '已启用', paused: '已暂停', completed: '已完成' })[state];

export interface CloudTasksProps {
  workspaceId: string; client: CloudWorkspaceClient; health: CloudHealth | null; files: CloudFile[]; runs?: CloudRun[];
  onRunCreated?: (run: CloudRun) => void; onSelectRun?: (runId: string) => void; onConfigureAI?: () => void;
  onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void;
}
/** A workspace key is an authority boundary: late reads/writes never populate another workspace. */
export function CloudTasks(props: CloudTasksProps) { return <CloudTasksEditor key={props.workspaceId} {...props} />; }
function CloudTasksEditor({ workspaceId, client, health, files, runs = [], onRunCreated, onSelectRun, onConfigureAI, onDirtyChange, onBusyChange }: CloudTasksProps) {
  const [plans, setPlans] = useState<CloudTaskPlan[]>([]);
  const [schedules, setSchedules] = useState<CloudSchedule[]>([]);
  const [workflows, setWorkflows] = useState<CloudRecord[]>([]);
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [inputs, setInputs] = useState<Input[]>([]);
  const [workflowVersion, setWorkflowVersion] = useState('');
  const [workflowPreview, setWorkflowPreview] = useState('');
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [inspecting, setInspecting] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('');
  const [scheduleName, setScheduleName] = useState('');
  const [scheduleOperation, setScheduleOperation] = useState<CloudOperation>('document-summary');
  const [scheduleInput, setScheduleInput] = useState<Input | null>(null);
  const [firstRun, setFirstRun] = useState(localStart);
  const [recurring, setRecurring] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [enable, setEnable] = useState(false);
  const [resumeId, setResumeId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [readError, setReadError] = useState('');
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  const revision = useRef(0);
  const busyRef = useRef(false);
  const inputController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const planRequest = useRef<RequestIdentity | null>(null);
  const scheduleRequest = useRef<RequestIdentity | null>(null);
  const runRequest = useRef<RequestIdentity | null>(null);
  const callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const aiAvailable = cloudOperationAvailable(health, 'agent-task');
  const scheduleAvailable = cloudOperationAvailable(health, scheduleOperation);
  const selected = plans.find(plan => plan.currentVersion === selectedPlan);
  const totalBytes = inputs.reduce((sum, input) => sum + input.size, 0) + new TextEncoder().encode(workflowVersion ? workflowPreview : instruction.trim()).byteLength;
  const firstRunAt = new Date(firstRun).getTime();
  const intervalMs = recurring ? Number(intervalMinutes) * 60_000 : null;
  const scheduleVersion = scheduleOperation === 'agent-task' ? selectedPlan : scheduleInput?.version || '';
  const dirty = !!(title || instruction || inputs.length || workflowVersion || scheduleName);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; inputController.current?.abort(); actionController.current?.abort(); callbacks.current.onBusyChange?.(false); callbacks.current.onDirtyChange?.(false); };
  }, []);
  useEffect(() => { callbacks.current.onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    const read = async () => {
      const readRevision = revision.current;
      try {
        const [planResult, scheduleResult, workflowResult] = await Promise.all([
          client.json<{ plans: CloudTaskPlan[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/task-plans`, { signal: controller.signal }),
          client.json<{ schedules: CloudSchedule[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/schedules`, { signal: controller.signal }),
          client.json<{ records: CloudRecord[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/records?kind=workflow`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted || readRevision !== revision.current || busyRef.current) return;
        setPlans(planResult.plans); setSchedules(scheduleResult.schedules); setWorkflows(workflowResult.records); setReadError('');
      } catch (err) { if (!controller.signal.aborted) setReadError(errorText(err)); }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void read(), 5000); } }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [workspaceId, client, reload]);

  useEffect(() => {
    setWorkflowPreview(''); setWorkflowLoading(false);
    if (!workflowVersion) return;
    const controller = new AbortController();
    setWorkflowLoading(true);
    client.content(workflowVersion, { signal: controller.signal }).then(response => inspectCloudContent(response))
      .then(value => {
        if (controller.signal.aborted) return;
        if (value.kind !== 'text') throw new Error('工作流版本不可读取，请重新选择。');
        const record = JSON.parse(value.text) as { kind?: string; data?: { instruction?: unknown } };
        if (record.kind !== 'workflow' || typeof record.data?.instruction !== 'string' || !record.data.instruction.trim()) throw new Error('此工作流尚未保存有效指令，请先在云端记录中补充。');
        setWorkflowPreview(record.data.instruction);
      }).catch(err => { if (!controller.signal.aborted) setError(errorText(err)); })
      .finally(() => { if (!controller.signal.aborted) setWorkflowLoading(false); });
    return () => controller.abort();
  }, [workflowVersion, client]);

  async function inspectInput(file: CloudFile, target: 'plan' | 'schedule') {
    if (busyRef.current) return;
    inputController.current?.abort();
    const controller = new AbortController(); inputController.current = controller;
    setInspecting(`${target}:${file.id}`); setError('');
    try {
      if (target === 'plan' && (inputs.length >= CLOUD_TASK_INPUT_COUNT || file.size + totalBytes > CLOUD_TASK_INPUT_LIMIT)) throw new Error('任务最多使用 8 份文本，连同指令合计不能超过 128 KiB。');
      const value = await client.content(file.current_version, { signal: controller.signal }).then(response => inspectCloudContent(response, CLOUD_TASK_INPUT_LIMIT));
      if (controller.signal.aborted || !alive.current) return;
      if (value.kind !== 'text') throw new Error('仅支持非空 UTF-8 文本；二进制或超过 128 KiB 的文件不能作为任务输入。');
      const size = new TextEncoder().encode(value.text).byteLength;
      if (size + (target === 'plan' ? totalBytes : 0) > CLOUD_TASK_INPUT_LIMIT) throw new Error('任务材料与指令合计不能超过 128 KiB。');
      const input = { fileId: file.id, name: file.name, version: file.current_version, size };
      if (target === 'plan') setInputs(current => [...current.filter(item => item.fileId !== file.id), input]);
      else setScheduleInput(input);
    } catch (err) { if (!controller.signal.aborted && alive.current) setError(errorText(err)); }
    finally { if (!controller.signal.aborted && alive.current) setInspecting(''); }
  }

  async function action(name: string, work: (signal: AbortSignal) => Promise<void>) {
    if (busyRef.current || inspecting) return;
    const controller = new AbortController(); actionController.current = controller;
    busyRef.current = true; revision.current += 1; setBusy(name); setError(''); setNotice(''); callbacks.current.onBusyChange?.(true);
    try { await work(controller.signal); }
    catch (err) { if (alive.current && !controller.signal.aborted) setError(errorText(err)); }
    finally { if (alive.current) { revision.current += 1; busyRef.current = false; setBusy(''); callbacks.current.onBusyChange?.(false); setReload(value => value + 1); } }
  }
  function createPlan(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !(workflowVersion ? workflowPreview : instruction.trim()) || workflowLoading || totalBytes > CLOUD_TASK_INPUT_LIMIT) return;
    const payload = { title: title.trim(), inputVersions: inputs.map(input => input.version), ...(workflowVersion ? { sourceWorkflowVersion: workflowVersion } : { instruction: instruction.trim() }) };
    void action('plan', async signal => {
      const result = await client.json<{ plan: CloudTaskPlan }>(`/workspaces/${encodeURIComponent(workspaceId)}/task-plans`, { method: 'POST', signal, body: JSON.stringify({ ...payload, requestKey: requestKey(planRequest, payload) }) });
      if (!alive.current || signal.aborted) return;
      planRequest.current = null; setPlans(current => [result.plan, ...current.filter(plan => plan.id !== result.plan.id)]); setSelectedPlan(result.plan.currentVersion);
      setTitle(''); setInstruction(''); setWorkflowVersion(''); setInputs([]); setNotice('任务计划已保存，输入版本已固定。保存不会调用模型。');
    });
  }
  function startPlan(plan: CloudTaskPlan) {
    if (!aiAvailable || runs.some(run => run.input_version === plan.currentVersion && isActiveCloudRun(run.status))) return;
    const payload = { inputVersion: plan.currentVersion, operation: 'agent-task' };
    void action(`run:${plan.id}`, async signal => {
      const result = await client.json<{ run: CloudRun }>(`/workspaces/${encodeURIComponent(workspaceId)}/runs`, { method: 'POST', signal, body: JSON.stringify({ ...payload, requestKey: requestKey(runRequest, payload) }) });
      if (!alive.current || signal.aborted) return;
      runRequest.current = null; onRunCreated?.(result.run); setNotice('Agent 任务已提交。运行记录中可查看进度、执行轨迹与产物。');
    });
  }
  function createSchedule(event: React.FormEvent) {
    event.preventDefault();
    if (!scheduleName.trim() || !scheduleVersion || (!Number.isSafeInteger(firstRunAt) || firstRunAt < 0 || firstRunAt > 253_370_678_399_999) || (recurring && (!Number.isSafeInteger(intervalMs) || intervalMs! < 60_000 || intervalMs! > 366 * 24 * 60 * 60_000)) || (enable && !scheduleAvailable)) return;
    const payload = { name: scheduleName.trim(), inputVersion: scheduleVersion, operation: scheduleOperation, firstRunAt, intervalMs, enabled: enable };
    void action('schedule', async signal => {
      const result = await client.json<{ schedule: CloudSchedule }>(`/workspaces/${encodeURIComponent(workspaceId)}/schedules`, { method: 'POST', signal, body: JSON.stringify({ ...payload, requestKey: requestKey(scheduleRequest, payload) }) });
      if (!alive.current || signal.aborted) return;
      scheduleRequest.current = null; setSchedules(current => [result.schedule, ...current.filter(schedule => schedule.id !== result.schedule.id)]); setScheduleName(''); setEnable(false);
      setNotice(result.schedule.state === 'enabled' ? '定时任务已启用，将使用固定版本运行。' : '定时任务已保存为暂停状态。启用后才会执行。');
    });
  }
  function toggleSchedule(schedule: CloudSchedule, enabled: boolean) {
    if (enabled && !cloudOperationAvailable(health, schedule.operation)) return;
    void action(`schedule:${schedule.id}`, async signal => {
      try {
        const result = await client.json<{ schedule: CloudSchedule }>(`/schedules/${encodeURIComponent(schedule.id)}`, { method: 'PUT', signal, body: JSON.stringify({ expectedRevision: schedule.revision, enabled }) });
        if (!alive.current || signal.aborted) return;
        setSchedules(current => current.map(item => item.id === result.schedule.id ? result.schedule : item)); setResumeId('');
        setNotice(enabled ? '定时任务已启用。' : '定时任务已暂停。已经提交的运行需单独取消。');
      } catch (err) {
        if (err instanceof CloudApiError && err.status === 409 && alive.current && !signal.aborted) { setResumeId(''); }
        throw err;
      }
    });
  }
  const locked = !!busy || !!inspecting;
  const sourceWorkflow = workflows.find(workflow => workflow.currentVersion === workflowVersion);
  return <section className="cw-card cw-cloud-tasks" aria-labelledby="cw-cloud-tasks-title" data-testid="cloud-tasks">
    <div className="cw-card-heading"><div><span className="cw-step">04</span><h2 id="cw-cloud-tasks-title">云端任务与定时</h2></div><button type="button" className="cw-record-action" disabled={!!busy} onClick={() => setReload(value => value + 1)}>刷新任务列表</button></div>
    <p className="cw-record-description">把目标和材料保存为不可修改的计划，再按需执行或定时运行。每次运行固定输入版本，可追溯、可取消。</p>
    <div className="cw-task-notices">
      {(error || readError) && <div className="cw-alert cw-alert-error" role="alert"><span>{error || readError} 草稿未丢失；连接恢复后可重新读取并重试。</span><button type="button" className="cw-record-action" disabled={!!busy} onClick={() => { setError(''); setReload(value => value + 1); }}>重新读取列表</button></div>}
      {notice && <p className="cw-record-success" role="status">{notice}</p>}
      {!aiAvailable && <p className="cw-ai-unavailable" role="status">尚未配置可用的任务模型。可以先保存计划；AI 执行和启用不可用，无需 AI 的文档定时仍可使用。{onConfigureAI && <button type="button" className="cw-record-action" onClick={onConfigureAI}>配置任务模型</button>}</p>}
    </div>
    <div className="cw-task-grid">
      <form className="cw-task-panel" onSubmit={createPlan} aria-label="新建任务计划">
        <h3>1. 保存任务计划</h3>
        <label htmlFor="cloud-plan-title">任务名称</label><input id="cloud-plan-title" maxLength={80} value={title} onChange={event => setTitle(event.target.value)} disabled={locked} placeholder="例如：整理调研结论" />
        <label htmlFor="cloud-task-workflow">使用已保存的工作流</label><select id="cloud-task-workflow" className="cw-select" value={workflowVersion} disabled={locked} onChange={event => { setWorkflowVersion(event.target.value); setError(''); }}><option value="">手动填写指令</option>{workflowVersion && !sourceWorkflow && <option value={workflowVersion}>已选固定版本 · {workflowVersion}</option>}{workflows.map(workflow => <option value={workflow.currentVersion} key={workflow.id}>{workflow.title} · {workflow.currentVersion}</option>)}</select>
        {workflowVersion ? <div className="cw-task-pinned"><span>工作流固定版本：{workflowVersion}</span><pre aria-label="工作流指令预览">{workflowLoading ? '正在读取所选版本…' : workflowPreview || '此版本没有可用指令'}</pre><small>仅使用这个已保存版本；之后的工作流编辑不会改变计划。</small></div> : <><label htmlFor="cloud-task-instruction">任务指令</label><textarea id="cloud-task-instruction" maxLength={16000} value={instruction} disabled={locked} onChange={event => setInstruction(event.target.value)} placeholder="说明目标、需要核对的内容，以及要生成的文本成果" /></>}
        <fieldset disabled={locked} className="cw-task-inputs"><legend>材料与指令 · {inputs.length}/{CLOUD_TASK_INPUT_COUNT} 份 · {(totalBytes / 1024).toFixed(1)} / 128 KiB</legend>
          <label htmlFor="cloud-task-add-input">添加当前工作空间文件</label><select className="cw-select" id="cloud-task-add-input" value="" onChange={event => { const file = files.find(item => item.id === event.target.value); if (file) void inspectInput(file, 'plan'); }}><option value="">选择已保存的文本文件…</option>{files.filter(file => !inputs.some(input => input.fileId === file.id)).map(file => <option value={file.id} key={file.id} disabled={file.size + totalBytes > CLOUD_TASK_INPUT_LIMIT || inputs.length >= CLOUD_TASK_INPUT_COUNT}>{file.name} · {file.current_version.slice(0, 12)}</option>)}</select>
          {inputs.map(input => <div className="cw-task-input-row" key={input.version}><div><strong>{input.name}</strong><small>固定版本 {input.version}</small></div><button type="button" className="cw-record-action" aria-label={`移除 ${input.name}`} onClick={() => setInputs(current => current.filter(item => item.version !== input.version))}>移除</button></div>)}
          {inspecting.startsWith('plan:') && <p role="status">正在验证 UTF-8 文本…</p>}
        </fieldset>
        <p className="cw-helper">指令与最多 8 份文本合计 128 KiB。只开放列出云文件、读取已选材料、创建文本产物。没有 shell、网络或宿主机工具。运行时指令与所选文本会发送给配置的模型服务商，可能产生费用。</p>
        <button type="submit" className="cw-button cw-button-primary cw-full-width" disabled={locked || !title.trim() || !(workflowVersion ? workflowPreview : instruction.trim()) || workflowLoading || totalBytes > CLOUD_TASK_INPUT_LIMIT}>{busy === 'plan' ? '正在保存计划…' : '保存任务计划'}</button>
      </form>
      <div className="cw-task-panel">
        <h3>2. 选择固定计划</h3><p className="cw-helper">计划保存后不可编辑；修改目标或输入时，请另建计划。</p>
        {loading && !plans.length ? <p role="status">正在读取任务计划…</p> : !plans.length ? <p className="cw-empty-small">还没有任务计划。<br />保存后会出现在这里。</p> : <div className="cw-plan-list">{plans.map(plan => <div className={`cw-plan-item${selectedPlan === plan.currentVersion ? ' cw-plan-selected' : ''}`} key={plan.id}>
          <button type="button" className="cw-plan-select" aria-label={plan.title} aria-pressed={selectedPlan === plan.currentVersion} disabled={locked} onClick={() => setSelectedPlan(plan.currentVersion)}><strong>{plan.title}</strong><span>{plan.inputVersions.length} 份固定材料 · {cloudUtcDate(plan.createdAt)}</span></button>
          <details><summary>查看指令与固定版本</summary><pre>{plan.instruction}</pre><small>计划版本 {plan.currentVersion}</small>{plan.sourceWorkflowVersion && <small>工作流版本 {plan.sourceWorkflowVersion}</small>}{plan.inputVersions.map(version => <small key={version}>输入版本 {version}</small>)}</details>
          <button type="button" className="cw-button cw-button-ghost cw-full-width" disabled={locked || !aiAvailable || runs.some(run => run.input_version === plan.currentVersion && isActiveCloudRun(run.status))} onClick={() => startPlan(plan)}>{busy === `run:${plan.id}` ? '正在提交任务…' : runs.some(run => run.input_version === plan.currentVersion && isActiveCloudRun(run.status)) ? '此计划正在运行' : `执行 ${plan.title}`}</button>
        </div>)}</div>}
      </div>
      <form className="cw-task-panel" onSubmit={createSchedule} aria-label="新建定时任务">
        <h3>3. 设置运行时间</h3>
        <label htmlFor="cloud-schedule-name">定时任务名称</label><input id="cloud-schedule-name" maxLength={80} value={scheduleName} disabled={locked} onChange={event => setScheduleName(event.target.value)} placeholder="例如：每日上午检查" />
        <label htmlFor="cloud-schedule-operation">定时处理方式</label><select id="cloud-schedule-operation" className="cw-select" disabled={locked} value={scheduleOperation} onChange={event => { setScheduleOperation(event.target.value as CloudOperation); setEnable(false); }}><option value="document-summary">文档检查与摘要（无需 AI）</option><option value="agent-task">云端 Agent 任务</option></select>
        {scheduleOperation === 'agent-task' ? <div className="cw-task-pinned"><span>{selected ? `已选：${selected.title}` : '请先在左侧选择一个已保存的计划'}</span>{selected && <small>计划版本 {selected.currentVersion}</small>}</div> : <><label htmlFor="cloud-schedule-input">定时输入文件</label><select id="cloud-schedule-input" className="cw-select" disabled={locked} value={scheduleInput?.fileId || ''} onChange={event => { setScheduleInput(null); const file = files.find(item => item.id === event.target.value); if (file) void inspectInput(file, 'schedule'); }}><option value="">选择已保存的文本文件…</option>{files.map(file => <option key={file.id} value={file.id} disabled={file.size > CLOUD_TASK_INPUT_LIMIT}>{file.name}</option>)}</select>{scheduleInput && <p className="cw-task-pinned">固定版本 {scheduleInput.version}</p>}{inspecting.startsWith('schedule:') && <p role="status">正在验证定时输入…</p>}</>}
        <label htmlFor="cloud-schedule-first">首次运行（本机时间）</label><input id="cloud-schedule-first" type="datetime-local" step="60" value={firstRun} disabled={locked} onChange={event => setFirstRun(event.target.value)} /><p className="cw-helper">按本机时区换算，服务端使用 UTC：<time data-testid="schedule-utc-preview">{Number.isFinite(firstRunAt) ? cloudUtcDate(firstRunAt) : '请选择有效时间'}</time></p>
        <label htmlFor="cloud-schedule-repeat">运行频率</label><select id="cloud-schedule-repeat" className="cw-select" value={recurring ? 'interval' : 'once'} disabled={locked} onChange={event => setRecurring(event.target.value === 'interval')}><option value="once">仅一次</option><option value="interval">按固定间隔</option></select>
        {recurring && <><label htmlFor="cloud-schedule-minutes">运行间隔（分钟）</label><input id="cloud-schedule-minutes" type="number" min="1" max="527040" step="1" value={intervalMinutes} disabled={locked} onChange={event => setIntervalMinutes(event.target.value)} /></>}
        <label className="cw-task-check"><input type="checkbox" checked={enable} disabled={locked || !scheduleAvailable} onChange={event => setEnable(event.target.checked)} />创建后立即启用</label>
        <p className="cw-helper">默认暂停。定时始终使用这里的固定版本，不自动追踪文件更新。服务恢复后会合并错过的触发；前一次仍在运行时跳过本次。{scheduleOperation === 'agent-task' && ' 启用 AI 定时会发送指令与材料给模型服务商；循环执行及崩溃重试都可能重复调用并计费。'}</p>
        <button type="submit" className="cw-button cw-button-primary cw-full-width" disabled={locked || !scheduleName.trim() || !scheduleVersion || (!Number.isSafeInteger(firstRunAt) || firstRunAt < 0 || firstRunAt > 253_370_678_399_999) || (recurring && (!Number.isSafeInteger(intervalMs) || intervalMs! < 60_000 || intervalMs! > 366 * 24 * 60 * 60_000)) || (enable && !scheduleAvailable)}>{busy === 'schedule' ? '正在保存定时…' : enable ? '保存并启用定时' : '保存为暂停定时'}</button>
      </form>
    </div>
    <div className="cw-schedules"><h3>已保存的定时任务 <span>{schedules.length}</span></h3>{loading && !schedules.length ? <p role="status">正在读取定时任务…</p> : !schedules.length ? <p className="cw-empty-small">还没有定时任务。可先保存为暂停状态，核对后再启用。</p> : schedules.map(schedule => <article key={schedule.id} className="cw-schedule-item" aria-label={`定时 ${schedule.name}`}>
      <div><strong>{schedule.name}</strong><span className={`cw-schedule-state cw-schedule-${schedule.state}`}>{scheduleState(schedule.state)}</span><p>{cloudOperationLabel(schedule.operation)} · {schedule.interval_ms === null ? '仅一次' : `每 ${schedule.interval_ms / 60_000} 分钟`}</p><time>{schedule.state === 'completed' ? '计划时间' : '下次运行'} UTC：{cloudUtcDate(schedule.next_run_at)}</time><small>固定版本 {schedule.input_version} · 修订 {schedule.revision}</small></div>
      <div className="cw-schedule-actions">{schedule.last_run_id && <button type="button" className="cw-record-action" onClick={() => onSelectRun?.(schedule.last_run_id!)}>查看最近运行</button>}{schedule.state !== 'completed' && <button type="button" className="cw-record-action" disabled={locked || (schedule.state === 'paused' && !cloudOperationAvailable(health, schedule.operation))} onClick={() => schedule.state === 'enabled' ? toggleSchedule(schedule, false) : setResumeId(schedule.id)}>{schedule.state === 'enabled' ? '暂停定时' : '启用定时'}</button>}</div>
      {resumeId === schedule.id && <div className="cw-schedule-confirm" role="group" aria-label="确认启用定时"><p>{schedule.operation.startsWith('agent-') ? '启用后会将固定指令与材料发送给配置的模型服务商；循环及崩溃重试可能重复调用、重复计费。' : '启用后会按 UTC 计划执行文档检查，无需调用模型。'} 若计划时间已过，恢复时将合并触发一次。已在运行的任务不会重复排队。</p><button type="button" className="cw-record-action" disabled={locked} onClick={() => toggleSchedule(schedule, true)}>确认启用</button><button type="button" className="cw-record-action" disabled={locked} onClick={() => setResumeId('')}>返回</button></div>}
    </article>)}</div>
  </section>;
}

/** Task traces contain display text only; provider/tool output is never rendered as HTML. */
export function CloudTaskRunDetail({ run, client, onRunUpdated }: { run: CloudRun; client: CloudWorkspaceClient; onRunUpdated?: (run: CloudRun) => void }) {
  return <CloudTaskRunDetailBody key={run.id} run={run} client={client} onRunUpdated={onRunUpdated} />;
}
function CloudTaskRunDetailBody({ run, client, onRunUpdated }: { run: CloudRun; client: CloudWorkspaceClient; onRunUpdated?: (run: CloudRun) => void }) {
  const [session, setSession] = useState<CloudTaskSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const mutationController = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; mutationController.current?.abort(); }; }, []);
  useEffect(() => {
    setSession(null); setError('');
    if (run.operation !== 'agent-task' || run.status !== 'succeeded') return;
    const controller = new AbortController(); setLoading(true);
    client.json<{ session: CloudTaskSession }>(`/runs/${encodeURIComponent(run.id)}/task-session`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setSession(result.session); })
      .catch(err => { if (!controller.signal.aborted) setError(errorText(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [run.id, run.status, run.operation, client, reload]);
  async function cancel() {
    if (busyRef.current || !isActiveCloudRun(run.status)) return;
    const controller = new AbortController(); mutationController.current = controller;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = await client.json<{ run: CloudRun }>(`/runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST', signal: controller.signal, body: '{}' });
      if (alive.current && !controller.signal.aborted) onRunUpdated?.(result.run);
    } catch (err) { if (alive.current && !controller.signal.aborted) setError(errorText(err)); }
    finally { if (alive.current) { busyRef.current = false; setBusy(false); } }
  }
  return <div className="cw-task-result" data-testid="task-run-detail">
    {isActiveCloudRun(run.status) && <><button type="button" className="cw-record-action" disabled={busy} onClick={() => void cancel()}>{busy ? '正在取消…' : '取消此运行'}</button><p className="cw-helper">取消不会删除记录；已发出的模型请求仍可能计费。定时任务需另外暂停。</p></>}
    {run.error === 'cancelled' && <p className="cw-record-success" role="status">此运行已取消。</p>}
    {error && <div className="cw-alert cw-alert-error" role="alert"><span>{error}</span>{run.status === 'succeeded' && <button type="button" className="cw-record-action" onClick={() => setReload(value => value + 1)}>重试读取结果</button>}</div>}
    {loading && <p role="status">正在读取 Agent 会话…</p>}
    {session && <><h3>任务结果</h3><pre data-testid="task-final-text">{session.finalText || '任务已完成，没有额外回复。'}</pre><p className="cw-helper">执行尝试 {session.attempt} · {session.inputVersions.length} 份固定输入{session.inputVersion && <><br />计划版本 {session.inputVersion}</>}{session.sourceWorkflowVersion && <><br />工作流版本 {session.sourceWorkflowVersion}</>}</p>
      <details><summary>查看会话与工具轨迹（{session.messages.length}）</summary><ol className="cw-session-messages">{session.messages.map((message, index) => <li key={`${message.toolCallId || message.role}:${index}`}><strong>{message.toolName || message.role}{message.isError ? ' · 工具错误' : ''}</strong>{message.text && <pre>{message.text}</pre>}</li>)}</ol></details>
      <h3>任务产物 · {session.artifacts.length}</h3>{session.artifacts.map(artifact => <details className="cw-session-artifact" key={artifact.id}><summary>{artifact.name} · {artifact.size} B</summary><small>SHA-256 {artifact.sha256}</small><pre>{artifact.content}</pre><CloudTaskTextDownload artifact={artifact} /></details>)}{!session.artifacts.length && <p className="cw-helper">此次任务没有创建独立文本产物，完整会话仍已保存。</p>}
    </>}
  </div>;
}

function CloudTaskTextDownload({ artifact }: { artifact: CloudTaskSession['artifacts'][number] }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return;
    const next = URL.createObjectURL(new Blob([artifact.content], { type: 'text/plain;charset=utf-8' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [artifact.content]);
  return url ? <a className="cw-text-link" href={url} download={artifact.name.endsWith('.txt') ? artifact.name : `${artifact.name}.txt`}>下载此文本产物</a> : null;
}
