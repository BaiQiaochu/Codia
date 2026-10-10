import React, { useCallback, useMemo, useState } from 'react';
import type { SkillInfo } from '../../store';
import { t } from '../../helpers';
import { SkillRow } from './SkillRow';
import styles from '../../Settings.module.css';

export interface SkillBundleInfo {
  id: string;
  name: string;
  skillNames: string[];
  source?: string;
  agentId?: string | null;
  sourcePackage?: string | null;
  skills?: Array<{
    name: string;
    enabled: boolean;
    source: string | null;
    missing?: boolean;
  }>;
}

type TreeMode = 'manage' | 'agent';

const FALLBACK_LABELS: Record<string, string> = {
  'settings.skills.createBundleTitle': '新建技能包',
  'settings.skills.createBundleAriaLabel': '新建技能包',
  'settings.skills.createBundleBtn': '新建技能包',
  'settings.skills.expandBundleAriaLabel': '展开技能包',
  'settings.skills.collapseBundleAriaLabel': '收起技能包',
  'settings.skills.bundleSkillCount': '{count} skills',
  'settings.skills.enableBundleTitle': '启用技能包',
  'settings.skills.disableBundleTitle': '关闭技能包',
  'settings.skills.enableBundleAriaLabel': '启用 {name}',
  'settings.skills.disableBundleAriaLabel': '关闭 {name}',
  'settings.skills.renameBundleTitle': '重命名技能包',
  'settings.skills.renameBundleAriaLabel': '重命名 {name}',
  'settings.skills.exportBundleTitle': '导出技能包',
  'settings.skills.exportBundleAriaLabel': '导出 {name}',
  'settings.skills.dissolveBundleTitle': '打散技能包',
  'settings.skills.dissolveBundleAriaLabel': '打散 {name}',
  'settings.skills.emptyBundle': '空技能包',
  'settings.skills.skillNotFound': '这个技能已不存在',
  'settings.skills.removeFromBundleTitle': '移出技能包',
  'settings.skills.removeFromBundleAriaLabel': '将 {name} 移出技能包',
  'settings.skills.noLooseSkills': '没有散装技能',
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

interface SkillBundleTreeProps {
  mode: TreeMode;
  bundles: SkillBundleInfo[];
  skills: SkillInfo[];
  nameHints: Record<string, string>;
  emptyText: string;
  onDeleteSkill?: (name: string) => void;
  onToggleSkill?: (name: string, enabled: boolean) => void;
  onToggleBundle?: (bundle: SkillBundleInfo, enabled: boolean) => void;
  onCreateBundle?: () => void;
  onRenameBundle?: (bundle: SkillBundleInfo) => void;
  onExportBundle?: (bundle: SkillBundleInfo) => void;
  onDeleteBundle?: (bundle: SkillBundleInfo) => void;
  onReorderBundles?: (bundleIds: string[]) => void;
  onMoveSkillToBundle?: (skillName: string, bundle: SkillBundleInfo, index?: number) => void;
  onRemoveSkillFromBundles?: (skillName: string) => void;
  highlightedSkillName?: string | null;
  highlightedBundleId?: string | null;
  expandedState?: Record<string, boolean>;
  onExpandedStateChange?: (next: Record<string, boolean>) => void;
}

function skillDragType() {
  return 'application/x-codia-skill-name';
}

function bundleDragType() {
  return 'application/x-codia-skill-bundle-id';
}

function startSkillDrag(event: React.DragEvent<HTMLDivElement>, skillName: string) {
  event.dataTransfer.setData(skillDragType(), skillName);
  event.dataTransfer.effectAllowed = 'move';
}

function startBundleDrag(event: React.DragEvent<HTMLDivElement>, bundleId: string) {
  event.dataTransfer.setData(bundleDragType(), bundleId);
  event.dataTransfer.effectAllowed = 'move';
}

function skillFromDrop(event: React.DragEvent) {
  return event.dataTransfer.getData(skillDragType()).trim();
}

function bundleFromDrop(event: React.DragEvent) {
  return event.dataTransfer.getData(bundleDragType()).trim();
}

function bundleEnabledState(bundle: SkillBundleInfo, skillByName: Map<string, SkillInfo>) {
  const skillNames = bundle.skillNames.filter(name => skillByName.has(name));
  if (skillNames.length === 0) return { all: false, partial: false, next: true };
  const enabled = skillNames.filter(name => skillByName.get(name)?.enabled).length;
  return {
    all: enabled === skillNames.length,
    partial: enabled > 0 && enabled < skillNames.length,
    next: enabled !== skillNames.length,
  };
}

function RemoveFromBundleIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14 4 9l5-5" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

export function SkillBundleTree({
  mode,
  bundles,
  skills,
  nameHints,
  emptyText,
  onDeleteSkill,
  onToggleSkill,
  onToggleBundle,
  onCreateBundle,
  onRenameBundle,
  onExportBundle,
  onDeleteBundle,
  onReorderBundles,
  onMoveSkillToBundle,
  onRemoveSkillFromBundles,
  highlightedSkillName = null,
  highlightedBundleId = null,
  expandedState,
  onExpandedStateChange,
}: SkillBundleTreeProps) {
  const [internalExpanded, setInternalExpanded] = useState<Record<string, boolean>>({});
  const expanded = expandedState ?? internalExpanded;
  const setBundleExpanded = useCallback((bundleId: string, nextExpanded: boolean) => {
    const next = { ...expanded, [bundleId]: nextExpanded };
    if (expandedState) {
      onExpandedStateChange?.(next);
    } else {
      setInternalExpanded(next);
    }
  }, [expanded, expandedState, onExpandedStateChange]);
  const skillByName = useMemo(() => new Map(skills.map(skill => [skill.name, skill])), [skills]);
  const bundledNames = useMemo(() => new Set(bundles.flatMap(bundle => bundle.skillNames)), [bundles]);
  const looseSkills = skills.filter(skill => !bundledNames.has(skill.name));
  const hasItems = bundles.length > 0 || looseSkills.length > 0;
  const canEditBundles = mode === 'manage';
  const canOrganize = canEditBundles || !!onMoveSkillToBundle || !!onRemoveSkillFromBundles || !!onReorderBundles;
  const canReorderBundles = canOrganize && !!onReorderBundles;

  const moveBundleBefore = (draggedId: string, targetId: string) => {
    if (!canReorderBundles || draggedId === targetId) return;
    const ids = bundles.map(bundle => bundle.id);
    const next = ids.filter(id => id !== draggedId);
    const targetIndex = next.indexOf(targetId);
    if (targetIndex === -1) return;
    next.splice(targetIndex, 0, draggedId);
    onReorderBundles?.(next);
  };

  const moveBundleToEnd = (draggedId: string) => {
    if (!canReorderBundles) return;
    const ids = bundles.map(bundle => bundle.id);
    if (ids[ids.length - 1] === draggedId) return;
    onReorderBundles?.([...ids.filter(id => id !== draggedId), draggedId]);
  };

  const markSkillDropTarget = (event: React.DragEvent<HTMLElement>) => {
    if (!canOrganize) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    (event.currentTarget as HTMLElement).classList.add(styles['drag-over']);
  };

  const clearSkillDropTarget = (event: React.DragEvent<HTMLElement>) => {
    (event.currentTarget as HTMLElement).classList.remove(styles['drag-over']);
  };

  const dropOnBundle = (event: React.DragEvent, bundle: SkillBundleInfo, index?: number) => {
    if (!canOrganize) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).classList.remove(styles['drag-over']);
    const skillName = skillFromDrop(event);
    if (skillName) onMoveSkillToBundle?.(skillName, bundle, index);
  };

  const dropOnBundleHeader = (event: React.DragEvent, bundle: SkillBundleInfo) => {
    if (!canOrganize) return;
    event.preventDefault();
    const draggedBundleId = bundleFromDrop(event);
    if (draggedBundleId && canReorderBundles) {
      moveBundleBefore(draggedBundleId, bundle.id);
      return;
    }
    dropOnBundle(event, bundle);
  };

  const dropOnLoose = (event: React.DragEvent) => {
    if (!canOrganize) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).classList.remove(styles['drag-over']);
    const draggedBundleId = bundleFromDrop(event);
    if (draggedBundleId && canReorderBundles) {
      moveBundleToEnd(draggedBundleId);
      return;
    }
    const skillName = skillFromDrop(event);
    if (skillName) onRemoveSkillFromBundles?.(skillName);
  };

  if (!hasItems) {
    return (
      <div className={styles['skill-bundle-tree']}>
        {canEditBundles && onCreateBundle ? (
          <button
            className={styles['skill-bundle-create']}
            type="button"
            title={tr('settings.skills.createBundleTitle')}
            aria-label={tr('settings.skills.createBundleAriaLabel')}
            onClick={onCreateBundle}
          >
            {tr('settings.skills.createBundleBtn')}
          </button>
        ) : null}
        <p className={styles['agent-skill-empty']} style={{ padding: 'var(--space-md)', margin: 0 }}>
          {emptyText}
        </p>
      </div>
    );
  }

  return (
    <div className={styles['skill-bundle-tree']}>
      {canEditBundles && onCreateBundle ? (
        <div className={styles['skill-bundle-toolbar']}>
          <button
            className={styles['skill-bundle-create']}
            type="button"
            title={tr('settings.skills.createBundleTitle')}
            aria-label={tr('settings.skills.createBundleAriaLabel')}
            onClick={onCreateBundle}
          >
            {tr('settings.skills.createBundleBtn')}
          </button>
        </div>
      ) : null}

      <div className={styles['skills-list-block']}>
        {bundles.map((bundle) => {
          const isExpanded = expanded[bundle.id] !== false;
          const state = bundleEnabledState(bundle, skillByName);
          return (
            <div className={styles['skill-bundle-group']} key={bundle.id}>
              <div
                className={styles['skill-bundle-header']}
                data-testid={`skill-bundle-header-${bundle.id}`}
                data-highlighted={highlightedBundleId === bundle.id ? 'true' : undefined}
                data-highlighted-bundle={highlightedBundleId === bundle.id ? bundle.id : undefined}
                draggable={canReorderBundles}
                onDragStart={(event) => startBundleDrag(event, bundle.id)}
                onDragOver={(event) => { if (canOrganize) event.preventDefault(); }}
                onDrop={(event) => dropOnBundleHeader(event, bundle)}
              >
                <button
                  className={styles['skill-bundle-caret']}
                  type="button"
                  aria-label={isExpanded ? tr('settings.skills.collapseBundleAriaLabel') : tr('settings.skills.expandBundleAriaLabel')}
                  title={isExpanded ? tr('settings.skills.collapseBundleAriaLabel') : tr('settings.skills.expandBundleAriaLabel')}
                  onClick={() => setBundleExpanded(bundle.id, !isExpanded)}
                >
                  {isExpanded ? '-' : '+'}
                </button>
                <div className={styles['skill-bundle-title']}>
                  <span>{bundle.name}</span>
                  <small>{tr('settings.skills.bundleSkillCount', { count: String(bundle.skillNames.length) })}</small>
                </div>
                <div className={styles['skill-bundle-actions']}>
                  {mode === 'agent' && onToggleBundle ? (
                    <button
                      data-testid={`skill-bundle-toggle-${bundle.id}`}
                      className={`codia-toggle mini${state.all ? ' on' : ''}${state.partial ? ' bundle-mixed' : ''}`}
                      type="button"
                      title={state.next ? tr('settings.skills.enableBundleTitle') : tr('settings.skills.disableBundleTitle')}
                      aria-label={state.next
                        ? tr('settings.skills.enableBundleAriaLabel', { name: bundle.name })
                        : tr('settings.skills.disableBundleAriaLabel', { name: bundle.name })}
                      onClick={() => onToggleBundle(bundle, state.next)}
                    />
                  ) : null}
                  {canEditBundles && onRenameBundle ? (
                    <button
                      className={styles['skill-bundle-icon-button']}
                      type="button"
                      title={tr('settings.skills.renameBundleTitle')}
                      aria-label={tr('settings.skills.renameBundleAriaLabel', { name: bundle.name })}
                      onClick={() => onRenameBundle(bundle)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                  ) : null}
                  {canEditBundles && onExportBundle ? (
                    <button
                      className={styles['skill-bundle-icon-button']}
                      type="button"
                      title={tr('settings.skills.exportBundleTitle')}
                      aria-label={tr('settings.skills.exportBundleAriaLabel', { name: bundle.name })}
                      onClick={() => onExportBundle(bundle)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                  ) : null}
                  {canEditBundles && onDeleteBundle ? (
                    <button
                      className={`${styles['skill-bundle-icon-button']} ${styles['skill-bundle-disband-button']}`}
                      type="button"
                      title={tr('settings.skills.dissolveBundleTitle')}
                      aria-label={tr('settings.skills.dissolveBundleAriaLabel', { name: bundle.name })}
                      onClick={() => onDeleteBundle(bundle)}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  ) : null}
                </div>
              </div>
              {isExpanded ? (
                <div
                  className={styles['skill-bundle-children']}
                  data-testid={`skill-bundle-drop-zone-${bundle.id}`}
                  onDragOver={markSkillDropTarget}
                  onDragLeave={clearSkillDropTarget}
                  onDrop={(event) => dropOnBundle(event, bundle)}
                >
                  {bundle.skillNames.length === 0 ? (
                    <div className={styles['skill-bundle-empty']}>{tr('settings.skills.emptyBundle')}</div>
                  ) : bundle.skillNames.map((skillName, index) => {
                    const skill = skillByName.get(skillName) || {
                      name: skillName,
                      description: tr('settings.skills.skillNotFound'),
                      enabled: false,
                      source: 'missing',
                    };
                    return (
                      <SkillRow
                        key={`${bundle.id}:${skillName}`}
                        skill={skill}
                        nameHint={nameHints[skillName]}
                        deletable={canEditBundles}
                        draggable={canOrganize}
                        onDragStart={startSkillDrag}
                        onDelete={canEditBundles ? onDeleteSkill : undefined}
                        onToggle={mode === 'agent' ? onToggleSkill : undefined}
                        onDragOver={(event) => { if (canOrganize) event.preventDefault(); }}
                        onDrop={(event) => dropOnBundle(event, bundle, index)}
                        className={styles['skill-bundle-child-row']}
                        highlighted={highlightedSkillName === skillName}
                        extraActions={canEditBundles ? (
                          <button
                            className={`${styles['skill-bundle-icon-button']} ${styles['skill-bundle-remove-button']}`}
                            type="button"
                            title={tr('settings.skills.removeFromBundleTitle')}
                            aria-label={tr('settings.skills.removeFromBundleAriaLabel', { name: skillName })}
                            onClick={(event) => {
                              event.stopPropagation();
                              onRemoveSkillFromBundles?.(skillName);
                            }}
                          >
                            <RemoveFromBundleIcon />
                          </button>
                        ) : null}
                      />
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}

        <div
          className={styles['skill-bundle-loose-zone']}
          onDragOver={markSkillDropTarget}
          onDragLeave={clearSkillDropTarget}
          onDrop={dropOnLoose}
        >
          {looseSkills.map(skill => (
            <SkillRow
              key={skill.name}
              skill={skill}
              nameHint={nameHints[skill.name]}
              deletable={canEditBundles}
              draggable={canOrganize}
              onDragStart={startSkillDrag}
              onDelete={canEditBundles ? onDeleteSkill : undefined}
              onToggle={mode === 'agent' ? onToggleSkill : undefined}
              highlighted={highlightedSkillName === skill.name}
            />
          ))}
          {looseSkills.length === 0 ? (
            <div className={styles['skill-bundle-empty']}>{tr('settings.skills.noLooseSkills')}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
