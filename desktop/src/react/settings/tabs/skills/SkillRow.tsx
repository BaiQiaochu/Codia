import React from 'react';
import type { SkillInfo } from '../../store';
import { t } from '../../helpers';
import { skillDisplayName, skillShortDescription } from '../../../utils/skill-display';
import styles from '../../Settings.module.css';

const FALLBACK_LABELS: Record<string, string> = {
  'settings.skills.dragToBundleTitle': 'Drag to bundle',
  'settings.skills.enableSkillTitle': 'Enable skill',
  'settings.skills.disableSkillTitle': 'Disable skill',
  'settings.skills.enableSkillAriaLabel': 'Enable {name}',
  'settings.skills.disableSkillAriaLabel': 'Disable {name}',
};

function tr(key: string, vars?: Record<string, string | number>) {
  const translated = t(key, vars);
  const template = translated === key ? FALLBACK_LABELS[key] || key : translated;
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

function truncateDesc(raw: string): string {
  const cnMatch = raw.match(/[\u4e00-\u9fff].*$/s);
  let desc = cnMatch ? cnMatch[0] : raw;
  desc = desc.replace(/\s*MANDATORY TRIGGERS:.*$/si, '').trim();
  if (desc.length > 80) desc = `${desc.slice(0, 80)}...`;
  return desc;
}

interface SkillRowProps {
  skill: SkillInfo;
  nameHint?: string;
  deletable?: boolean;
  draggable?: boolean;
  className?: string;
  extraActions?: React.ReactNode;
  highlighted?: boolean;
  onDelete?: (name: string) => void;
  onToggle?: (name: string, enabled: boolean) => void;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>, name: string) => void;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
}

export function SkillRow({
  skill,
  nameHint,
  deletable = true,
  draggable = false,
  className = '',
  extraActions,
  highlighted = false,
  onDelete,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop,
}: SkillRowProps) {
  const locale = window.i18n?.locale || 'zh-CN';
  const curatedName = skillDisplayName(skill, locale);
  const displayName = curatedName !== skill.name ? curatedName : (nameHint || skill.name);
  const displayDesc = truncateDesc(skillShortDescription(skill, locale) || skill.description || '');
  const rowClassName = [
    styles['skills-list-item'],
    draggable ? styles['skill-row-draggable'] : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      className={rowClassName}
      data-testid={`skill-row-${skill.name}`}
      data-highlighted={highlighted ? 'true' : undefined}
      data-highlighted-skill={highlighted ? skill.name : undefined}
      draggable={draggable}
      onDragStart={(event) => onDragStart?.(event, skill.name)}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={() => {
        if (skill.baseDir) {
          window.platform?.openSkillViewer?.({
            name: skill.name,
            displayName,
            baseDir: skill.baseDir,
            filePath: skill.filePath,
            installed: true,
          });
        }
      }}
    >
      {draggable ? (
        <span
          className={styles['skill-row-drag-handle']}
          data-testid={`skill-drag-handle-${skill.name}`}
          title={tr('settings.skills.dragToBundleTitle')}
          aria-hidden="true"
          onClick={(event) => event.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
            <circle cx="4" cy="3" r="1.2" />
            <circle cx="10" cy="3" r="1.2" />
            <circle cx="4" cy="7" r="1.2" />
            <circle cx="10" cy="7" r="1.2" />
            <circle cx="4" cy="11" r="1.2" />
            <circle cx="10" cy="11" r="1.2" />
          </svg>
        </span>
      ) : null}
      <div className={styles['skills-list-info']}>
        <span className={styles['skills-list-name']}>
          {displayName}
          {displayName !== skill.name && <span className={styles['skills-list-name-hint']}>{skill.name}</span>}
        </span>
        <span className={styles['skills-list-desc']}>{displayDesc}</span>
      </div>
      <div className={styles['skills-list-actions']}>
        {extraActions}
        {deletable && onDelete && (
          <button
            className={styles['skill-card-delete']}
            type="button"
            title={t('settings.skills.delete')}
            aria-label={t('settings.skills.delete')}
            onClick={(event) => { event.stopPropagation(); onDelete(skill.name); }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        {onToggle && (
          <button
            className={`codia-toggle${skill.enabled ? ' on' : ''}`}
            type="button"
            title={skill.enabled ? tr('settings.skills.disableSkillTitle') : tr('settings.skills.enableSkillTitle')}
            aria-label={skill.enabled
              ? tr('settings.skills.disableSkillAriaLabel', { name: skill.name })
              : tr('settings.skills.enableSkillAriaLabel', { name: skill.name })}
            onClick={(event) => { event.stopPropagation(); onToggle(skill.name, !skill.enabled); }}
          />
        )}
      </div>
    </div>
  );
}
