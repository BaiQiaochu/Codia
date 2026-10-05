import { memo, useEffect, useId, useMemo, useRef, type RefObject } from 'react';
import type { Agent } from '../../types';
import type { FileMentionItem } from '../../utils/file-mention-items';
import type { AgentMentionItem, MentionTab, SessionMentionItem } from '../../utils/mention-items';
import { kindOfFileName } from '../../utils/file-kind';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { FileKindIcon } from '../shared/FileKindIcon';
import { FolderIcon } from '../shared/FolderIcon';
import { useI18n } from '../../hooks/use-i18n';
import { useMentionThumbnail } from '../../hooks/use-mention-thumbnail';
import styles from './InputArea.module.css';

export type MentionMenuItem = FileMentionItem | SessionMentionItem | AgentMentionItem;

export const MentionMenu = memo(function MentionMenu({
  tab,
  items,
  selected,
  busy,
  agents,
  onTabChange,
  onSelect,
  onHover,
}: {
  tab: MentionTab;
  items: MentionMenuItem[];
  selected: number;
  busy: boolean;
  agents: Agent[];
  onTabChange: (tab: MentionTab) => void;
  onSelect: (item: MentionMenuItem) => void;
  onHover: (index: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { t } = useI18n();
  const tabs: MentionTab[] = ['files', 'sessions', 'agents'];

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, tab]);

  return (
    <div className={styles['mention-menu']} role="dialog" aria-label={t('input.mention.title')}>
      <div className={styles['mention-tabs']} role="tablist" aria-label={t('input.mention.title')}>
        {tabs.map(value => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${menuId}-${value}`}
            aria-controls={`${menuId}-panel`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            className={`${styles['mention-tab']}${tab === value ? ` ${styles.selected}` : ''}`}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => onTabChange(value)}
            onKeyDown={event => {
              const index = tabs.indexOf(value);
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              onTabChange(tabs[next]);
              document.getElementById(`${menuId}-${tabs[next]}`)?.focus();
            }}
          >
            {t(`input.mention.tab.${value}`)}
          </button>
        ))}
      </div>
      <div id={`${menuId}-panel`} role="tabpanel" aria-labelledby={`${menuId}-${tab}`} className={styles['mention-panel']}>
        <div className={styles['mention-results']} role="listbox" aria-label={t('input.mention.title')} aria-busy={busy}>
          {items.map((item, index) => (
            <MentionItemButton
              key={item.id}
              item={item}
              agents={agents}
              selected={index === selected}
              refProp={index === selected ? selectedRef : undefined}
              onHover={() => onHover(index)}
              onSelect={() => onSelect(item)}
            />
          ))}
          {items.length === 0 && (
            <div className={styles['mention-empty']}>
              {busy ? t('common.loading') : t('input.mention.empty')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

function MentionItemButton({
  item,
  agents,
  selected,
  refProp,
  onHover,
  onSelect,
}: {
  item: MentionMenuItem;
  agents: Agent[];
  selected: boolean;
  refProp?: RefObject<HTMLButtonElement | null>;
  onHover: () => void;
  onSelect: () => void;
}) {
  return (
    <button
      ref={refProp}
      type="button"
      role="option"
      aria-selected={selected}
      className={`${styles['mention-item']}${selected ? ` ${styles.selected}` : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onSelect}
    >
      <span className={styles['mention-icon']} aria-hidden="true">
        <MentionItemIcon item={item} agents={agents} />
      </span>
      <span className={styles['mention-main']}>
        <span className={styles['mention-name']}>{item.name}</span>
        <span className={styles['mention-detail']}>{item.detail}</span>
      </span>
    </button>
  );
}

function MentionItemIcon({ item, agents }: { item: MentionMenuItem; agents: Agent[] }) {
  const file = item.kind === 'agent' || item.kind === 'session' ? null : item;
  const fileKind = file ? kindOfFileName(file.name || file.path, file.mimeType) : 'other';
  const thumbnailUrl = useMentionThumbnail(file && !file.isDirectory && (fileKind === 'image' || fileKind === 'svg') ? file.path : null, file?.mimeType);
  const agentInfo = useMemo(() => {
    if (!('kind' in item) || item.kind !== 'agent') return null;
    return resolveAgentDisplayInfo({ id: item.agentId, agents, fallbackAgentName: item.name, fallbackAgentYuan: item.yuan });
  }, [agents, item]);

  if ('kind' in item && item.kind === 'agent' && agentInfo) {
    return <AgentAvatar info={agentInfo} className={styles['mention-agent-avatar']} alt="" />;
  }
  if ('kind' in item && item.kind === 'session') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="4" y="3" width="16" height="18" rx="1" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </svg>
    );
  }

  if (thumbnailUrl) return <img className={styles['mention-thumbnail']} src={thumbnailUrl} alt="" />;
  if (file?.isDirectory) return <FolderIcon size={18} />;
  return <FileKindIcon kind={fileKind} size={18} />;
}
