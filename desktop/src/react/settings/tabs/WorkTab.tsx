import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store';
import { t, autoSaveConfig } from '../helpers';
import { gsapFetch } from '../api';
import { getErrorMessage, type SettingsConfigPayload } from '../shared-types';
import { Toggle } from '../widgets/Toggle';
import { AgentSelect } from './bridge/AgentSelect';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { NumberInput } from '../components/NumberInput';
import styles from '../Settings.module.css';
import { DEFAULT_HEARTBEAT_INTERVAL_MINUTES } from '../../../../../shared/default-workspace-constants.ts';

const platform = window.platform;

type AgentDeskConfig = {
  home_folder: string;
  heartbeat_enabled: boolean;
  heartbeat_interval: number;
  workspace_context: {
    inject_agents_md: boolean;
    inject_claude_md: boolean;
  };
};

function deskFromConfig(config: SettingsConfigPayload | null | undefined): AgentDeskConfig {
  return {
    home_folder: config?.desk?.home_folder || '',
    heartbeat_enabled: config?.desk?.heartbeat_enabled !== false,
    heartbeat_interval: config?.desk?.heartbeat_interval ?? DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
    workspace_context: {
      inject_agents_md: config?.workspace_context?.inject_agents_md === true,
      inject_claude_md: config?.workspace_context?.inject_claude_md === true,
    },
  };
}

function agentDeskFromStoreForAgent(
  config: SettingsConfigPayload | null | undefined,
  selectedAgentId: string | null,
  settingsAgentId: string | null,
  currentAgentId: string | null,
): AgentDeskConfig | null {
  const configOwnerId = settingsAgentId || currentAgentId;
  if (!config || !selectedAgentId || configOwnerId !== selectedAgentId) return null;
  return deskFromConfig(config);
}

export function WorkTab() {
  const { settingsConfig, showToast, currentAgentId, settingsAgentId } = useSettingsStore();

  const heartbeatMaster = settingsConfig?.desk?.heartbeat_master !== false;
  const cronAutoApprove = settingsConfig?.desk?.cron_auto_approve !== false;

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(currentAgentId);
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  useEffect(() => {
    if (selectedAgentId) return;
    if (currentAgentId) setSelectedAgentId(currentAgentId);
  }, [currentAgentId, selectedAgentId]);

  const [agentDesk, setAgentDesk] = useState<AgentDeskConfig | null>(null);
  const [hbIntervalDraft, setHbIntervalDraft] = useState<number | null>(null);

  useEffect(() => {
    if (!selectedAgentId) {
      setAgentDesk(null);
      setHbIntervalDraft(null);
      return;
    }

    const storeDesk = agentDeskFromStoreForAgent(settingsConfig, selectedAgentId, settingsAgentId, currentAgentId);
    if (storeDesk) {
      setAgentDesk(storeDesk);
      setHbIntervalDraft(storeDesk.heartbeat_interval);
      return;
    }

    setAgentDesk(null);
    setHbIntervalDraft(null);

    const ac = new AbortController();
    gsapFetch(`/api/agents/${selectedAgentId}/config`, { signal: ac.signal })
      .then(r => r.json() as Promise<SettingsConfigPayload>)
      .then(data => {
        if (ac.signal.aborted) return;
        const desk = deskFromConfig(data);
        setAgentDesk(desk);
        setHbIntervalDraft(desk.heartbeat_interval);
      })
      .catch(err => {
        if (err?.name !== 'AbortError') console.warn('[work] fetch agent config failed:', err);
      });

    return () => ac.abort();
  }, [currentAgentId, selectedAgentId, settingsAgentId, settingsConfig]);

  const toggleHeartbeatMaster = async (on: boolean) => {
    await autoSaveConfig({ desk: { heartbeat_master: on } });
  };

  const toggleCronAutoApprove = async (on: boolean) => {
    await autoSaveConfig({ desk: { cron_auto_approve: on } });
  };

  const saveAgentConfig = async (patch: Record<string, unknown>) => {
    const agentId = selectedAgentIdRef.current;
    if (!agentId) return;
    try {
      const res = await gsapFetch(`/api/agents/${agentId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (selectedAgentIdRef.current === agentId) {
        showToast(t('settings.autoSaved'), 'success');
      }
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + getErrorMessage(err), 'error');
    }
  };

  const togglePerAgentHeartbeat = async (on: boolean) => {
    if (!agentDesk) return;
    setAgentDesk({ ...agentDesk, heartbeat_enabled: on });
    await saveAgentConfig({ desk: { heartbeat_enabled: on } });
  };

  const toggleWorkspaceContext = async (
    key: keyof AgentDeskConfig['workspace_context'],
    on: boolean,
  ) => {
    if (!agentDesk) return;
    setAgentDesk({
      ...agentDesk,
      workspace_context: {
        ...agentDesk.workspace_context,
        [key]: on,
      },
    });
    await saveAgentConfig({ workspace_context: { [key]: on } });
  };

  const pickHomeFolder = async () => {
    if (!agentDesk) return;
    const folder = await platform?.selectFolder?.();
    if (!folder) return;
    setAgentDesk({ ...agentDesk, home_folder: folder });
    await saveAgentConfig({ desk: { home_folder: folder } });
  };

  const clearHomeFolder = async () => {
    if (!agentDesk) return;
    setAgentDesk({ ...agentDesk, home_folder: '' });
    await saveAgentConfig({ desk: { home_folder: '' } });
  };

  const saveInterval = async () => {
    if (hbIntervalDraft == null || !agentDesk) return;
    const interval = Math.max(1, Math.min(120, hbIntervalDraft));
    setAgentDesk({ ...agentDesk, heartbeat_interval: interval });
    setHbIntervalDraft(interval);
    await saveAgentConfig({ desk: { heartbeat_interval: interval } });
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="work">
      <SettingsSection title={t('settings.work.title')}>
        <SettingsRow
          label={t('settings.work.heartbeatMaster')}
          hint={t('settings.work.heartbeatMasterDesc')}
          control={<Toggle on={heartbeatMaster} onChange={toggleHeartbeatMaster} />}
        />
        <SettingsRow
          label={t('settings.work.cronAutoApprove')}
          hint={t('settings.work.cronAutoApproveDesc')}
          control={<Toggle on={cronAutoApprove} onChange={toggleCronAutoApprove} />}
        />
      </SettingsSection>

      <SettingsSection
        title={t('settings.work.homeFolder')}
        context={<AgentSelect value={selectedAgentId} onChange={setSelectedAgentId} />}
      >
        {agentDesk && (
          <>
            <SettingsRow
              label={t('settings.work.heartbeatEnabled')}
              hint={t('settings.work.heartbeatOperationalNotice')}
              control={<Toggle on={agentDesk.heartbeat_enabled} onChange={togglePerAgentHeartbeat} />}
            />
            <SettingsRow
              label={t('settings.work.homeFolder')}
              hint={t('settings.work.homeFolderDesc')}
              layout="stacked"
              control={
                <div className={styles['settings-folder-picker']}>
                  <input
                    type="text"
                    className={`${styles['settings-input']} ${styles['settings-folder-input']}`}
                    readOnly
                    value={agentDesk.home_folder}
                    placeholder={t('settings.work.homeFolderPlaceholder')}
                    onClick={pickHomeFolder}
                  />
                  <button type="button" className={styles['settings-folder-browse']} onClick={pickHomeFolder}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                  {agentDesk.home_folder && (
                    <button type="button"
                      className={styles['settings-folder-clear']}
                      onClick={clearHomeFolder}
                      title={t('settings.work.homeFolderClear')}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              }
            />
            <SettingsRow
              label={t('settings.work.heartbeatInterval')}
              control={
                <>
                  <NumberInput
                    value={hbIntervalDraft ?? agentDesk.heartbeat_interval}
                    onChange={setHbIntervalDraft}
                    unit={t('settings.work.heartbeatUnit')}
                    min={1}
                    max={120}
                    disabled={!agentDesk.heartbeat_enabled}
                  />
                  <button type="button"
                    className={styles['settings-save-btn-ghost']}
                    onClick={saveInterval}
                    disabled={!agentDesk.heartbeat_enabled}
                  >
                    {t('settings.save')}
                  </button>
                </>
              }
            />
            <SettingsRow
              label={t('settings.work.injectAgentsMd')}
              hint={t('settings.work.injectAgentsMdDesc')}
              control={
                <Toggle
                  on={agentDesk.workspace_context.inject_agents_md}
                  onChange={(on) => toggleWorkspaceContext('inject_agents_md', on)}
                  label={t('settings.work.injectAgentsMd')}
                />
              }
            />
            <SettingsRow
              label={t('settings.work.injectClaudeMd')}
              hint={t('settings.work.injectClaudeMdDesc')}
              control={
                <Toggle
                  on={agentDesk.workspace_context.inject_claude_md}
                  onChange={(on) => toggleWorkspaceContext('inject_claude_md', on)}
                  label={t('settings.work.injectClaudeMd')}
                />
              }
            />
          </>
        )}
      </SettingsSection>
    </div>
  );
}
