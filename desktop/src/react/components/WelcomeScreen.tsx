import type { QuickActionId } from '../../../../shared/quick-actions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Flower, Lightbulb, Code, Heart, ArrowRight } from '@phosphor-icons/react';
import { useStore } from '../stores';
import { codiaFetch } from '../hooks/use-codia-fetch';
import { useI18n } from '../hooks/use-i18n';
import { loadModels } from '../utils/ui-helpers';
import {
  activateWorkspaceDesk,
  addWorkspaceFolder,
  applyFolder,
  applyStudioWorkspace,
  createLocalStudioWorkspaceFromFolder,
  loadStudioWorkspaces,
  removeRecentWorkspace,
  removeStudioWorkspace,
  removeWorkspaceFolder,
} from '../stores/desk-actions';
import type { Agent, StudioWorkspace } from '../types';
import { AgentAvatar, refreshAgentAvatarVersion, resolveAgentDisplayInfo, type AgentDisplayInfo } from '../utils/agent-display';
import styles from './Welcome.module.css';
import { buildWorkspacePickerItems, normalizeWorkspacePath } from '../../../../shared/workspace-history.ts';
import { switchTab } from './channels/tab-router';
import { requestInputDraft } from '../utils/input-draft-events';
import { getDesktopApi } from '../utils/desktop-api';
import { resolveCodiaLive2DAssets } from '../live2d/assets';
import { CodiaLive2DMascot } from './CodiaLive2DMascot';

/* eslint-disable @typescript-eslint/no-explicit-any -- store callbacks and extended agent metadata */

type WelcomeAgent = Agent & {
  homeFolder?: string | null;
  chatModel?: {
    id?: string | null;
    provider?: string | null;
  } | null;
};

export function refreshAvatarTs() { refreshAgentAvatarVersion(); }

export function WelcomeScreen(_props: { enableSettings?: boolean } = {}) {
  return <WelcomeInner />;
}

function WelcomeInner() {
  const { t } = useI18n();
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const agents = useStore(s => s.agents);
  const agentName = useStore(s => s.agentName);
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const agentYuan = useStore(s => s.agentYuan);
  const currentAgentId = useStore(s => s.currentAgentId);
  const selectedAgentId = useStore(s => s.selectedAgentId);
  const memoryEnabled = useStore(s => s.memoryEnabled);
  const activeMemoryMasterEnabled = useStore(s => s.memoryMasterEnabled);
  const selectedFolder = useStore(s => s.selectedFolder);
  const selectedWorkspaceMountId = useStore(s => s.selectedWorkspaceMountId);
  const selectedWorkspaceLabel = useStore(s => s.selectedWorkspaceLabel);
  const studioWorkspaces = useStore(s => s.studioWorkspaces);
  const homeFolder = useStore(s => s.homeFolder);
  const workspaceFolders = useStore(s => s.workspaceFolders);
  const cwdHistory = useStore(s => s.cwdHistory);
  const serverPort = useStore(s => s.serverPort);
  const live2DAssets = useMemo(() => resolveCodiaLive2DAssets(window.location.href, serverPort ? Number(serverPort) : null), [serverPort]);
  const [gpuRuntime, setGpuRuntime] = useState<{ gpuSafeMode: boolean; hardwareAccelerationEnabled: boolean } | null>(() => (
    getDesktopApi()?.getGpuRuntimeState ? null : { gpuSafeMode: false, hardwareAccelerationEnabled: true }
  ));

  const [gpuPolicyError, setGpuPolicyError] = useState(false);
  const [gpuPolicyAttempt, setGpuPolicyAttempt] = useState(0);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api?.getGpuRuntimeState) return;
    let active = true;
    setGpuPolicyError(false);
    void (async () => {
      try {
        const state = await api.getGpuRuntimeState!();
        if (typeof state?.gpuSafeMode !== 'boolean' || typeof state?.hardwareAccelerationEnabled !== 'boolean') {
          throw new Error('Desktop GPU policy unavailable');
        }
        if (active) setGpuRuntime(state);
      } catch {
        // Do not guess the desktop policy or silently substitute a static image.
        if (active) setGpuPolicyError(true);
      }
    })();
    return () => { active = false; };
  }, [gpuPolicyAttempt]);

  const prefillPrompt = useCallback((prompt: string) => {
    const state = useStore.getState();
    if (state.currentTab !== 'chat') switchTab('chat');
    state.setDraft(state.currentSessionPath || '__new', prompt);
    requestInputDraft({ text: prompt, mode: 'replace', focus: true, source: 'welcome-quick-action' });
    state.requestInputFocus();
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.input-area:not(.hidden)')?.scrollIntoView({ block: 'end' });
    });
  }, []);
  const selectQuickAction = useCallback((quickAction: QuickActionId) => {
    requestInputDraft({ quickAction, focus: true, source: 'welcome-quick-action' });
  }, []);
  const startCodeTask = useCallback(async () => {
    if (!selectedFolder && !selectedWorkspaceMountId) {
      const folder = await window.platform?.selectFolder?.();
      if (folder) await applyFolder(folder);
    }
    selectQuickAction('code');
  }, [selectQuickAction, selectedFolder, selectedWorkspaceMountId]);
  const openWorkflow = useCallback(() => {
    selectQuickAction('workflow');
  }, [selectQuickAction]);

  const displayAgent = useMemo(() => {
    const selected = selectedAgentId || currentAgentId;
    return agents.find(agent => agent.id === selected) || null;
  }, [agents, selectedAgentId, currentAgentId]);
  const memoryMasterEnabled = displayAgent
    ? displayAgent.memoryMasterEnabled !== false
    : activeMemoryMasterEnabled !== false;
  if (!welcomeVisible) return null;

  return (
    <div className={styles.welcome}>
      <div className={styles.codiaHeroStage}>
        <section className={styles.codiaHero} aria-label="Codia 小豆蔻">
          <div className={styles.codiaHeroCopy}>
            <div className={styles.codiaEyebrow}>YOUR AI COMPANION · CODIA</div>
            <h2>嗨，我是小豆蔻 <Flower weight="fill" aria-hidden="true" /></h2>
            <p>可以帮你写代码、整理灵感，也可以一起把复杂任务拆成小步骤。</p>
            <button type="button" onClick={() => prefillPrompt('你好小豆蔻，我想开始一段新的对话。')}>开始一段对话 <ArrowRight weight="bold" /></button>
          </div>
          <div className={styles.codiaHeroArt}>
            <CodiaLive2DMascot
              className={styles.codiaLive2D}
              assets={live2DAssets}
              enabled={gpuRuntime !== null}
              gpuSafeMode={gpuRuntime?.gpuSafeMode}
              hardwareAccelerationEnabled={gpuRuntime?.hardwareAccelerationEnabled}
            />
            {gpuPolicyError && <div role="alert">
              <p>无法读取桌面图形状态，Live2D 尚未启动。请重试。</p>
              <button type="button" onClick={() => { setGpuPolicyError(false); setGpuPolicyAttempt(value => value + 1); }}>重试读取图形状态</button>
            </div>}
          </div>
        </section>
      </div>
      <div className={styles.codiaActionDock}>
        <section className={styles.codiaQuickSection} aria-label="快捷任务">
          <h3>给灵感一个小小入口</h3>
          <div className={styles.codiaQuickGrid}>
            <button type="button" onClick={() => selectQuickAction('ideas')}><span className={styles.codiaQuickIcon}><Lightbulb weight="fill" /></span><span className={styles.codiaQuickCopy}><strong>整理我的想法</strong><small>把零散灵感变成清晰计划</small></span></button>
            <button type="button" onClick={() => void startCodeTask()}><span className={styles.codiaQuickIcon}><Code weight="bold" /></span><span className={styles.codiaQuickCopy}><strong>开始编程协作</strong><small>一起理解、编写和检查代码</small></span></button>
            <button type="button" onClick={() => void openWorkflow()}><span className={styles.codiaQuickIcon}><Flower weight="fill" /></span><span className={styles.codiaQuickCopy}><strong>搭建一个工作流</strong><small>把重复任务交给自动化</small></span></button>
            <button type="button" onClick={() => selectQuickAction('agents')}><span className={styles.codiaQuickIcon}><Heart weight="fill" /></span><span className={styles.codiaQuickCopy}><strong>问问我的 Agent</strong><small>叫上擅长不同事情的伙伴</small></span></button>
          </div>
        </section>
        {agents.length >= 2 && (
          <AgentChips
            agents={agents}
            selectedId={selectedAgentId || currentAgentId}
          />
        )}
        <div className={styles.codiaContextControls}>
          <FolderPicker
            agents={agents}
            currentAgentId={currentAgentId}
            selectedFolder={selectedFolder}
            selectedWorkspaceMountId={selectedWorkspaceMountId}
            selectedWorkspaceLabel={selectedWorkspaceLabel}
            studioWorkspaces={studioWorkspaces}
            homeFolder={homeFolder}
            workspaceFolders={workspaceFolders}
            cwdHistory={cwdHistory}
          />
          <MemoryToggle enabled={memoryEnabled} masterEnabled={memoryMasterEnabled} t={t} />
        </div>
      </div>
    </div>
  );
}

function getFolderDisplayName(folder: string): string {
  const normalized = normalizeWorkspacePath(folder) || folder;
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function AgentChips({ agents, selectedId }: {
  agents: Agent[];
  selectedId: string | null;
}) {
  const visibleAgents = useMemo(() => agents.filter(agent => !isHermesAgent(agent)), [agents]);
  const handleClick = useCallback((agentId: string) => {
    const agent = agents.find(item => item.id === agentId) as WelcomeAgent | undefined;
    useStore.setState({ selectedAgentId: agentId });
    const homeFolder = normalizeAgentHomeFolder(agent);
    if (homeFolder) {
      useStore.setState({
        selectedFolder: homeFolder,
        selectedWorkspaceMountId: null,
        selectedWorkspaceLabel: null,
        workspaceFolders: [],
      });
      void activateWorkspaceDesk(homeFolder, { mountId: null });
    }
    if (agent?.chatModel?.id && agent.chatModel.provider) {
      void codiaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: agent.chatModel.id, provider: agent.chatModel.provider }),
      }).then(() => loadModels()).catch(() => {});
    }
  }, [agents]);

  return (
    <div className={styles.welcomeAgentSelector}>
      {visibleAgents.map(agent => (
        <AgentChip
          key={agent.id}
          agent={agent}
          isSelected={agent.id === selectedId}
          onClick={handleClick}
        />
      ))}
    </div>
  );
}

function isHermesAgent(agent: Agent) {
  const id = String(agent.id || '').toLowerCase();
  const name = String(agent.name || '').toLowerCase();
  const yuan = String(agent.yuan || '').toLowerCase();
  return yuan === 'hermes' || id.includes('hermes') || name.includes('hermes');
}

function AgentChip({ agent, isSelected, onClick }: {
  agent: Agent;
  isSelected: boolean;
  onClick: (id: string) => void;
}) {
  const handleClick = useCallback(() => {
    onClick(agent.id);
  }, [agent.id, onClick]);
  const info = resolveAgentDisplayInfo({
    id: agent.id,
    agents: [agent],
    fallbackAgentName: agent.name,
    fallbackAgentYuan: agent.yuan,
  });

  return (
    <button
      type="button"
      className={`${styles.welcomeAgentChip}${isSelected ? ` ${styles.welcomeAgentChipSelected}` : ''}`}
      onClick={handleClick}
    >
      <AgentAvatar
        info={info}
        className={styles.welcomeAgentChipAvatar}
      />
      <span>{agent.name}</span>
    </button>
  );
}

function FolderPicker({
  agents,
  currentAgentId,
  selectedFolder,
  selectedWorkspaceMountId,
  selectedWorkspaceLabel,
  studioWorkspaces,
  homeFolder,
  workspaceFolders,
  cwdHistory,
}: {
  agents: Agent[];
  currentAgentId: string | null;
  selectedFolder: string | null;
  selectedWorkspaceMountId: string | null;
  selectedWorkspaceLabel: string | null;
  studioWorkspaces: StudioWorkspace[];
  homeFolder: string | null;
  workspaceFolders: string[];
  cwdHistory: string[];
}) {
  const { t } = useI18n();
  const [showHistory, setShowHistory] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const agentHomeFolders = useMemo(() => collectAgentHomeFolders(agents), [agents]);

  useEffect(() => {
    void loadStudioWorkspaces();
  }, []);

  useEffect(() => {
    if (!showHistory) return;
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setShowHistory(false);
      }
    };
    const timer = setTimeout(() => document.addEventListener('click', close, true), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close, true);
    };
  }, [showHistory]);

  const handleBrowse = useCallback(async () => {
    setShowHistory(false);
    const folder = await window.platform?.selectFolder?.();
    if (!folder) return;
    const workspace = await createLocalStudioWorkspaceFromFolder(folder);
    if (workspace) {
      await applyStudioWorkspace(workspace);
    } else {
      void applyFolder(folder);
    }
  }, []);

  const handleAddWorkspaceFolder = useCallback(async () => {
    const folder = await window.platform?.selectFolder?.();
    if (!folder) return;
    addWorkspaceFolder(folder);
  }, []);

  const handleButtonClick = useCallback(() => {
    if (selectedWorkspaceMountId || selectedFolder || studioWorkspaces.length > 0 || cwdHistory.length > 0 || workspaceFolders.length > 0 || agentHomeFolders.length > 0) {
      setShowHistory(prev => !prev);
    } else {
      void handleBrowse();
    }
  }, [agentHomeFolders.length, cwdHistory.length, handleBrowse, selectedFolder, selectedWorkspaceMountId, studioWorkspaces.length, workspaceFolders.length]);

  const handleSelectWorkspace = useCallback((workspace: StudioWorkspace) => {
    setShowHistory(false);
    void applyStudioWorkspace(workspace);
  }, []);

  const handleRemoveWorkspace = useCallback((mountId: string) => {
    void removeStudioWorkspace(mountId);
  }, []);

  const handleSelectHistory = useCallback((folder: string) => {
    setShowHistory(false);
    const agent = findAgentByHomeFolder(agents, folder);
    if (agent) {
      const agentHomeFolder = normalizeAgentHomeFolder(agent) || folder;
      useStore.setState({
        selectedAgentId: agent.id === currentAgentId ? null : agent.id,
        selectedFolder: agentHomeFolder,
        selectedWorkspaceMountId: null,
        selectedWorkspaceLabel: null,
        workspaceFolders: [],
      });
      void activateWorkspaceDesk(agentHomeFolder, { mountId: null });
      if (agent.chatModel?.id && agent.chatModel.provider) {
        void codiaFetch('/api/models/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: agent.chatModel.id, provider: agent.chatModel.provider }),
        }).then(() => loadModels()).catch(() => {});
      }
      return;
    }
    void applyFolder(folder);
  }, [agents, currentAgentId]);

  const selectedWorkspace = selectedWorkspaceMountId
    ? studioWorkspaces.find(workspace => workspace.mountId === selectedWorkspaceMountId) || null
    : null;
  const folderPath = selectedFolder ? normalizeWorkspacePath(selectedFolder) || selectedFolder : null;
  const folderName = folderPath ? getFolderDisplayName(folderPath) : null;
  const workspaceName = selectedWorkspaceMountId
    ? (selectedWorkspaceLabel || selectedWorkspace?.label || selectedWorkspaceMountId)
    : null;
  const targetName = workspaceName || folderName;
  const label = targetName
    ? `${t('input.workspace')}${targetName}`
    : t('input.selectWorkspace');

  return (
    <div className={styles.workspaceControls}>
      <div
        className={`${styles.folderSelectWrap}${showHistory ? ` ${styles.folderSelectWrapShowHistory}` : ''}`}
        ref={wrapRef}
      >
      <button
        type="button"
        className={`${styles.folderSelectBtn}${(selectedFolder || selectedWorkspaceMountId) ? ` ${styles.folderSelectBtnHasFolder}` : ''}`}
        onClick={handleButtonClick}
        title={folderPath || selectedWorkspaceMountId ? `点击更换工作空间：${folderPath || selectedWorkspaceLabel || selectedWorkspaceMountId}` : t('input.selectWorkspace')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span>{label}</span>
        <svg className={styles.folderSwapIcon} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="17 1 21 5 17 9"></polyline>
          <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
          <polyline points="7 23 3 19 7 15"></polyline>
          <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
        </svg>
      </button>
      {showHistory && (
        <FolderHistory
          cwdHistory={cwdHistory}
          agentHomeFolders={agentHomeFolders}
          selectedFolder={selectedFolder}
          selectedWorkspaceMountId={selectedWorkspaceMountId}
          studioWorkspaces={studioWorkspaces}
          homeFolder={homeFolder}
          workspaceFolders={workspaceFolders}
          onSelectWorkspace={handleSelectWorkspace}
          onSelect={handleSelectHistory}
          onBrowse={handleBrowse}
          onAddWorkspaceFolder={handleAddWorkspaceFolder}
          onRemoveRecentWorkspace={removeRecentWorkspace}
          onRemoveStudioWorkspace={handleRemoveWorkspace}
          onRemoveWorkspaceFolder={removeWorkspaceFolder}
        />
      )}
      </div>
    </div>
  );
}

function FolderHistory({
  cwdHistory,
  agentHomeFolders,
  selectedFolder,
  selectedWorkspaceMountId,
  studioWorkspaces,
  homeFolder,
  workspaceFolders,
  onSelectWorkspace,
  onSelect,
  onBrowse,
  onAddWorkspaceFolder,
  onRemoveRecentWorkspace,
  onRemoveStudioWorkspace,
  onRemoveWorkspaceFolder,
}: {
  cwdHistory: string[];
  agentHomeFolders: string[];
  selectedFolder: string | null;
  selectedWorkspaceMountId: string | null;
  studioWorkspaces: StudioWorkspace[];
  homeFolder: string | null;
  workspaceFolders: string[];
  onSelectWorkspace: (workspace: StudioWorkspace) => void;
  onSelect: (folder: string) => void;
  onBrowse: () => void;
  onAddWorkspaceFolder: () => void;
  onRemoveRecentWorkspace: (folder: string) => void;
  onRemoveStudioWorkspace: (mountId: string) => void;
  onRemoveWorkspaceFolder: (folder: string) => void;
}) {
  const primaryItems: string[] = buildWorkspacePickerItems({
    selectedFolder,
    homeFolder,
    cwdHistory: [...agentHomeFolders, ...cwdHistory],
  });
  const primaryItemCount = studioWorkspaces.length + primaryItems.length;
  const primaryScrollable = primaryItemCount > 5;
  const extraScrollable = workspaceFolders.length > 5;
  const removableHistory = new Set(cwdHistory.map(normalizeWorkspacePath).filter(Boolean));
  const t = window.t ?? ((p: string) => p);
  return (
    <div className={styles.folderHistory}>
      <div className={styles.folderHistorySectionLabel}>
        {t('input.currentWorkspace')}
      </div>
      <div
        className={`${styles.folderHistoryList}${primaryScrollable ? ` ${styles.folderHistoryListScrollable}` : ''}`}
        data-folder-history-list="primary"
        data-scrollable={primaryScrollable ? 'true' : 'false'}
      >
        {studioWorkspaces.map(workspace => {
          const isActive = workspace.mountId === selectedWorkspaceMountId;
          return (
            <div
              key={`studio:${workspace.mountId}`}
              className={`${styles.folderHistoryItem}${isActive ? ` ${styles.folderHistoryItemActive}` : ''}`}
              title={workspace.label}
              onClick={(event) => { event.stopPropagation(); onSelectWorkspace(workspace); }}
            >
              <span className={styles.folderHistoryItemIcon}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
              </span>
              <span className={styles.folderHistoryItemName}>{workspace.label}</span>
              {!workspace.isDefault && (
                <button
                  type="button"
                  className={styles.folderHistoryRemove}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveStudioWorkspace(workspace.mountId);
                  }}
                  title={t('input.removeStudioWorkspace')}
                  aria-label={t('input.removeStudioWorkspace')}
                >
                  x
                </button>
              )}
            </div>
          );
        })}
        {primaryItems.map(path => {
          const name = getFolderDisplayName(path);
          const isActive = path === selectedFolder;
          return (
            <div
              key={path}
              className={`${styles.folderHistoryItem}${isActive ? ` ${styles.folderHistoryItemActive}` : ''}`}
              title={path}
              onClick={(event) => { event.stopPropagation(); onSelect(path); }}
            >
              <span className={styles.folderHistoryItemIcon}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
              </span>
              <span className={styles.folderHistoryItemName}>{name}</span>
              {removableHistory.has(normalizeWorkspacePath(path)) && (
                <button
                  type="button"
                  className={styles.folderHistoryRemove}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveRecentWorkspace(path);
                  }}
                  title={t('input.removeRecentWorkspace')}
                  aria-label={t('input.removeRecentWorkspace')}
                >
                  x
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.folderHistoryDivider} />
      <div className={styles.folderHistoryBrowse} onClick={(event) => { event.stopPropagation(); onBrowse(); }}>
        <span className={styles.folderHistoryItemIcon}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            <line x1="12" y1="11" x2="12" y2="17"></line>
            <line x1="9" y1="14" x2="15" y2="14"></line>
          </svg>
        </span>
        <span>{t('input.selectOtherFolder')}</span>
      </div>
      <div className={styles.folderHistoryDivider} />
      <div className={styles.folderHistorySectionLabel}>
        {t('input.extraFolders')}
      </div>
      <div
        className={`${styles.folderHistoryList}${extraScrollable ? ` ${styles.folderHistoryListScrollable}` : ''}`}
        data-folder-history-list="extra"
        data-scrollable={extraScrollable ? 'true' : 'false'}
      >
        {workspaceFolders.map(path => {
          const name = getFolderDisplayName(path);
          return (
            <div
              key={path}
              className={styles.folderHistoryItem}
              title={path}
              onClick={(event) => { event.stopPropagation(); }}
            >
              <span className={styles.folderHistoryItemIcon}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
              </span>
              <span className={styles.folderHistoryItemName}>{name}</span>
              <button
                type="button"
                className={styles.folderHistoryRemove}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveWorkspaceFolder(path);
                }}
                title={t('common.remove')}
              >
                x
              </button>
            </div>
          );
        })}
      </div>
      <div className={styles.folderHistoryBrowse} onClick={(event) => { event.stopPropagation(); onAddWorkspaceFolder(); }}>
        <span className={styles.folderHistoryItemIcon}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14"></path>
            <path d="M5 12h14"></path>
          </svg>
        </span>
        <span>{t('input.addExternalFolder')}</span>
      </div>
    </div>
  );
}

function collectAgentHomeFolders(agents: Agent[]): string[] {
  const folders: string[] = [];
  for (const agent of agents as WelcomeAgent[]) {
    const folder = normalizeAgentHomeFolder(agent);
    if (folder && !folders.includes(folder)) folders.push(folder);
  }
  return folders;
}

function findAgentByHomeFolder(agents: Agent[], folder: string): WelcomeAgent | null {
  const normalized = normalizeWorkspacePath(folder);
  if (!normalized) return null;
  return (agents as WelcomeAgent[]).find(agent => normalizeAgentHomeFolder(agent) === normalized) || null;
}

function normalizeAgentHomeFolder(agent: WelcomeAgent | null | undefined): string | null {
  return normalizeWorkspacePath(agent?.homeFolder);
}

function MemoryToggle({ enabled, masterEnabled, t }: {
  enabled: boolean;
  masterEnabled: boolean;
  t: (key: string) => string;
}) {
  const handleClick = useCallback(() => {
    useStore.setState((state: any) => ({ memoryEnabled: !state.memoryEnabled }));
  }, []);
  const disabled = !masterEnabled;
  const label = disabled ? t('welcome.memoryDisabled') : t(enabled ? 'welcome.memoryOn' : 'welcome.memoryOff');

  return (
    <button
      type="button"
      className={`${styles.memoryToggleBtn}${enabled && !disabled ? ` ${styles.memoryToggleBtnActive}` : ''}${disabled ? ` ${styles.memoryToggleBtnDisabled}` : ''}`}
      onClick={handleClick}
      disabled={disabled}
      title={disabled ? t('welcome.memoryDisabled') : undefined}
    >
      <svg className={styles.memoryToggleIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2 L22 12 L12 22 L2 12 Z" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
