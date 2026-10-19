import { useCallback, useEffect, useRef, useState } from 'react';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import { switchSession } from '../../stores/session-actions';
import type { CronJob } from './automation-types';
import { validScheduleTimezone } from './SchedulePolicyEditor';
import styles from './AutomationPanel.module.css';

interface Run {
  status: string;
  timestamp?: string;
  startedAt?: string;
  finishedAt?: string;
  scheduledAt?: string;
  requestId?: string;
  trigger?: string;
  error?: string;
  reason?: string;
  sessionPath?: string | null;
  activityId?: string;
}
interface Health {
  status: string;
  history: Run[];
  latest?: Run | null;
  running?: boolean;
  requiresReview: boolean;
  reviewKey?: string | null;
  consecutiveErrors?: number;
  backoffUntil?: string | null;
  disabledAfterAttempt?: boolean;
}
const labels: Record<string, string> = { success: '执行成功', timeout: '执行超时', missed: '错过周期，已跳过', one_time_failed: '一次性任务失败', unknown: '结果未知', claimed: '已领取，尚无结果', error: '执行失败', running: '正在执行', skipped: '已跳过', never: '尚无运行记录' };
function runLabel(run: Run) {
  return run.status === 'error' && /timeout/i.test(run.error || '') ? labels.timeout : run.status === 'skipped' && run.reason === 'misfire' ? labels.missed : labels[run.status] || run.status;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function AutomationHealthPanel({ job, dirty, refreshVersion }: { job: CronJob; dirty: boolean; refreshVersion: number }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Array<{ role: string; content: string }> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const requestVersion = useRef(0);
  const previewVersion = useRef(0);
  const submitLock = useRef(false);
  const pendingRequest = useRef<string | null>(null);
  const query = job.actorAgentId ? `?agentId=${encodeURIComponent(job.actorAgentId)}` : '';
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const response = await codiaFetch(`/api/desk/cron/${encodeURIComponent(job.id)}/health${query}`);
      const data = await response.json();
      if (response.ok === false || typeof data.status !== 'string' || !Array.isArray(data.history)) throw new Error('运行记录读取失败');
      if (version !== requestVersion.current) return;
      setHealth(data);
      setError(null);
      if (pendingRequest.current && data.history.some((row: Run) => row.requestId === pendingRequest.current && row.status !== 'claimed')) {
        pendingRequest.current = null;
        setUncertain(false);
      }
    } catch (err) { if (version === requestVersion.current) setError(errorMessage(err)); }
  }, [job.id, query]);
  useEffect(() => { void load(); }, [load, refreshVersion]);
  useEffect(() => () => { requestVersion.current += 1; previewVersion.current += 1; }, []);
  useEffect(() => { setReviewed(false); }, [health?.reviewKey]);

  const formatTime = (value?: string | null) => {
    if (!value || !Number.isFinite(Date.parse(value))) return '未知时间';
    return new Date(value).toLocaleString(undefined, { hour12: false, ...(job.timezone && validScheduleTimezone(job.timezone) ? { timeZone: job.timezone } : {}) });
  };
  const needsReview = health?.requiresReview || uncertain;
  const run = async () => {
    if (submitLock.current || dirty || !health || error || health.running || (needsReview && !reviewed)) return;
    submitLock.current = true;
    setSubmitting(true);
    setRunError(null);
    // Never automatically retry a POST after a transport failure. Every new run is an explicit confirmation.
    const requestId = crypto.randomUUID();
    pendingRequest.current = requestId;
    try {
      const response = await codiaFetch(`/api/desk/cron${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run-now', id: job.id, requestId, ...(reviewed ? { reviewedRunKey: health.reviewKey } : {}) }),
      });
      const data = await response.json();
      if (response.ok === false || !data.ok) throw new Error(typeof data.error === 'string' ? data.error : '试跑请求未确认');
      setArmed(false);
      setReviewed(false);
      setUncertain(false);
      await load();
    } catch (err) {
      setUncertain(true);
      setReviewed(false);
      setRunError(`请求结果未确认：${errorMessage(err)}。请刷新记录并核对外部影响，再决定是否新运行。`);
      await load();
    } finally { setSubmitting(false); submitLock.current = false; }
  };
  const openResult = async (record: Run) => {
    const version = ++previewVersion.current;
    setPreview(null); setPreviewError(null); setPreviewLoading(true);
    try {
      if (record.activityId) {
        const response = await codiaFetch(`/api/desk/activities/${encodeURIComponent(record.activityId)}/session${query}`);
        const data = await response.json();
        if (response.ok === false || !Array.isArray(data.messages)) throw new Error('原结果会话不可用');
        if (version === previewVersion.current) setPreview(data.messages);
      } else if (record.sessionPath) {
        await switchSession(record.sessionPath);
      }
    } catch (err) { if (version === previewVersion.current) setPreviewError(errorMessage(err)); }
    finally { if (version === previewVersion.current) setPreviewLoading(false); }
  };

  return <section className={styles.healthPanel} aria-label="运行健康">
    <div className={styles.healthHeader}>
      <strong>运行健康</strong>
      <button type="button" className={styles.textButton} onClick={() => void load()}>刷新运行记录</button>
    </div>
    {error && <p role="alert" className={styles.healthWarning}>读取失败：{error}{health ? '；以下为上次数据。' : ''}</p>}
    {!health && !error && <p role="status">正在读取运行记录…</p>}
    {health && <>
      <p role="status">{labels[health.status] || health.status}</p>
      {health.status === 'unknown' && <p className={styles.healthWarning}>已有执行领取记录，但没有确认结果。服务中断后不会自动重放这次执行，请先核对原会话及外部影响。</p>}
      {health.status === 'timeout' && <p className={styles.healthWarning}>等待已超时，外部动作可能已经发生；不能视为已回滚。</p>}
      {health.disabledAfterAttempt && <p>一次性计划执行尝试后已停用，停用本身不代表成功。</p>}
      <p>连续失败：{health.consecutiveErrors || 0}{health.backoffUntil ? `；后续周期最早重试时间：${formatTime(health.backoffUntil)}` : ''}</p>
      <p className={styles.meta}>时间按 {job.timezone || '设备时区'} 显示。最近最多 20 条；历史文件会按保留策略裁剪。</p>
      {health.history.length === 0 ? <p>没有已保留的运行记录。</p> : <ol className={styles.runHistory}>
        {health.history.map((record, index) => <li key={`${record.requestId || record.scheduledAt || record.timestamp || record.startedAt || 'run'}:${index}`}>
          <span>{runLabel(record)} · {record.finishedAt || record.timestamp || record.startedAt ? formatTime(record.finishedAt || record.timestamp || record.startedAt) : '执行时间未知'}{record.scheduledAt ? ` · 计划时间：${formatTime(record.scheduledAt)}` : ''}{record.trigger === 'manual' ? ' · 手动试跑' : ''}</span>
          {record.error && <p className={styles.healthWarning}>{record.error}</p>}
          {record.activityId || record.sessionPath ? <button type="button" className={styles.textButton} onClick={() => void openResult(record)}>查看原结果会话</button> : <span className={styles.meta}> · 没有可用的原会话引用</span>}
        </li>)}
      </ol>}
    </>}
    {previewLoading && <p role="status">正在读取原结果会话…</p>}
    {previewError && <p role="alert">原结果会话读取失败：{previewError}。可再次点击该记录重试。</p>}
    {preview && <div className={styles.resultPreview} aria-label="原结果会话（只读）">
      <button type="button" onClick={() => { previewVersion.current += 1; setPreview(null); }}>关闭结果预览</button>
      {preview.length ? preview.map((message, i) => <p key={i}><strong>{message.role}</strong>{'\n'}{message.content}</p>) : <p>原会话没有可显示的文本消息。</p>}
    </div>}
    <button type="button" className={styles.textButton} disabled={dirty || !health || !!error || health.running || submitting || !job.prompt?.trim()} onClick={() => { setArmed(true); setReviewed(false); }}>试跑一次</button>
    {dirty && <p className={styles.meta}>请先保存当前修改，再试跑已保存的配置。</p>}
    {runError && <p role="alert" className={styles.healthWarning}>{runError}</p>}
    {armed && <div className={styles.runConfirm}>
      <p>这会真实执行已保存的提示、模型和工作目录，可能产生费用或外部动作。沿用现有权限与审批；不会跳过确认。运行结果仍按现有计划规则记录，一次性计划尝试后会停用。</p>
      {needsReview && <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />已核对上次结果与外部影响，仍要新运行一次</label>}
      <div className={styles.actions}>
        <button type="button" disabled={submitting || dirty || !!error || health?.running || (needsReview && !reviewed)} onClick={() => void run()}>确认试跑一次</button>
        <button type="button" disabled={submitting} onClick={() => setArmed(false)}>取消</button>
      </div>
    </div>}
  </section>;
}
