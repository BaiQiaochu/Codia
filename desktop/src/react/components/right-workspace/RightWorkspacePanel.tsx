import { useCallback, type CSSProperties } from 'react';
import { useStore } from '../../stores';
import type { RightWorkspaceTab } from '../../types';
import { DeskSection } from '../DeskSection';
import { DeskCwdSkillsButton, DeskCwdSkillsPanel } from '../desk/DeskCwdSkills';
import { JianEditor } from '../desk/DeskEditor';
import { PluginWidgetView } from '../plugin/PluginWidgetView';
import { SessionRegistryFilesPanel } from './SessionRegistryFilesPanel';
import { SessionResourceLibraryPanel } from './SessionResourceLibraryPanel';
import { SessionTodoCard } from './SessionTodoCard';
import { WorkflowCard } from './WorkflowCard';
import { AgentActivityCard } from './AgentActivityCard';
import { SessionStatusCard } from './SessionStatusCard';
import { WorkspaceFileWatchBridge } from './WorkspaceFileWatchBridge';
import { schedulePersistCurrentWorkspaceUiState } from '../../stores/workspace-ui-state-actions';
import styles from './RightWorkspacePanel.module.css';
import { workspaceDisplayName } from '../../../../../shared/workspace-history.ts';

interface RightWorkspaceTabDef {
  id: RightWorkspaceTab;
  labelKey: string;
}

const BASE_TABS: RightWorkspaceTabDef[] = [
  { id: 'session-files', labelKey: 'rightWorkspace.tabs.sessionFiles' },
  { id: 'session-library', labelKey: 'rightWorkspace.tabs.sessionLibrary' },
  { id: 'workspace', labelKey: 'rightWorkspace.tabs.workspace' },
];

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? <polyline points="6 9 12 15 18 9" /> : <polyline points="18 15 12 9 6 15" />}
    </svg>
  );
}

function JianDrawer() {
  const open = useStore(s => s.jianDrawerOpen);
  const t = window.t ?? ((p: string) => p);
  const label = t('desk.jianLabel');

  return (
    <section className={styles.jianDrawer} data-open={open ? 'true' : 'false'} role="region" aria-label={label}>
      <div className={styles.jianHeader}>
        <span className={styles.jianTitle}>{label}</span>
      </div>
      <div className={styles.jianBody}>
        <JianEditor showHeader={false} />
      </div>
    </section>
  );
}

function JianFloatingToggle() {
  const open = useStore(s => s.jianDrawerOpen);
  const setOpen = useStore(s => s.setJianDrawerOpen);
  const t = window.t ?? ((p: string) => p);
  const actionLabel = open ? t('rightWorkspace.jian.collapse') : t('rightWorkspace.jian.expand');
  const toggle = useCallback(() => {
    setOpen(!open);
    schedulePersistCurrentWorkspaceUiState();
  }, [open, setOpen]);

  return (
    <button
      className={styles.jianToggle}
      type="button"
      aria-label={actionLabel}
      aria-expanded={open}
      onClick={toggle}
    >
      <Chevron open={open} />
    </button>
  );
}

function TabContent({ activeTab }: { activeTab: RightWorkspaceTab }) {
  if (activeTab === 'session-files') return <SessionRegistryFilesPanel />;
  if (activeTab === 'session-library') return <SessionResourceLibraryPanel />;
  return <DeskSection framed={false} showHeader={false} rightWorkspaceLayout openFilesOnSingleClick />;
}

function WorkspaceHeader() {
  const deskBasePath = useStore(s => s.deskBasePath);
  const selectedFolder = useStore(s => s.selectedFolder);
  const homeFolder = useStore(s => s.homeFolder);
  const t = window.t ?? ((p: string) => p);
  const title = workspaceDisplayName(deskBasePath || selectedFolder || homeFolder, t('desk.title'));

  return (
    <>
      <div className={styles.workspaceHeader}>
        <div className={styles.workspaceTitle} title={deskBasePath || selectedFolder || homeFolder || undefined}>
          {title}
        </div>
        <DeskCwdSkillsButton />
      </div>
      <DeskCwdSkillsPanel />
    </>
  );
}

export function RightWorkspacePanel() {
  const rightWorkspaceTab = useStore(s => s.rightWorkspaceTab);
  const setRightWorkspaceTab = useStore(s => s.setRightWorkspaceTab);
  const jianView = useStore(s => s.jianView);
  const t = window.t ?? ((p: string) => p);
  const selectTab = useCallback((tab: RightWorkspaceTab) => {
    setRightWorkspaceTab(tab);
    schedulePersistCurrentWorkspaceUiState();
  }, [setRightWorkspaceTab]);

  if (jianView.startsWith('widget:')) {
    return (
      <div className={styles.shell}>
        <WorkspaceFileWatchBridge />
        <PluginWidgetView pluginId={jianView.slice(7)} />
      </div>
    );
  }

  const activeTab = BASE_TABS.some(tab => tab.id === rightWorkspaceTab)
    ? rightWorkspaceTab
    : 'workspace';
  const activeTabIndex = Math.max(0, BASE_TABS.findIndex(tab => tab.id === activeTab));
  const tabCount = BASE_TABS.length;
  const tabsStyle = {
    '--right-workspace-active-tab-index': `${activeTabIndex}`,
    '--right-workspace-tab-count': `${tabCount}`,
    '--right-workspace-tab-slider-width': `calc((100% - ${(tabCount + 1) * 2}px) / ${tabCount})`,
    '--right-workspace-tab-slider-offset': activeTabIndex === 0 ? '0px' : `calc(${activeTabIndex} * (100% + 2px))`,
  } as CSSProperties;

  return (
    <div className={styles.shell}>
      <WorkspaceFileWatchBridge />
      <div className={`universal-card jian-card ${styles.workspaceCard}`} data-right-workspace-card="">
        <WorkspaceHeader />
        <div className={styles.tabs} role="tablist" aria-label={t('rightWorkspace.tabs.label')} style={tabsStyle}>
          <div className={styles.tabSlider} data-right-workspace-tab-slider aria-hidden="true" />
          {BASE_TABS.map(tab => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={`${styles.tab}${selected ? ` ${styles.tabActive}` : ''}`}
                role="tab"
                aria-selected={selected}
                onClick={() => selectTab(tab.id)}
              >
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>
        <div className={styles.content} role="tabpanel">
          <TabContent activeTab={activeTab} />
        </div>
        <JianDrawer />
        <JianFloatingToggle />
      </div>
      <SessionTodoCard />
      <WorkflowCard />
      <AgentActivityCard />
      <SessionStatusCard />
    </div>
  );
}
