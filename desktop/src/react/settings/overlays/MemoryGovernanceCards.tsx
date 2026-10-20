import React, { useState } from 'react';
import type { ExperienceItem, ExperienceState, MemoryItem, MemoryProject, RecordedMemoryRun } from '../memory-api';
import styles from '../Settings.module.css';
import { MemoryProjectSelect, MemoryRunPicker } from './MemoryRunPicker';
import v2 from './MemoryGovernanceV2.module.css';
import { MemoryMessageEvidence } from './MemoryMessageEvidence';

const states: Record<string, string> = { active: '有效', candidate: '候选', conflict: '有冲突', superseded: '已替代', expired: '已过期', deleted: '已遗忘', validated: '已验证', enabled: '已启用', withdrawn: '已撤回' };
export const stateLabel = (state: string) => states[state] || state;
export const readableTime = (value?: string | null) => value ? new Date(value).toLocaleString() : '未记录';
const actionsClass = styles['memory-governance-actions'];
const buttonClass = styles['memory-action-btn'];

function dateInput(value?: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function MemoryFactCard({ memory, busy, onUpdate, onForget, onOpenSource, projects = [], agentId }: {
  memory: MemoryItem;
  agentId: string;
  projects?: MemoryProject[];
  busy: boolean;
  onUpdate: (memory: MemoryItem, patch: Record<string, unknown>) => Promise<boolean>;
  onForget: (memory: MemoryItem) => Promise<boolean>;
  onOpenSource: (sessionId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [projectId, setProjectId] = useState('');
  const [expires, setExpires] = useState('');
  const expired = !!memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now();
  const sourceSessions = [...new Set([
    ...(memory.sourceRefs || []).map(ref => ref.sessionId),
    memory.source?.startsWith('session:') ? memory.source.slice(8) : undefined,
  ].filter((id): id is string => !!id))];
  const edit = () => {
    setDraft(memory.fact); setScope(memory.scope || 'global'); setProjectId(memory.projectId || '');
    setExpires(dateInput(memory.expiresAt)); setEditing(true); setForgetting(false);
  };
  const save = async () => {
    const patch: Record<string, unknown> = { fact: draft.trim(), status: 'active' };
    if (scope !== (memory.scope || 'global') || projectId !== (memory.projectId || '')) {
      patch.scope = scope; patch.projectId = scope === 'project' ? projectId.trim() : null;
    }
    if (expires !== dateInput(memory.expiresAt)) patch.expiresAt = expires ? new Date(expires).toISOString() : null;
    if (await onUpdate(memory, patch)) setEditing(false);
  };
  return <section className={styles['memory-governance-card']} aria-label={`记忆 ${memory.id}`}>
    <div className={styles['memory-governance-card-heading']}>
      <span className={styles['memory-governance-badge']}>{stateLabel(expired ? 'expired' : memory.status)}</span>
      <span>#{memory.id} · 版本 {memory.revision ?? '旧版'}</span>
    </div>
    <p className={styles['memory-governance-content']}>{memory.fact}</p>
    <p className={styles['memory-governance-meta']}>范围：{memory.scope === 'project' ? `项目 ${memory.projectId || '未设置'}` : '此助手的全局记忆'}{memory.session_id?.startsWith('channel-') ? ` · 频道 ${memory.session_id.slice(8)}` : ''}</p>
    {memory.reviewStatus && <p className={styles['memory-governance-meta']}>核实状态：{memory.reviewStatus === 'user_confirmed' ? '用户已确认' : '尚未人工核实'}</p>}
    <p className={styles['memory-governance-meta']}>有效期：{memory.expiresAt ? readableTime(memory.expiresAt) : '未设到期时间'} · 更新：{readableTime(memory.updated_at || memory.created_at)}</p>
    {memory.lastVerifiedAt && <p className={styles['memory-governance-meta']}>最近核实：{readableTime(memory.lastVerifiedAt)}</p>}
    {memory.tags?.length ? <p className={styles['memory-governance-meta']}>{memory.tags.join(' · ')}</p> : null}
    <details className={styles['memory-governance-details']}>
      <summary>查看来源（{memory.sourceRefs?.length || (memory.source ? 1 : 0)}）</summary>
      <p>来源：{memory.source || '未记录完整来源，使用前请核实。'}</p>
      {(memory.sourceRefs || []).map((ref, index) => <div key={index} className={styles['memory-governance-source']}>
        <span>{ref.kind} {ref.sessionId && `· 会话 ${ref.sessionId}`} {ref.messageId && `· 消息 ${ref.messageId}`} {ref.runId && `· 运行 ${ref.runId}`}</span>
        <span>{ref.author && `作者：${ref.author}`} {ref.revision && `来源版本：${ref.revision}`}</span>
        {ref.evidenceHash && <span>证据校验：{ref.evidenceHash}</span>}
      </div>)}
      <MemoryMessageEvidence agentId={agentId} memoryId={memory.id} version={memory.revision ?? memory.updated_at} disabled={busy} />
    </details>
    {sourceSessions.map(sessionId => <button type="button" key={sessionId} className={buttonClass} disabled={busy} onClick={() => onOpenSource(sessionId)}>打开来源会话{sourceSessions.length > 1 ? ` ${sessionId}` : ''}</button>)}
    {memory.status !== 'active' || expired ? <p className={styles['memory-governance-meta']}>此条当前不用于可信事实检索；请核对来源、范围及有效期。</p> : null}
    {editing ? <div className={styles['memory-governance-form']}>
      <label>纠正事实<textarea aria-label="纠正事实" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} /></label>
      <div className={styles['memory-governance-fields']}>
        <label>适用范围<select aria-label="适用范围" disabled={busy} value={scope} onChange={event => setScope(event.target.value as 'global' | 'project')}><option value="global">此助手全局</option><option value="project">指定项目</option></select></label>
        {scope === 'project' && <MemoryProjectSelect label="项目标识" value={projectId} projects={projects} disabled={busy} onChange={setProjectId} />}
        <label>到期时间<input aria-label="到期时间" type="datetime-local" disabled={busy} value={expires} onChange={event => setExpires(event.target.value)} /></label>
      </div>
      <p className={styles['memory-governance-meta']}>保存后旧事实和派生缓存会失效；当前编辑内容会保留到保存成功或取消。</p>
      <div className={actionsClass}>
        <button type="button" className={buttonClass} disabled={busy || !draft.trim() || (scope === 'project' && !projectId.trim())} onClick={() => void save()}>保存纠错</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => setEditing(false)}>取消纠错</button>
      </div>
    </div> : <div className={actionsClass}>
      <button type="button" className={buttonClass} disabled={busy} onClick={edit}>纠错</button>
      {(memory.status === 'candidate' || memory.reviewStatus === 'unverified') && <button type="button" className={buttonClass} disabled={busy} onClick={() => void onUpdate(memory, { status: 'active' })}>确认有效</button>}
      <button type="button" className={buttonClass} disabled={busy} onClick={() => { if (expired) edit(); else void onUpdate(memory, { status: memory.status === 'expired' ? 'active' : 'expired' }); }}>{expired ? '调整有效期' : memory.status === 'expired' ? '恢复有效' : '标记过期'}</button>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void onUpdate(memory, { status: memory.status === 'conflict' ? 'active' : 'conflict' })}>{memory.status === 'conflict' ? '确认无冲突' : '标记冲突'}</button>
      <button type="button" className={`${buttonClass} ${styles.danger}`} disabled={busy} onClick={() => setForgetting(true)}>忘记</button>
    </div>}
    {forgetting && <div className={styles['memory-governance-confirm']}>
      <p>忘记此事实并阻止已记录来源的旧内容被自动重新提取。原始聊天仍会保留；备份不会立即物理删除。</p>
      <div className={actionsClass}>
        <button type="button" className={`${buttonClass} ${styles.danger}`} disabled={busy} onClick={() => void onForget(memory)}>确认忘记</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => setForgetting(false)}>取消忘记</button>
      </div>
    </div>}
  </section>;
}

function parseDependencies(value: string): Record<string, string> | null {
  const lines = value.split('\n').map(line => line.trim()).filter(Boolean);
  const entries: [string, string][] = [];
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 1 || !line.slice(separator + 1).trim()) return null;
    const name = line.slice(0, separator).trim();
    if (entries.some(([key]) => key === name)) return null;
    entries.push([name, line.slice(separator + 1).trim()]);
  }
  return Object.fromEntries(entries);
}

export function ExperienceCard({ entry, busy, onTransition, onReview, onRevise, onAttempt, agentId, projects = [] }: {
  entry: ExperienceItem;
  agentId: string;
  projects?: MemoryProject[];
  onAttempt: (entry: ExperienceItem, runId: string) => Promise<boolean>;
  busy: boolean;
  onTransition: (entry: ExperienceItem, state: ExperienceState) => Promise<boolean>;
  onReview: (entry: ExperienceItem, review: Record<string, unknown>) => Promise<boolean>;
  onRevise: (entry: ExperienceItem, patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [evidenceOrigin, setEvidenceOrigin] = useState<'recorded_run' | 'external_manual'>('recorded_run');
  const [selectedRun, setSelectedRun] = useState<RecordedMemoryRun | null>(null);
  const [adoptedKey, setAdoptedKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState('');
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [confirmation, setConfirmation] = useState<ExperienceState | null>(null);
  const [runId, setRunId] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [summary, setSummary] = useState('');
  const [platform, setPlatform] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [projectId, setProjectId] = useState('');
  const [channel, setChannel] = useState('');
  const [dependencies, setDependencies] = useState('');
  const parsedDependencies = parseDependencies(dependencies);
  const [outcome, setOutcome] = useState('unknown');
  const [approvedKey, setApprovedKey] = useState<string | null>(null);
  const [eventId, setEventId] = useState('');
  // Approval is valid for one identity/revision and the exact reviewed evidence only.
  // Derive it during render: a passive effect would leave an unsafe new-revision commit.
  const reviewDraft = evidenceOrigin === 'recorded_run'
    ? { evidenceOrigin, runId: selectedRun?.runId, eventId, summary: summary.trim(), outcome }
    : { evidenceOrigin, runId: runId.trim(), eventId, evidenceRef: evidenceRef.trim(), summary: summary.trim(), outcome,
      environment: { projectId: projectId.trim() || null, platform: platform.trim(), appVersion: appVersion.trim() || null, channel: channel.trim() || null, dependencyVersions: parsedDependencies || {} } };
  const approvalKey = JSON.stringify([entry.id, entry.revision, reviewDraft, evidenceOrigin === 'recorded_run' ? selectedRun : null]);
  const confirmed = approvedKey === approvalKey;
  const evidenceReady = evidenceOrigin === 'recorded_run' ? !!selectedRun && selectedRun.environmentProvenance === 'recorded' : !!parsedDependencies && !!runId.trim() && !!evidenceRef.trim() && !!platform.trim();
  // Feedback bumps revision without changing the content that was actually adopted.
  const adoptionKey = selectedRun ? JSON.stringify([entry.id, entry.contentRevision ?? entry.revision, selectedRun.runId]) : null;
  const adopted = adoptionKey !== null && adoptedKey === adoptionKey;
  const startEdit = () => {
    setEditing(true); setReviewing(false); setContent(entry.content); setScope(entry.applicability.scope);
    setPlatform(entry.applicability.platform || ''); setAppVersion(entry.applicability.appVersion || ''); setProjectId(entry.applicability.projectId || '');
    setChannel(entry.applicability.channel || ''); setDependencies(Object.entries(entry.applicability.dependencyVersions || {}).map(([key, value]) => `${key}=${value}`).join('\n'));
  };
  const saveEdit = async () => {
    if (await onRevise(entry, { content: content.trim(), applicability: { ...entry.applicability, scope,
      projectId: scope === 'project' ? projectId.trim() : null, platform: platform.trim() || null, appVersion: appVersion.trim() || null, channel: channel.trim() || null, dependencyVersions: parsedDependencies || {} } })) setEditing(false);
  };
  const startReview = () => {
    setReviewing(true); setEditing(false); setEvidenceOrigin('recorded_run'); setSelectedRun(null); setAdoptedKey(null); setRunId(''); setEvidenceRef(''); setSummary(''); setOutcome('unknown'); setApprovedKey(null);
    setPlatform(entry.applicability.platform || ''); setAppVersion(entry.applicability.appVersion || ''); setProjectId(entry.applicability.projectId || '');
    setChannel(entry.applicability.channel || ''); setDependencies(Object.entries(entry.applicability.dependencyVersions || {}).map(([key, value]) => `${key}=${value}`).join('\n'));
    setEventId(globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  };
  const saveReview = async () => {
    if (busy || !confirmed || !evidenceReady || !summary.trim()) return;
    if (await onReview(entry, { ...reviewDraft, confirmed: true })) setReviewing(false);
  };
  return <section className={styles['memory-governance-card']} aria-label={`经验 ${entry.id}`}>
    <div className={styles['memory-governance-card-heading']}><span className={styles['memory-governance-badge']}>{stateLabel(entry.state)}</span><span>{entry.category} · 版本 {entry.revision}</span></div>
    <p className={styles['memory-governance-content']}>{entry.content}</p>
    <p className={styles['memory-governance-meta']}>范围：{entry.applicability.scope === 'project' ? `项目 ${entry.applicability.projectId || '未设置'}` : '此助手全局'} · 环境：{entry.applicability.platform || '未记录'} {entry.applicability.appVersion || ''}{entry.applicability.channel ? ` · 频道 ${entry.applicability.channel}` : ''}</p>
    <div className={styles['memory-governance-stats']} aria-label="经验反馈计数">
      <span>检索 {entry.stats.retrieved}</span><span>注入 {entry.stats.injected}</span><span>采用 {entry.stats.attempted}</span>
      <span>核实成功 {entry.stats.verifiedSuccess}</span><span>核实失败 {entry.stats.verifiedFailure}</span><span>结果未知 {entry.stats.unknown}</span>
    </div>
    <p className={styles['memory-governance-meta']}>最近核实：{readableTime(entry.lastVerifiedAt)}。计数为历次版本的关联结果，不代表因果贡献；改版后的证据需重新核实。</p>
    <details className={styles['memory-governance-details']}>
      <summary>查看条件、来源与运行证据（{entry.evidence.length}）</summary>
      <p>任务：{entry.taskType || '未记录'} · 目标：{entry.goal || '未记录'}</p>
      <p>适用前提：{entry.preconditions.join('；') || '未记录'}</p>
      <p>操作摘要：{entry.actions.join('；') || '未记录'}</p>
      <p>验证方式：{entry.verificationMethod || '未记录'}</p>
      <p>风险：{entry.risks.join('；') || '未记录'} · 回退：{entry.rollback || '未记录'}</p>
      <p>依赖版本：{Object.entries(entry.applicability.dependencyVersions || {}).map(([key, value]) => `${key}=${value}`).join(' · ') || '未记录'}</p>
      {entry.sourceRefs.length === 0 && <p>缺少原始来源，不能据此当作已验证经验。</p>}
      {entry.sourceRefs.map((ref, i) => <p key={i}>来源：{ref.type} · {ref.id}{ref.author ? ` · 作者 ${ref.author}` : ''}{ref.revision ? ` · 版本 ${ref.revision}` : ''}{ref.excerpt ? ` · ${ref.excerpt}` : ''}</p>)}
      {entry.evidence.map(evidence => <div key={evidence.id} className={styles['memory-governance-source']}>
        <strong>{evidence.contentRevision && entry.contentRevision && evidence.contentRevision !== entry.contentRevision ? '历史版本证据 · ' : ''}运行 {evidence.runId} · {evidence.outcome === 'success' ? '成功' : evidence.outcome === 'failure' ? '失败' : '未知'}</strong>
        <span>{evidence.evidenceOrigin === 'recorded_run' ? '已记录运行证据 · 人工核实' : '外部人工证据 · 人工提供，未自动解析'}</span><span>{evidence.summary}</span><span>证据：{evidence.evidenceRef}</span>
        <span>环境：{evidence.environment.platform || '未记录'} {evidence.environment.appVersion || ''} · 项目 {evidence.environment.projectId || '未记录'}</span>
        <span>依赖：{Object.entries(evidence.environment.dependencyVersions || {}).map(([key, value]) => `${key}=${value}`).join(' · ') || '未记录'} · 核实者：{evidence.reviewerId} · {readableTime(evidence.verifiedAt)} · 使用版本 {evidence.experienceRevision}</span>
      </div>)}
    </details>
    {entry.withdrawalReason && <p className={styles['memory-governance-meta']}>撤回原因：{entry.withdrawalReason}</p>}
    <div className={actionsClass}>
      {entry.state !== 'withdrawn' && <button type="button" className={buttonClass} disabled={busy || reviewing || editing} onClick={startReview}>记录核实结果</button>}
      {entry.state !== 'withdrawn' && <button type="button" className={buttonClass} disabled={busy || editing || reviewing} onClick={startEdit}>纠正内容与范围</button>}
      {entry.state === 'candidate' && <button type="button" className={buttonClass} disabled={busy} onClick={() => void onTransition(entry, 'validated')}>验证候选</button>}
      {entry.state === 'validated' && <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirmation('enabled')}>启用经验</button>}
      {entry.state !== 'withdrawn' && <button type="button" className={`${buttonClass} ${styles.danger}`} disabled={busy} onClick={() => setConfirmation('withdrawn')}>撤回经验</button>}
    </div>
    {confirmation && <div className={styles['memory-governance-confirm']}>
      <p>{confirmation === 'enabled' ? '启用后仅在适用范围和环境匹配时参与召回，经验不会改变执行权限。' : '撤回后停止召回此经验，保留来源及核实记录用于审查。'}</p>
      <div className={actionsClass}><button type="button" className={buttonClass} disabled={busy} onClick={async () => { if (await onTransition(entry, confirmation)) setConfirmation(null); }}>确认{confirmation === 'enabled' ? '启用' : '撤回'}</button><button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirmation(null)}>取消</button></div>
    </div>}
    {editing && <div className={styles['memory-governance-form']}>
      <p>纠正内容或适用范围后会回到候选状态，旧版本证据保留供审查，新版本需要重新核实。</p>
      <label>经验内容<textarea aria-label="经验内容" disabled={busy} value={content} onChange={event => setContent(event.target.value)} /></label>
      <div className={styles['memory-governance-fields']}>
        <label>经验范围<select aria-label="经验范围" disabled={busy} value={scope} onChange={event => setScope(event.target.value as 'project' | 'global')}><option value="project">指定项目</option><option value="global">此助手全局</option></select></label>
        {scope === 'project' && <MemoryProjectSelect label="适用项目" value={projectId} projects={projects} disabled={busy} onChange={setProjectId} />}
        <label>适用平台<input aria-label="适用平台" disabled={busy} value={platform} onChange={event => setPlatform(event.target.value)} /></label>
        <label>适用应用版本<input aria-label="适用应用版本" disabled={busy} value={appVersion} onChange={event => setAppVersion(event.target.value)} /></label>
        <label>适用频道<input aria-label="适用频道" disabled={busy} value={channel} onChange={event => setChannel(event.target.value)} /></label>
      </div>
      <label>适用依赖版本（每行 name=version）<textarea aria-label="适用依赖版本" disabled={busy} value={dependencies} onChange={event => setDependencies(event.target.value)} /></label>
      {!parsedDependencies && <p role="alert">每行应为依赖名=版本，依赖名不能重复。</p>}
      <div className={actionsClass}>
        <button type="button" className={buttonClass} disabled={busy || !parsedDependencies || !content.trim() || (scope === 'project' && !projectId.trim())} onClick={() => void saveEdit()}>保存经验纠正</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => setEditing(false)}>取消经验纠正</button>
      </div>
    </div>}
    {reviewing && <div className={styles['memory-governance-form']}>
      <p>请填写实际运行和检查过的证据。未知结果不能晋升为已验证；一次核实不代表普遍有效。</p>
      <label>证据来源<select aria-label="证据来源" value={evidenceOrigin} disabled={busy} onChange={event => { setEvidenceOrigin(event.target.value as 'recorded_run' | 'external_manual'); setApprovedKey(null); }}><option value="recorded_run">已记录的真实运行</option><option value="external_manual">外部人工证据</option></select></label>
      {evidenceOrigin === 'recorded_run' ? <>
        <MemoryRunPicker agentId={agentId} busy={busy} projects={projects} selected={selectedRun} onSelect={run => { setSelectedRun(run); setApprovedKey(null); }} />
        <button type="button" className={buttonClass} disabled={busy || !selectedRun || adopted} onClick={async () => { if (selectedRun && adoptionKey && await onAttempt(entry, selectedRun.runId)) setAdoptedKey(adoptionKey); }}>本次实际采用了这条经验</button>
        <p className={styles['memory-governance-meta']}>{adopted ? '此运行的采用关联已记录；重复提交不会增加计数。' : '仅在实际执行时使用了当前版本经验后点击。选择运行、检索或打开详情均不算采用。'}</p>
      </> : <>
      <p className={v2.externalWarning}>外部人工证据：由人工提供，未自动解析或验证来源真实性。请独立核对运行、报告和环境。</p>
      <div className={styles['memory-governance-fields']}>
        <label>运行标识<input aria-label="运行标识" disabled={busy} value={runId} onChange={event => setRunId(event.target.value)} /></label>
        <label>证据引用<input aria-label="证据引用" disabled={busy} value={evidenceRef} onChange={event => setEvidenceRef(event.target.value)} placeholder="测试报告、产物或运行记录标识" /></label>
        <label>运行平台<input aria-label="运行平台" disabled={busy} value={platform} onChange={event => setPlatform(event.target.value)} placeholder="linux / darwin / win32" /></label>
        <label>应用版本<input aria-label="应用版本" disabled={busy} value={appVersion} onChange={event => setAppVersion(event.target.value)} /></label>
        <MemoryProjectSelect label="运行项目" value={projectId} projects={projects} disabled={busy} onChange={value => { setProjectId(value); setApprovedKey(null); }} />
        <label>运行频道<input aria-label="运行频道" disabled={busy} value={channel} onChange={event => setChannel(event.target.value)} /></label>
      </div>
      <label>运行依赖版本（每行 name=version）<textarea aria-label="运行依赖版本" disabled={busy} value={dependencies} onChange={event => setDependencies(event.target.value)} /></label>
      {!parsedDependencies && <p role="alert">每行应为依赖名=版本，依赖名不能重复。</p>}
      </>}
      <label>核实结果<select aria-label="核实结果" disabled={busy} value={outcome} onChange={event => { setOutcome(event.target.value); setApprovedKey(null); }}><option value="unknown">未知</option><option value="success">成功</option><option value="failure">失败</option></select></label>
      <label>结果摘要<textarea aria-label="结果摘要" disabled={busy} value={summary} onChange={event => { setSummary(event.target.value); setApprovedKey(null); }} /></label>
      <label className={styles['memory-governance-checkbox']}><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setApprovedKey(event.target.checked ? approvalKey : null)} />我已检查上述运行与证据，确认这是真实观察到的结果。</label>
      <div className={actionsClass}>
        <button type="button" className={buttonClass} disabled={busy || !confirmed || !evidenceReady || !summary.trim()} onClick={() => void saveReview()}>保存核实结果</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => setReviewing(false)}>取消核实</button>
      </div>
    </div>}
  </section>;
}
