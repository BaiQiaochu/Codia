import { useMemo, useEffect, useState } from 'react';
import { gsapFetch } from './use-gsap-fetch';
import { useStore } from '../stores';
import { getSkillIcon } from '../utils/skill-icons';
import type { SlashItem } from '../components/input/slash-commands';

interface SkillInfo {
  name: string;
  description: string;
  filePath?: string;
  baseDir?: string;
  hidden: boolean;
  enabled: boolean;
}

/**
 * Fetch enabled, visible skills for the target agent.
 * Returns a stable array that only updates when skills change.
 */
export function useSkillSlashItems({
  enabled = true,
  agentId: explicitAgentId = null,
}: { enabled?: boolean; agentId?: string | null } = {}): SlashItem[] {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agentId = explicitAgentId || currentAgentId;

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ agentId?: string | null }>).detail || {};
      if (!detail.agentId || detail.agentId === agentId) {
        setRefreshSeq(seq => seq + 1);
      }
    };
    window.addEventListener('gsap-skills-changed', handler);
    return () => window.removeEventListener('gsap-skills-changed', handler);
  }, [agentId]);

  useEffect(() => {
    if (!enabled) {
      setSkills([]);
      return;
    }
    if (!agentId) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    setSkills([]);
    gsapFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data.skills) setSkills(data.skills);
      })
      .catch(() => {});
    return () => { cancelled = true; };
 //
  }, [agentId, enabled, refreshSeq]);

  return useMemo(() =>
    skills
      .filter(s => s.enabled && !s.hidden)
      .map(s => ({
        name: s.name,
        label: `/${s.name}`,
        description: s.description || '',
        busyLabel: '',
        icon: getSkillIcon(s.name),
        type: 'skill' as const,
        filePath: s.filePath,
        baseDir: s.baseDir,
        execute: () => {},  // placeholder, actual insertion handled by InputArea
      })),
    [skills],
  );
}
