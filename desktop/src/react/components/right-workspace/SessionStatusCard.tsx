import { useState } from 'react';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import styles from './SessionStatusCard.module.css';
import { workspaceDisplayName } from '../../../../../shared/workspace-history.ts';

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function SessionStatusCard() {
  const [collapsed, setCollapsed] = useState(true);
  const sessionPath = useStore((s) => s.currentSessionPath);
  const deskBasePath = useStore((s) => s.deskBasePath);
  const selectedFolder = useStore((s) => s.selectedFolder);
  const homeFolder = useStore((s) => s.homeFolder);
  const currentModel = useStore((s) => s.currentModel);
  const sessionModel = useStore((s) => (sessionPath ? sessionScopedValue(s, s.sessionModelsByPath, sessionPath) ?? null : null));
  const filesCount = useStore((s) => (sessionPath ? (sessionScopedValue(s, s.sessionRegistryFilesByPath, sessionPath)?.length ?? 0) : 0));
  const t = window.t ?? ((k: string) => k);

  if (!sessionPath) return null;

  const modelId = sessionModel?.id || currentModel?.id || '-';
  const cwdPath = deskBasePath || selectedFolder || homeFolder || '';
  const cwd = cwdPath ? workspaceDisplayName(cwdPath, '-') : '-';

  return (
    <section className={`universal-card jian-card ${styles.card}`} aria-label={t('rightWorkspace.session.title')}>
      <button className={styles.header} type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
        <span className={styles.title}>{t('rightWorkspace.session.title')}</span>
        <Chevron open={!collapsed} />
      </button>
      {!collapsed && (
        <dl className={styles.body}>
          <div className={styles.row}>
            <dt className={styles.label}>{t('rightWorkspace.session.cwd')}</dt>
            <dd className={styles.value} title={cwdPath || undefined}>{cwd}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.label}>{t('rightWorkspace.session.model')}</dt>
            <dd className={styles.value} title={modelId}>{modelId}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.label}>{t('rightWorkspace.session.files')}</dt>
            <dd className={styles.value}>{filesCount}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
