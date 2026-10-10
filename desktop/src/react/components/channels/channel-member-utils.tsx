import { useState } from 'react';
import type { Agent } from '../../types';
import { codiaUrl } from '../../hooks/use-codia-fetch';
import { yuanFallbackAvatar } from '../../utils/agent-helpers';

let _avatarTs = Date.now();
export function refreshAvatarTs() { _avatarTs = Date.now(); }

export interface MemberInfo {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  fallbackAvatar: string | null;
  yuan?: string;
  isUser: boolean;
}

export function buildAgentMap(agents: Agent[]): Map<string, Agent> {
  const m = new Map<string, Agent>();
  for (const a of agents) {
    m.set(a.id, a);
    if (a.name) m.set(a.name, a);
  }
  return m;
}

export function resolveChannelMember(
  memberId: string,
  userName: string,
  userAvatarUrl: string | null,
  agents: Agent[],
  currentAgentId: string | null,
  agentMap?: Map<string, Agent>,
): MemberInfo {
  if (memberId === 'user' || memberId === userName) {
    return {
      id: memberId,
      displayName: userName || 'user',
      avatarUrl: userAvatarUrl,
      fallbackAvatar: null,
      isUser: true,
    };
  }
  const agent = agentMap ? agentMap.get(memberId) : agents.find((a) => a.id === memberId || a.name === memberId);
  if (agent) {
    return {
      id: memberId,
      displayName: agent.name || agent.id,
      avatarUrl: agent.hasAvatar ? codiaUrl(`/api/agents/${agent.id}/avatar?t=${_avatarTs}`, { includeTokenQuery: true }) : null,
      fallbackAvatar: yuanFallbackAvatar(agent.yuan),
      yuan: agent.yuan,
      isUser: false,
    };
  }
  return {
    id: memberId,
    displayName: memberId,
    avatarUrl: null,
    fallbackAvatar: null,
    isUser: false,
  };
}

export function formatChannelTime(timestamp: string): string {
  if (!timestamp) return '';
  const parts = timestamp.split(' ');
  if (parts.length < 2) return timestamp;

  const today = new Date();
  const [y, mo, d] = parts[0].split('-').map(Number);
  const t = window.t;

  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate()) {
    return parts[1];
  }
  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate() - 1) {
    return t('time.yesterday');
  }
  return `${mo}/${d}`;
}

export function MemberAvatar({ info, className }: { info: MemberInfo; className?: string }) {
  const [imgError, setImgError] = useState(false);

  if (info.avatarUrl && !imgError) {
    return (
      <img
        className={className}
        src={info.avatarUrl}
        onError={() => setImgError(true)}
      />
    );
  }
  if (imgError && info.fallbackAvatar) {
    return <img className={className} src={info.fallbackAvatar} />;
  }
  return <>{(info.displayName || '?').charAt(0).toUpperCase()}</>;
}
