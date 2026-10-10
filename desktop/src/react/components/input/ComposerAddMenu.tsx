import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  CaretRight,
  File,
  FolderOpen,
  LinkSimple,
  Plug,
  StarFour,
  Toolbox,
} from '@phosphor-icons/react';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import { useI18n } from '../../hooks/use-i18n';
import type { SlashItem } from './slash-commands';
import type { WorkspaceToolSelection } from '../../utils/workspace-tool-events';
import styles from './InputArea.module.css';

interface ComposerPlugin {
  id: string;
  name: string;
  description?: string;
  status?: string;
}

type AddMenuView = 'root' | 'skills' | 'plugins' | 'tools' | 'link';

interface ComposerAddMenuProps {
  skills: SlashItem[];
  workspaceTool: WorkspaceToolSelection | null;
  workspaceTools: readonly WorkspaceToolSelection[];
  onClose: () => void;
  onAttachFiles: () => void;
  onAttachFolder: () => void;
  onInsertLink: (url: string) => void;
  onSelectSkill: (skill: SlashItem) => void;
  onSelectPlugin: (plugin: ComposerPlugin) => void;
  onSelectTool: (tool: WorkspaceToolSelection | null) => void;
}

export function ComposerAddMenu({
  skills,
  workspaceTool,
  workspaceTools,
  onClose,
  onAttachFiles,
  onAttachFolder,
  onInsertLink,
  onSelectSkill,
  onSelectPlugin,
  onSelectTool,
}: ComposerAddMenuProps) {
  const { t } = useI18n();
  const [view, setView] = useState<AddMenuView>('root');
  const [plugins, setPlugins] = useState<ComposerPlugin[]>([]);
  const [pluginsBusy, setPluginsBusy] = useState(false);
  const [pluginsLoaded, setPluginsLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [linkValue, setLinkValue] = useState('');
  const linkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (view !== 'plugins' || pluginsLoaded) return;
    let cancelled = false;
    setPluginsBusy(true);
    codiaFetch('/api/plugins')
      .then(response => response.json())
      .then(data => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : [];
        setPlugins(list.filter((plugin): plugin is ComposerPlugin => (
          !!plugin && typeof plugin.id === 'string' && plugin.status === 'loaded'
        )));
      })
      .catch(() => {
        if (!cancelled) setPlugins([]);
      })
      .finally(() => {
        if (!cancelled) {
          setPluginsBusy(false);
          setPluginsLoaded(true);
        }
      });
    return () => { cancelled = true; };
  }, [pluginsLoaded, view]);

  useEffect(() => {
    if (view === 'link') linkRef.current?.focus();
  }, [view]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredSkills = useMemo(() => skills.filter(skill => (
    skill.type === 'skill'
    && (!normalizedQuery || `${skill.label} ${skill.description}`.toLocaleLowerCase().includes(normalizedQuery))
  )), [normalizedQuery, skills]);
  const filteredPlugins = useMemo(() => plugins.filter(plugin => (
    !normalizedQuery || `${plugin.name} ${plugin.id} ${plugin.description || ''}`.toLocaleLowerCase().includes(normalizedQuery)
  )), [normalizedQuery, plugins]);

  const openView = (next: AddMenuView) => {
    setQuery('');
    setView(next);
  };
  const runAndClose = (action: () => void) => {
    action();
    onClose();
  };

  if (view === 'root') {
    const skillCount = skills.filter(item => item.type === 'skill').length;
    return (
      <div className={styles['composer-add-menu']} role="menu" aria-label={t('input.add.title')}>
        <div className={styles['composer-add-section-label']}>{t('input.add.title')}</div>
        <MenuButton icon={<File />} title={t('input.add.file')} detail={t('input.add.fileDetail')} onClick={() => runAndClose(onAttachFiles)} />
        <MenuButton icon={<FolderOpen />} title={t('input.add.folder')} detail={t('input.add.folderDetail')} onClick={() => runAndClose(onAttachFolder)} />
        <MenuButton icon={<LinkSimple />} title={t('input.add.link')} detail={t('input.add.linkDetail')} onClick={() => openView('link')} nested />
        <div className={styles['composer-add-divider']} />
        <MenuButton icon={<Plug />} title={t('input.add.plugins')} detail={t('input.add.pluginsDetail')} onClick={() => openView('plugins')} nested />
        <MenuButton icon={<StarFour />} title={t('input.add.skills')} detail={t('input.add.skillCount').replace('{count}', String(skillCount))} onClick={() => openView('skills')} nested />
        <MenuButton icon={<Toolbox />} title={t('input.add.tools')} detail={workspaceTool?.title || t('input.add.toolsDetail')} onClick={() => openView('tools')} nested />
      </div>
    );
  }

  if (view === 'link') {
    const submitLink = () => {
      const value = linkValue.trim();
      if (!value) return;
      const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
      runAndClose(() => onInsertLink(normalized));
    };
    return (
      <div className={styles['composer-add-menu']} role="dialog" aria-label={t('input.add.addLink')}>
        <MenuHeader title={t('input.add.addLink')} backLabel={t('input.add.back')} onBack={() => openView('root')} />
        <form className={styles['composer-link-form']} onSubmit={event => { event.preventDefault(); submitLink(); }}>
          <input
            ref={linkRef}
            value={linkValue}
            onChange={event => setLinkValue(event.target.value)}
            placeholder="https://example.com"
            aria-label={t('input.add.linkAddress')}
          />
          <button type="submit" disabled={!linkValue.trim()}>{t('input.add.confirm')}</button>
        </form>
      </div>
    );
  }

  const isSearchable = view === 'skills' || view === 'plugins';
  return (
    <div className={styles['composer-add-menu']} role="dialog" aria-label={view === 'skills' ? t('input.add.selectSkills') : view === 'plugins' ? t('input.add.selectPlugins') : t('input.add.selectTools')}>
      <MenuHeader title={view === 'skills' ? t('input.add.skills') : view === 'plugins' ? t('input.add.plugins') : t('input.add.tools')} backLabel={t('input.add.back')} onBack={() => openView('root')} />
      {isSearchable && (
        <input
          className={styles['composer-add-search']}
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={view === 'skills' ? t('input.add.searchSkills') : t('input.add.searchPlugins')}
          aria-label={view === 'skills' ? t('input.add.searchSkills') : t('input.add.searchPlugins')}
          autoFocus
        />
      )}
      <div className={styles['composer-add-results']} role="listbox">
        {view === 'skills' && filteredSkills.map(skill => (
          <ResultButton
            key={skill.name}
            icon={<StarFour />}
            title={skill.name}
            detail={skill.description}
            onClick={() => runAndClose(() => onSelectSkill(skill))}
          />
        ))}
        {view === 'plugins' && filteredPlugins.map(plugin => (
          <ResultButton
            key={plugin.id}
            icon={<Plug />}
            title={plugin.name || plugin.id}
            detail={plugin.description || plugin.id}
            onClick={() => runAndClose(() => onSelectPlugin(plugin))}
          />
        ))}
        {view === 'tools' && (
          <>
            <ResultButton title={t('input.add.normalChat')} detail={t('input.add.normalChatDetail')} selected={!workspaceTool} onClick={() => runAndClose(() => onSelectTool(null))} />
            {workspaceTools.map(tool => (
              <ResultButton key={tool.id} icon={<Toolbox />} title={tool.title} detail={tool.description} selected={workspaceTool?.id === tool.id} onClick={() => runAndClose(() => onSelectTool(tool))} />
            ))}
          </>
        )}
        {view === 'plugins' && pluginsBusy && <div className={styles['composer-add-empty']}>{t('input.add.loadingPlugins')}</div>}
        {view === 'skills' && filteredSkills.length === 0 && <div className={styles['composer-add-empty']}>{t('input.add.noSkills')}</div>}
        {view === 'plugins' && !pluginsBusy && filteredPlugins.length === 0 && <div className={styles['composer-add-empty']}>{t('input.add.noPlugins')}</div>}
      </div>
    </div>
  );
}

function MenuHeader({ title, backLabel, onBack }: { title: string; backLabel: string; onBack: () => void }) {
  return (
    <div className={styles['composer-add-header']}>
      <button type="button" onClick={onBack} aria-label={backLabel}><ArrowLeft /></button>
      <strong>{title}</strong>
    </div>
  );
}

function MenuButton({ icon, title, detail, onClick, nested = false }: {
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
  nested?: boolean;
}) {
  return (
    <button type="button" className={styles['composer-add-item']} role="menuitem" onClick={onClick}>
      <span className={styles['composer-add-icon']}>{icon}</span>
      <span className={styles['composer-add-copy']}><strong>{title}</strong><small>{detail}</small></span>
      {nested && <CaretRight className={styles['composer-add-caret']} />}
    </button>
  );
}

function ResultButton({ icon, title, detail, onClick, selected = false }: {
  icon?: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
  selected?: boolean;
}) {
  return (
    <button type="button" role="option" aria-selected={selected} className={`${styles['composer-add-result']}${selected ? ` ${styles.selected}` : ''}`} onClick={onClick}>
      <span className={styles['composer-add-icon']}>{icon}</span>
      <span className={styles['composer-add-copy']}><strong>{title}</strong><small>{detail}</small></span>
    </button>
  );
}
