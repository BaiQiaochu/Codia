import React from 'react';
import { yuanFallbackAvatar } from '../../api';
import { t } from '../../helpers';

import originalBackgroundUrl from '../../../../assets/codia-original-background.jpg';

export function YuanSelector({ currentYuan, onChange }: { currentYuan: string; onChange: (key: string) => void }) {
  const types = t('yuan.types') || {};
  const entries = Object.entries(types) as [string, { name?: string; label?: string; avatar?: string }][];
  const hIdx = entries.findIndex(([k]) => k === 'codia');
  if (hIdx >= 0 && entries.length >= 3) {
    const [h] = entries.splice(hIdx, 1);
    entries.splice(1, 0, h);
  }

  const chips = entries.filter(([k]) => k !== 'kong' && k !== 'hermes');
  const kongMeta = (types as Record<string, { name?: string; label?: string }>).kong;
  const defaultAvatar = yuanFallbackAvatar('codia');

  return (
    <div className="yuan-selector">
      <div className="yuan-chips">
        {chips.map(([key, meta]) => (
          <button
            key={key}
            className={`yuan-chip${key === currentYuan ? ' selected' : ''}`}
            type="button"
            onClick={() => { if (key !== currentYuan) onChange(key); }}
          >
            <img
              className="yuan-chip-avatar"
              src={yuanFallbackAvatar(key)}
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                img.onerror = null;
                img.src = defaultAvatar;
              }}
              draggable={false}
            />
            <div className="yuan-chip-info">
              <span className="yuan-chip-name">{meta.name || key}</span>
              <span className="yuan-chip-desc">{meta.label || ''}</span>
            </div>
          </button>
        ))}
      </div>
      {kongMeta && (
        <button
          className={`yuan-kong-banner${currentYuan === 'kong' ? ' selected' : ''}`}
          type="button"
          style={{ backgroundImage: `url(${originalBackgroundUrl})` }}
          onClick={() => { if (currentYuan !== 'kong') onChange('kong'); }}
        >
          <span className="yuan-kong-name">{kongMeta.name || 'kong'}</span>
          <span className="yuan-kong-desc">{kongMeta.label || ''}</span>
        </button>
      )}
    </div>
  );
}
