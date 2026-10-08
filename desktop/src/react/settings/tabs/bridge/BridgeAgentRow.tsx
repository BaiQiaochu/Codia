import React, { useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { gsapUrl, yuanFallbackAvatar } from '../../api';

interface BridgeAgentRowProps {
  value: string | null;
  onChange: (agentId: string) => void;
}

export function BridgeAgentRow({ value, onChange }: BridgeAgentRowProps) {
  const agents = useSettingsStore((s) => s.agents);
  const tsRef = useRef(Date.now());
  const ts = tsRef.current;
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!value) return;
    const el = scrollerRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const item = el.querySelector(`[data-agent-id="${value}"]`) as HTMLElement | null;
    if (!item) return;
    const containerRect = el.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const visibleLeft = itemRect.left - containerRect.left + el.scrollLeft;
    const visibleRight = visibleLeft + itemRect.width;
    if (visibleLeft < el.scrollLeft || visibleRight > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = visibleLeft - (el.clientWidth - itemRect.width) / 2;
    }
  }, [value]);

  return (
    <div className="bridge-agent-row-scroller" ref={scrollerRef}>
      <div className="bridge-agent-row-list">
        {agents.map((agent) => {
          const selected = agent.id === value;
          const fallback = yuanFallbackAvatar(agent.yuan || 'gsap');
          return (
            <button
              key={agent.id}
              type="button"
              data-agent-id={agent.id}
              className={`bridge-agent-row-item${selected ? ' selected' : ''}`}
              onClick={() => onChange(agent.id)}
            >
              <div className="bridge-agent-row-avatar-wrap">
                <img
                  className="bridge-agent-row-avatar"
                  draggable={false}
                  src={agent.hasAvatar ? gsapUrl(`/api/agents/${agent.id}/avatar?t=${ts}`, { includeTokenQuery: true }) : fallback}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    img.onerror = null;
                    img.src = fallback;
                  }}
                />
              </div>
              <span className="bridge-agent-row-name">{agent.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
