/**
 * DeskSkillsSection renders the collapsible desk skill shortcut list.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import { skillDisplayName } from '../../utils/skill-display';
import s from './Desk.module.css';

const DESK_SKILLS_KEY = 'codia-desk-skills-collapsed';

export function DeskSkillsSection() {
  const skills = useStore(s => s.deskSkills);
  const currentAgentId = useStore(s => s.currentAgentId);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(DESK_SKILLS_KEY) === '1',
  );

  const loadDeskSkillsFn = useCallback(async () => {
    try {
      const snapshot = useStore.getState();
      const agentId = snapshot.currentAgentId;
      if (!agentId) return;
      // Use a request snapshot so stale responses cannot overwrite newer sessions.
      const requestAgentId = agentId;
      const requestSessionPath = snapshot.currentSessionPath || null;

      const res = await codiaFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`);
      const data = await res.json();
      if (data.error) return;

      const now = useStore.getState();
      if (now.currentAgentId !== requestAgentId) return;
      if ((now.currentSessionPath || null) !== requestSessionPath) return;

      const all = (data.skills || []) as Array<{
        name: string; enabled: boolean; hidden?: boolean;
        displayName?: string; displayNames?: Record<string, string>;
        source?: string; externalLabel?: string | null; managedBy?: string | null;
      }>;
      now.setDeskSkills(
        all.filter(s => !s.hidden).map(s => ({
          name: s.name,
          displayName: s.displayName,
          displayNames: s.displayNames,
          enabled: s.enabled,
          source: s.source,
          externalLabel: s.externalLabel,
          managedBy: s.managedBy,
        })),
      );
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadDeskSkillsFn();
    window.__loadDeskSkills = loadDeskSkillsFn;
    return () => { delete window.__loadDeskSkills; };
  }, [loadDeskSkillsFn, currentAgentId, currentSessionPath]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(DESK_SKILLS_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const toggleSkill = useCallback(async (name: string, enable: boolean) => {
    const snapshot = useStore.getState();
    const prev = snapshot.deskSkills;
    const agentId = snapshot.currentAgentId || '';
    if (!agentId) return;
    const target = prev.find(s => s.name === name);
    if (target?.managedBy === 'workspace') return;

    const requestAgentId = agentId;
    const requestSessionPath = snapshot.currentSessionPath || null;
    const sessionUnchanged = () => {
      const now = useStore.getState();
      return now.currentAgentId === requestAgentId
        && (now.currentSessionPath || null) === requestSessionPath;
    };

    // Optimistic update.
    snapshot.setDeskSkills(
      prev.map(s => s.name === name ? { ...s, enabled: enable } : s),
    );

    try {
      // Re-fetch the current agent skill list before writing the enabled set.
      const freshRes = await codiaFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`);
      const freshData = await freshRes.json();
      if (freshData.error) throw new Error(freshData.error);
      if (!sessionUnchanged()) return;
      const freshSkills = (freshData.skills || []) as Array<{ name: string; enabled: boolean; managedBy?: string | null }>;
      const enabledList = freshSkills
        .map(s => s.name === name ? { ...s, enabled: enable } : s)
        .filter(s => s.enabled && s.managedBy !== 'workspace')
        .map(s => s.name);

      await codiaFetch(`/api/agents/${agentId}/skills`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabledList }),
      });
    } catch {
      if (sessionUnchanged()) {
        useStore.getState().setDeskSkills(prev);
      }
    }
  }, []);

  const enabledCount = skills.filter(s => s.enabled).length;
  const t = window.t ?? ((p: string) => p);

  if (skills.length === 0) return null;

  return (
    <div className={s.skillsSection}>
      <button type="button" className={s.skillsHeader} onClick={toggleCollapse}>
        <span>{t('desk.skills')}</span>
        <span className={s.skillsCount}>{enabledCount}</span>
        <svg
          className={`${s.skillsChevron}${collapsed ? '' : ` ${s.skillsChevronOpen}`}`}
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {!collapsed && (
        <div className={s.skillsList}>
          {skills.map(sk => (
            <div className={s.skillItem} key={sk.name}>
              <span className={s.skillName}>{skillDisplayName(sk, window.i18n?.locale || 'zh-CN')}</span>
              {sk.externalLabel && (
                <span className={s.skillSource}>{sk.externalLabel}</span>
              )}
              <button
                type="button"
                className={`codia-toggle mini${sk.enabled ? ' on' : ''}`}
                disabled={sk.managedBy === 'workspace'}
                onClick={() => toggleSkill(sk.name, !sk.enabled)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
