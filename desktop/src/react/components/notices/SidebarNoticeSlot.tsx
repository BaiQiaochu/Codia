import { useEffect, useMemo, useState } from 'react';
import { useAutoUpdateState } from '../../hooks/use-auto-update-state';
import type { AutoUpdateState } from '../../types';
import { getDesktopApi } from '../../utils/desktop-api';
import styles from './SidebarNoticeSlot.module.css';

const DISMISSED_UPDATE_KEY = 'codia-sidebar-update-dismissed-key';
const ACTIONABLE_UPDATE_STATUSES = new Set<AutoUpdateState['status']>([
  'downloaded',
]);

type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface SidebarUpdateNoticeCardProps {
  state: AutoUpdateState | null;
  onInstall?: () => void | Promise<unknown>;
  storage?: NoticeStorage | null;
}

const tr = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

function safeStorage(): NoticeStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDismissedKey(storage: NoticeStorage | null): string | null {
  try {
    return storage?.getItem(DISMISSED_UPDATE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeDismissedKey(storage: NoticeStorage | null, key: string): void {
  try {
    storage?.setItem(DISMISSED_UPDATE_KEY, key);
  } catch {
    // Storage can be blocked; the in-memory dismissed state still hides this card.
  }
}

function updateNoticeKey(state: AutoUpdateState | null): string | null {
  if (!state || !ACTIONABLE_UPDATE_STATUSES.has(state.status)) return null;
  return state.version ? `version:${state.version}` : `status:${state.status}`;
}

function percentOf(state: AutoUpdateState): number {
  const rawPercent = state.progress?.percent ?? 0;
  return Math.max(0, Math.min(100, Math.round(rawPercent)));
}

function UpdateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function updateTitle(state: AutoUpdateState): string {
  if (state.status === 'downloaded') {
    return tr('settings.about.updateReadyInstall', { version: state.version ?? '' });
  }
  if (state.status === 'installing') {
    return tr('settings.about.updateInstalling');
  }
  if (state.status === 'error') {
    if (state.error === 'disk_space_insufficient') return tr('settings.about.updateDiskSpace');
    if (state.error === 'running_from_dmg') return tr('settings.about.updateNeedInstall');
    return tr('settings.about.updateError');
  }
  return tr('settings.about.updateAvailable', { version: state.version ?? '' });
}

function updateBody(state: AutoUpdateState): string | null {
  if (state.status === 'downloading') {
    return tr('settings.about.updateDownloading', {
      agentName: '助手',
      percent: percentOf(state),
    });
  }
  if (state.status === 'downloaded') {
    return tr('settings.about.updateInstallManualHint');
  }
  if (state.status === 'error' && state.error && state.error !== 'disk_space_insufficient' && state.error !== 'running_from_dmg') {
    return state.error;
  }
  return null;
}

export function SidebarUpdateNoticeCard({
  state,
  onInstall,
  storage,
}: SidebarUpdateNoticeCardProps) {
  const resolvedStorage = storage === undefined ? safeStorage() : storage;
  const noticeKey = updateNoticeKey(state);
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => readDismissedKey(resolvedStorage));

  useEffect(() => {
    setDismissedKey(readDismissedKey(resolvedStorage));
  }, [noticeKey, resolvedStorage]);

  const content = useMemo(() => {
    if (!state || !noticeKey || dismissedKey === noticeKey) return null;
    return {
      title: updateTitle(state),
      body: updateBody(state),
    };
  }, [dismissedKey, noticeKey, state]);

  if (!state || !noticeKey || !content) return null;

  const dismiss = () => {
    writeDismissedKey(resolvedStorage, noticeKey);
    setDismissedKey(noticeKey);
  };
  const percent = state.status === 'downloading' ? percentOf(state) : null;

  return (
    <div className={styles.slot}>
      <section className={styles.card} role="status" aria-live="polite">
        <span className={styles.icon}>
          <UpdateIcon />
        </span>
        <div className={styles.content}>
          <div className={styles.title}>{content.title}</div>
          {content.body && <div className={styles.body}>{content.body}</div>}
          {percent !== null && (
            <div className={styles.progressRow}>
              <div className={styles.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <span className={styles.progressFill} style={{ width: `${percent}%` }} />
              </div>
              <span className={styles.progressValue}>{tr('settings.about.updateProgress', { percent })}</span>
            </div>
          )}
          {state.status === 'downloaded' && onInstall && (
            <div className={styles.actions}>
              <button type="button" className={styles.actionButton} onClick={() => void onInstall()}>
                <span>{tr('settings.about.updateInstall')}</span>
                <UpdateIcon />
              </button>
            </div>
          )}
        </div>
        <button type="button" className={styles.closeButton} aria-label={tr('window.close')} onClick={dismiss}>
          <CloseIcon />
        </button>
      </section>
    </div>
  );
}

export function SidebarNoticeSlot() {
  const updateState = useAutoUpdateState();
  return (
    <SidebarUpdateNoticeCard
      state={updateState}
      onInstall={() => getDesktopApi()?.autoUpdateInstall?.()}
    />
  );
}
