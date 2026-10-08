import { Clock, Folder } from '@phosphor-icons/react';
import type { SessionViewMode } from './session-sections';
import styles from './SessionList.module.css';

export function SessionViewToggle({ value, onChange, t }: {
  value: SessionViewMode;
  onChange: (mode: SessionViewMode) => void;
  t: (key: string) => string;
}) {
  return (
    <div className={styles.sessionViewToggle} role="group" aria-label={t('sidebar.view.sort')}>
      {(['time', 'project'] as const).map(mode => {
        const Icon = mode === 'time' ? Clock : Folder;
        return (
          <button
            key={mode}
            type="button"
            className={styles.sessionViewButton}
            aria-pressed={value === mode}
            onClick={() => onChange(mode)}
          >
            <Icon size={14} weight={value === mode ? 'fill' : 'regular'} aria-hidden="true" />
            <span>{t(`sidebar.view.${mode}`)}</span>
          </button>
        );
      })}
    </div>
  );
}
