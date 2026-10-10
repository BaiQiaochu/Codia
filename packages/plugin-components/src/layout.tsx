import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './classnames';

export interface CardShellProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}

export function CardShell({
  title,
  description,
  actions,
  footer,
  children,
  className,
  ...sectionProps
}: CardShellProps) {
  return (
    <section {...sectionProps} className={cx('codia-plugin-card', className)}>
      {(title || description || actions) && (
        <header className="codia-plugin-card-header">
          <div className="codia-plugin-card-heading">
            {title && <h2 className="codia-plugin-card-title">{title}</h2>}
            {description && <p className="codia-plugin-card-description">{description}</p>}
          </div>
          {actions && <div className="codia-plugin-card-actions">{actions}</div>}
        </header>
      )}
      <div className="codia-plugin-card-body">{children}</div>
      {footer && <footer className="codia-plugin-card-footer">{footer}</footer>}
    </section>
  );
}

export interface SettingRowProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  hint?: ReactNode;
  control: ReactNode;
  layout?: 'inline' | 'stacked';
}

export function SettingRow({
  label,
  hint,
  control,
  layout = 'inline',
  className,
  ...rowProps
}: SettingRowProps) {
  return (
    <div
      {...rowProps}
      className={cx(
        'codia-plugin-setting-row',
        layout === 'stacked' ? 'codia-plugin-setting-row-stacked' : 'codia-plugin-setting-row-inline',
        className,
      )}
    >
      <div className="codia-plugin-setting-text">
        <div className="codia-plugin-setting-label">{label}</div>
        {hint && <div className="codia-plugin-setting-hint">{hint}</div>}
      </div>
      <div className="codia-plugin-setting-control">{control}</div>
    </div>
  );
}

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action, className, ...rootProps }: EmptyStateProps) {
  return (
    <div {...rootProps} className={cx('codia-plugin-empty', className)}>
      {icon && <div className="codia-plugin-empty-icon">{icon}</div>}
      <div className="codia-plugin-empty-title">{title}</div>
      {description && <div className="codia-plugin-empty-description">{description}</div>}
      {action && <div className="codia-plugin-empty-action">{action}</div>}
    </div>
  );
}

export interface ListItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}

export interface ListProps extends HTMLAttributes<HTMLUListElement> {
  items: ListItem[];
}

export function List({ items, className, ...listProps }: ListProps) {
  return (
    <ul {...listProps} className={cx('codia-plugin-list', className)}>
      {items.map((item) => (
        <li key={item.id} className="codia-plugin-list-item">
          {item.icon && <div className="codia-plugin-list-icon">{item.icon}</div>}
          <div className="codia-plugin-list-main">
            <div className="codia-plugin-list-line">
              <span className="codia-plugin-list-title">{item.title}</span>
              {item.meta && <span className="codia-plugin-list-meta">{item.meta}</span>}
            </div>
            {item.description && <div className="codia-plugin-list-description">{item.description}</div>}
          </div>
          {item.action && <div className="codia-plugin-list-action">{item.action}</div>}
        </li>
      ))}
    </ul>
  );
}
