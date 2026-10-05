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
    <section {...sectionProps} className={cx('gsap-plugin-card', className)}>
      {(title || description || actions) && (
        <header className="gsap-plugin-card-header">
          <div className="gsap-plugin-card-heading">
            {title && <h2 className="gsap-plugin-card-title">{title}</h2>}
            {description && <p className="gsap-plugin-card-description">{description}</p>}
          </div>
          {actions && <div className="gsap-plugin-card-actions">{actions}</div>}
        </header>
      )}
      <div className="gsap-plugin-card-body">{children}</div>
      {footer && <footer className="gsap-plugin-card-footer">{footer}</footer>}
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
        'gsap-plugin-setting-row',
        layout === 'stacked' ? 'gsap-plugin-setting-row-stacked' : 'gsap-plugin-setting-row-inline',
        className,
      )}
    >
      <div className="gsap-plugin-setting-text">
        <div className="gsap-plugin-setting-label">{label}</div>
        {hint && <div className="gsap-plugin-setting-hint">{hint}</div>}
      </div>
      <div className="gsap-plugin-setting-control">{control}</div>
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
    <div {...rootProps} className={cx('gsap-plugin-empty', className)}>
      {icon && <div className="gsap-plugin-empty-icon">{icon}</div>}
      <div className="gsap-plugin-empty-title">{title}</div>
      {description && <div className="gsap-plugin-empty-description">{description}</div>}
      {action && <div className="gsap-plugin-empty-action">{action}</div>}
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
    <ul {...listProps} className={cx('gsap-plugin-list', className)}>
      {items.map((item) => (
        <li key={item.id} className="gsap-plugin-list-item">
          {item.icon && <div className="gsap-plugin-list-icon">{item.icon}</div>}
          <div className="gsap-plugin-list-main">
            <div className="gsap-plugin-list-line">
              <span className="gsap-plugin-list-title">{item.title}</span>
              {item.meta && <span className="gsap-plugin-list-meta">{item.meta}</span>}
            </div>
            {item.description && <div className="gsap-plugin-list-description">{item.description}</div>}
          </div>
          {item.action && <div className="gsap-plugin-list-action">{item.action}</div>}
        </li>
      ))}
    </ul>
  );
}
