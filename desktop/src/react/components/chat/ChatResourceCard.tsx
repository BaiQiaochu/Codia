import type { ReactNode } from 'react';
import styles from './ChatResourceCard.module.css';

export type ChatResourceCardStatusTone = 'neutral' | 'success' | 'danger' | 'muted' | 'accent';

interface ChatResourceCardProps {
  icon: ReactNode;
  title: ReactNode;
  titleMeta?: ReactNode;
  subtitle?: ReactNode;
  statusLabel?: ReactNode;
  statusTone?: ChatResourceCardStatusTone;
  actionSlot?: ReactNode;
  onClick?: () => void;
  onToggle?: () => void;
  expanded?: boolean;
  expandable?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  children?: ReactNode;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function CardBody({
  icon,
  title,
  titleMeta,
  subtitle,
  statusLabel,
  statusTone = 'neutral',
  expandable = false,
  expanded = false,
}: Pick<ChatResourceCardProps, 'icon' | 'title' | 'titleMeta' | 'subtitle' | 'statusLabel' | 'statusTone' | 'expandable' | 'expanded'>) {
  return (
    <>
      <span className={styles.icon} aria-hidden="true">{icon}</span>
      <span className={styles.body}>
        <span className={styles.titleRow}>
          <span className={styles.title}>{title}</span>
          {titleMeta && <span className={styles.titleMeta}>{titleMeta}</span>}
          {statusLabel && (
            <span className={cx(styles.status, styles[`status-${statusTone}`])}>
              {statusLabel}
            </span>
          )}
        </span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
      </span>
      {expandable && (
        <span className={cx(styles.chevron, expanded && styles.chevronExpanded)} aria-hidden="true">
          ›
        </span>
      )}
    </>
  );
}

export function ChatResourceCard({
  icon,
  title,
  titleMeta,
  subtitle,
  statusLabel,
  statusTone = 'neutral',
  actionSlot,
  onClick,
  onToggle,
  expanded = false,
  expandable = false,
  disabled = false,
  className,
  ariaLabel,
  children,
}: ChatResourceCardProps) {
  const activate = onToggle ?? onClick;
  const interactive = !!activate && !disabled;
  const rootClass = cx(
    styles.card,
    interactive && styles.interactive,
    expanded && styles.expanded,
    disabled && styles.disabled,
    className,
  );

  return (
    <div className={rootClass} data-chat-resource-card="">
      <div className={styles.header}>
        {interactive ? (
          <button
            type="button"
            className={styles.main}
            onClick={activate}
            aria-label={ariaLabel}
            aria-expanded={expandable ? expanded : undefined}
          >
            <CardBody
              icon={icon}
              title={title}
              titleMeta={titleMeta}
              subtitle={subtitle}
              statusLabel={statusLabel}
              statusTone={statusTone}
              expandable={expandable}
              expanded={expanded}
            />
          </button>
        ) : (
          <div
            className={styles.main}
            aria-label={ariaLabel}
            aria-disabled={disabled || undefined}
          >
            <CardBody
              icon={icon}
              title={title}
              titleMeta={titleMeta}
              subtitle={subtitle}
              statusLabel={statusLabel}
              statusTone={statusTone}
              expandable={expandable}
              expanded={expanded}
            />
          </div>
        )}
        {actionSlot && <div className={styles.actions}>{actionSlot}</div>}
      </div>
      {children && expanded && <div className={styles.details}>{children}</div>}
    </div>
  );
}
