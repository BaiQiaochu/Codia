import { memo, useRef, useEffect } from 'react';
import type { SlashItem } from './slash-commands';
import { useI18n } from '../../hooks/use-i18n';
import styles from './InputArea.module.css';

export const SlashCommandMenu = memo(function SlashCommandMenu({ commands, selected, busy, onSelect, onHover }: {
  commands: SlashItem[];
  selected: number;
  busy: string | null;
  onSelect: (cmd: SlashItem) => void;
  onHover: (i: number) => void;
}) {
  const { t } = useI18n();
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (typeof selectedRef.current?.scrollIntoView === 'function') {
      selectedRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);

  const groups = [
    { key: 'builtin', label: t('input.slash.group.commands'), items: commands.map((cmd, index) => ({ cmd, index })).filter(item => item.cmd.type === 'builtin') },
    { key: 'skill', label: t('input.slash.group.skills'), items: commands.map((cmd, index) => ({ cmd, index })).filter(item => item.cmd.type === 'skill') },
  ].filter(group => group.items.length > 0);

  return (
    <div className={styles['slash-menu']} role="listbox" aria-label={t('input.slash.title')}>
      {groups.map(group => (
        <div key={group.key} className={styles['slash-menu-group']}>
          <div className={styles['slash-menu-group-label']}>{group.label}</div>
          {group.items.map(({ cmd, index }) => (
            <button type="button"
              role="option"
              aria-selected={index === selected}
              key={`${cmd.type}:${cmd.name}`}
              ref={index === selected ? selectedRef : undefined}
              className={`${styles['slash-menu-item']}${index === selected ? ` ${styles.selected}` : ''}${busy === cmd.name ? ` ${styles.busy}` : ''}`}
              onMouseEnter={() => onHover(index)}
              onClick={() => !busy && onSelect(cmd)}
              disabled={!!busy}
            >
              <span className={styles['slash-menu-icon']} dangerouslySetInnerHTML={{ __html: cmd.icon }} />
              <span className={styles['slash-menu-label']}>{cmd.label}</span>
              <span className={styles['slash-menu-desc']}>{cmd.description}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
});
