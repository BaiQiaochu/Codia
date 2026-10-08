import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { gsapFetch, yuanFallbackAvatar } from '../api';
import { t } from '../helpers';
import { switchToAgent } from '../actions';
import { getErrorMessage } from '../shared-types';
import styles from '../Settings.module.css';

const platform = window.platform;

export function AgentCreateOverlay() {
  const { showToast, homeFolder } = useSettingsStore();
  const [visible, setVisible] = useState(false);
  const [name, setName] = useState('');
  const [yuan, setYuan] = useState('gsap');
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = () => {
      setName('');
      setYuan('gsap');
      setVisible(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener('gsap-show-agent-create', handler);
    return () => window.removeEventListener('gsap-show-agent-create', handler);
  }, []);

  const close = useCallback(() => {
    setVisible(false);
  }, []);

  const create = async () => {
    if (creating) return;
    const trimmed = name.trim();
    if (!trimmed) { showToast(t('settings.agent.nameRequired'), 'error'); return; }

    setCreating(true);
    try {
      const res = await gsapFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          yuan,
          ...(homeFolder ? { homeFolder } : {}),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await switchToAgent(data.id);
      close();
      showToast(t('settings.agent.created', { name: data.name }), 'success');
      platform?.settingsChanged?.('agent-created', { agentId: data.id, name: data.name });
    } catch (err: unknown) {
      showToast(t('settings.agent.createFailed') + ': ' + getErrorMessage(err), 'error');
    } finally {
      setCreating(false);
    }
  };

  if (!visible) return null;

  const types = t<Record<string, { avatar?: string; label?: string; name?: string }>>('yuan.types') || {};
  const entries = Object.entries(types) as [string, { avatar?: string; label?: string; name?: string }][];
  const defaultAvatar = yuanFallbackAvatar('gsap');

  return (
    <div className={`${styles['agent-create-overlay']} ${styles['visible']}`} onClick={(e) => { if (e.target === e.currentTarget && !creating) close(); }}>
      <div className={styles['agent-create-card']}>
        <h3 className={styles['agent-create-title']}>{t('settings.agent.createTitle')}</h3>
        <div className={styles['settings-field']}>
          <input
            ref={inputRef}
            className={styles['settings-input']}
            type="text"
            placeholder={t('settings.agent.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); create(); }
              if (e.key === 'Escape' && !creating) close();
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          <div className="yuan-selector">
            <div className="yuan-chips">
              {entries.map(([key, meta]) => (
                <button
                  key={key}
                  className={`yuan-chip${key === yuan ? ' selected' : ''}`}
                  type="button"
                  disabled={creating}
                  onClick={() => setYuan(key)}
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
          </div>
        </div>
        <div className={styles['agent-create-actions']}>
          <button type="button" className={styles['agent-create-cancel']} onClick={close} disabled={creating}>{t('settings.agent.cancel')}</button>
          <button type="button" className={styles['agent-create-confirm']} onClick={create} disabled={creating}>
            {creating ? t('settings.agent.creating') : t('settings.agent.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
