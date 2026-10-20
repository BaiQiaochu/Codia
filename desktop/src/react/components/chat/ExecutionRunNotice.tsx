import { useEffect, useState } from 'react';
import { isExecutionPaused, type ExecutionRunSnapshot } from '../../../../../shared/execution-run';
import { useI18n } from '../../hooks/use-i18n';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import { newerExecutionRun, subscribeExecutionRun } from '../../services/execution-run-events';
import { useStore } from '../../stores';
import styles from './ExecutionRunNotice.module.css';

export function ExecutionRunNotice({ sessionPath }: { sessionPath: string }) {
  const { t } = useI18n();
  const connection = useStore(s => s.activeServerConnection);
  const [run, setRun] = useState<ExecutionRunSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => {
    setRun(null); setError(false); setReviewed(false);
    if (!sessionPath || !connection) return;
    let disposed = false;
    const update = (next: ExecutionRunSnapshot | null) => {
      if (!disposed) setRun(previous => newerExecutionRun(previous, next));
    };
    const load = async () => {
      try {
        const response = await codiaFetch(`/api/sessions/execution-run?path=${encodeURIComponent(sessionPath)}`);
        const data = await response.json() as { run: ExecutionRunSnapshot | null };
        update(data.run);
      } catch { /* Reconnection refreshes the snapshot; never imply a successful resume. */ }
    };
    const unsubscribe = subscribeExecutionRun((path, next) => { if (path === sessionPath) update(next); });
    void load();
    const interval = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { disposed = true; unsubscribe(); clearInterval(interval); };
  }, [connection, sessionPath]);
  if (!run || !isExecutionPaused(run)) return null;
  const act = async (resume: boolean, acknowledge = false) => {
    if (busy) return;
    setBusy(true); setError(false);
    try {
      if (resume || acknowledge) {
        const response = await codiaFetch(`/api/sessions/execution-run/${acknowledge ? 'acknowledge' : 'resume'}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: sessionPath, runId: run.runId, revision: run.revision,
            ...(acknowledge ? { reviewed, toolIds: run.pendingTools.map(tool => tool.id) } : {}) }),
        });
        const data = await response.json() as { run: ExecutionRunSnapshot };
        setRun(previous => newerExecutionRun(previous, data.run));
      } else {
        const response = await codiaFetch('/api/sessions/execution-run/stop', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: sessionPath }),
        });
        const data = await response.json() as { run: ExecutionRunSnapshot };
        setRun(previous => newerExecutionRun(previous, data.run));
      }
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return <section className={styles.notice} role="status">
    <strong>{t(`runControl.${run.status}`)}</strong>
    <p>{t(`runControl.${run.reason || 'interrupted'}`)}</p>
    {run.activeTimeUncertain && <p>{t('runControl.timeUncertain')}</p>}
    <small>{t('runControl.usage', {
      models: String(run.used.modelCalls), tools: String(run.used.toolCalls),
      minutes: String(Math.ceil(run.used.activeMs / 60_000)),
    })}</small>
    {run.pendingTools.length > 0 && <p>{t('runControl.pending')}</p>}
    {run.status === 'needs_attention' && run.pendingTools.length > 0 && <details>
      <summary>{t('runControl.inspect')}</summary>
      <ul>{run.pendingTools.map(tool => <li key={tool.id}>{tool.name} · <code>{tool.id}</code></li>)}</ul>
      <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />{t('runControl.reviewed')}</label>
      <button type="button" disabled={busy || !reviewed} onClick={() => void act(false, true)}>{t('runControl.acknowledge')}</button>
    </details>}
    <div className={styles.actions}>
      <button type="button" disabled={busy || run.status !== 'paused' || run.pendingTools.length > 0} onClick={() => void act(true)}>{t('runControl.continue')}</button>
      <button type="button" disabled={busy} onClick={() => void act(false)}>{t('runControl.stop')}</button>
    </div>
    <small>{t('runControl.grant')}</small>
    {error && <p role="alert">{t('runControl.actionFailed')}</p>}
  </section>;
}
