/**
 * Channel header with title, membership, and channel actions.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { addChannelMember, deleteChannel, removeChannelMember } from '../../stores/channel-actions';
import { toggleJianSidebar } from '../../stores/desk-actions';
import { ContextMenu } from '../ContextMenu';
import type { ContextMenuItem } from '../ContextMenu';
import { ChannelWorkflowWindow } from './ChannelWorkflowWindow';
import styles from './Channels.module.css';

function confirmDeleteChannel(channelId: string) {
  const ch = useStore.getState().channels.find((c) => c.id === channelId);
  const displayName = ch?.name || channelId;
  const msg = window.t('channel.deleteConfirm', { name: displayName }) || '';
  if (!confirm(msg)) return;
  deleteChannel(channelId);
}

export function ChannelHeader() {
  const { t } = useI18n();
  const headerName = useStore(s => s.channelHeaderName);
  const headerMembers = useStore(s => s.channelHeaderMembersText);
  const currentChannel = useStore(s => s.currentChannel);
  const isDM = useStore(s => s.channelIsDM);
  const agents = useStore(s => s.agents);
  const channelMembers = useStore(s => s.channelMembers);
  const addToast = useStore(s => s.addToast);
  const pendingChannelResourceAction = useStore(s => s.pendingChannelResourceAction);

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [menuItems, setMenuItems] = useState<ContextMenuItem[]>([]);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);

  const availableAgents = useMemo(
    () => agents.filter((agent) => agent?.id && !channelMembers.includes(agent.id)),
    [agents, channelMembers],
  );

  const channelMemberAgents = useMemo(
    () => channelMembers.map((memberId) => {
      const agent = agents.find((item) => item.id === memberId);
      return {
        id: memberId,
        name: agent?.name || memberId,
      };
    }),
    [agents, channelMembers],
  );

  const focusWorkspaceSection = useCallback((section: 'info' | 'members') => {
    if (!currentChannel) return;
    toggleJianSidebar(true);
    window.dispatchEvent(new CustomEvent(`codia-channel-focus-${section}`, {
      detail: { channelId: currentChannel },
    }));
  }, [currentChannel]);

  const handleInfoFocus = useCallback(() => {
    focusWorkspaceSection('info');
  }, [focusWorkspaceSection]);

  const handleCreateAgent = useCallback(() => {
    if (!currentChannel) return;
    toggleJianSidebar(true);
    window.dispatchEvent(new CustomEvent('codia-channel-open-agent-create', {
      detail: { channelId: currentChannel },
    }));
    window.dispatchEvent(new CustomEvent('codia-channel-focus-members', {
      detail: { channelId: currentChannel },
    }));
  }, [currentChannel]);

  const handleAddMember = useCallback((e: React.MouseEvent) => {
    if (!currentChannel) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const addItems: ContextMenuItem[] = availableAgents.length > 0
      ? availableAgents.map((agent): ContextMenuItem => ({
        label: agent.name || agent.id,
        disabled: busyMemberId === agent.id,
        action: () => {
          setBusyMemberId(agent.id);
          addChannelMember(currentChannel, agent.id)
            .then(() => {
              addToast(t('channel.memberAdded', { name: agent.name || agent.id }), 'success', 2200);
              focusWorkspaceSection('members');
            })
            .catch((err) => {
              addToast(`${t('channel.addMemberFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
            })
            .finally(() => setBusyMemberId(null));
        },
      }))
      : [{ label: t('channel.noAvailableMembers'), disabled: true }];
    const removeItems: ContextMenuItem[] = channelMemberAgents.length > 0
      ? channelMemberAgents.map((agent): ContextMenuItem => ({
        label: `${t('channel.removeMember')}: ${agent.name}`,
        danger: true,
        disabled: busyMemberId === agent.id,
        action: () => {
          if (!confirm(t('channel.removeMemberConfirm', { name: agent.name }))) return;
          setBusyMemberId(agent.id);
          removeChannelMember(currentChannel, agent.id)
            .then(() => {
              addToast(`${agent.name} 已移出频道`, 'success', 2200);
              focusWorkspaceSection('members');
            })
            .catch((err) => {
              addToast(`${t('channel.removeMemberFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
            })
            .finally(() => setBusyMemberId(null));
        },
      }))
      : [];
    setMenuItems([
      ...addItems,
      ...(removeItems.length > 0 ? [{ divider: true } as ContextMenuItem, ...removeItems] : []),
      { divider: true },
      {
        label: t('channel.createAgent'),
        action: handleCreateAgent,
      },
    ]);
    setMenuPos({ x: rect.left, y: rect.bottom + 4 });
  }, [addToast, availableAgents, busyMemberId, channelMemberAgents, currentChannel, focusWorkspaceSection, handleCreateAgent, t]);

  const handleMenu = useCallback((e: React.MouseEvent) => {
    if (!currentChannel) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuItems([
      {
        label: t('channel.deleteChannel'),
        danger: true,
        action: () => confirmDeleteChannel(currentChannel),
      },
    ]);
    setMenuPos({ x: rect.left, y: rect.bottom + 4 });
  }, [currentChannel, t]);

  const handleCloseMenu = useCallback(() => {
    setMenuPos(null);
  }, []);

  useEffect(() => {
    const openWorkflow = () => setWorkflowOpen(true);
    window.addEventListener('codia-open-channel-workflow', openWorkflow);
    return () => window.removeEventListener('codia-open-channel-workflow', openWorkflow);
  }, []);

  useEffect(() => {
    if (!currentChannel || isDM) return;
    if (pendingChannelResourceAction?.target !== 'workflow') return;
    if (pendingChannelResourceAction.channelId !== currentChannel) return;
    setWorkflowOpen(true);
  }, [currentChannel, isDM, pendingChannelResourceAction]);

  useEffect(() => {
    if (!currentChannel || isDM) return undefined;
    const handleWorkflowResource = (event: Event) => {
      const detail = (event as CustomEvent<{ channelId?: string }>).detail || {};
      if (detail.channelId && detail.channelId !== currentChannel) return;
      setWorkflowOpen(true);
    };
    window.addEventListener('codia-channel-workflow-add-resource', handleWorkflowResource);
    return () => window.removeEventListener('codia-channel-workflow-add-resource', handleWorkflowResource);
  }, [currentChannel, isDM]);

  return (
    <div className={styles.channelHeader}>
      <div className={styles.channelHeaderInfo}>
        <span className={styles.channelHeaderName}>{headerName}</span>
        <span className={styles.channelHeaderMembers}>{headerMembers}</span>
      </div>
      <div className={styles.channelHeaderActions}>
        {currentChannel && !isDM && (
          <button type="button"
            className={styles.channelHeaderActionBtn}
            title="工作流图"
            aria-label="工作流图"
            onClick={() => setWorkflowOpen(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="6" height="5" rx="1"></rect>
              <rect x="15" y="4" width="6" height="5" rx="1"></rect>
              <rect x="9" y="15" width="6" height="5" rx="1"></rect>
              <path d="M9 6.5h6"></path>
              <path d="M18 9v2a2 2 0 0 1-2 2h-4v2"></path>
              <path d="M6 9v2a2 2 0 0 0 2 2h4v2"></path>
            </svg>
          </button>
        )}
        {currentChannel && !isDM && (
          <button type="button"
            className={styles.channelHeaderActionBtn}
            title={t('channel.addMember')}
            onClick={handleAddMember}
            disabled={!!busyMemberId}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <line x1="19" y1="8" x2="19" y2="14"></line>
              <line x1="16" y1="11" x2="22" y2="11"></line>
            </svg>
          </button>
        )}
        {currentChannel && (
          <button type="button"
            className={styles.channelHeaderActionBtn}
            title={t('channel.info')}
            onClick={handleInfoFocus}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </button>
        )}
        {currentChannel && !isDM && (
          <button type="button"
            className={styles.channelHeaderActionBtn}
            title={t('common.more')}
            onClick={handleMenu}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="5" r="1"></circle>
              <circle cx="12" cy="12" r="1"></circle>
              <circle cx="12" cy="19" r="1"></circle>
            </svg>
          </button>
        )}
      </div>
      {menuPos && (
        <ContextMenu items={menuItems} position={menuPos} onClose={handleCloseMenu} />
      )}
      <ChannelWorkflowWindow open={workflowOpen} onClose={() => setWorkflowOpen(false)} />
    </div>
  );
}
