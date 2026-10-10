import { useCallback, useMemo } from 'react';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import { DEFAULT_THINKING_LEVELS, normalizeThinkingLevel, normalizeThinkingLevels, type ThinkingLevel } from '../../stores/model-slice';
import { SelectWidget, type SelectOption } from '../../ui';
import styles from './InputArea.module.css';

const THINKING_LEVEL_COPY: Record<ThinkingLevel, { label: string; description: string }> = {
  off: { label: '关闭', description: '不推理' },
  auto: { label: '中等', description: '模型决定深度' },
  low: { label: '轻量', description: '轻量推理' },
  medium: { label: '中等', description: '中等推理' },
  high: { label: '深度', description: '深度推理' },
  xhigh: { label: '极限', description: '极限推理' },
  max: { label: '极限', description: '极限推理' },
};

export function ThinkingLevelButton({ level, onChange, availableLevels }: {
  level: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  availableLevels?: readonly ThinkingLevel[];
}) {
  const { t } = useI18n();
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const activeLevel = normalizeThinkingLevel(level);

  const normalizedAvailableLevels = useMemo(
    () => normalizeThinkingLevels(availableLevels) ?? DEFAULT_THINKING_LEVELS,
    [availableLevels],
  );

  const selectLevel = useCallback(async (next: ThinkingLevel) => {
    try {
      const useSessionThinking = !!currentSessionPath && !pendingNewSession;
      if (!useSessionThinking) {
        const res = await codiaFetch('/api/session-thinking-level', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: next }),
        });
        const data = await res.json();
        if (!res.ok || data?.ok === false) {
          throw new Error(data?.error || 'failed to save thinking level');
        }
        const normalized = normalizeThinkingLevel((data?.thinkingLevel || next) as ThinkingLevel);
        useStore.getState().setPendingNewSessionThinkingLevel(normalized);
        onChange(normalized);
        return;
      }
      const res = await codiaFetch('/api/session-thinking-level', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath: currentSessionPath, level: next }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || 'failed to save thinking level');
      }
      onChange(normalizeThinkingLevel((data?.thinkingLevel || next) as ThinkingLevel));
    } catch (err) {
      console.error('[thinking-level] save failed:', err);
    }
  }, [currentSessionPath, onChange, pendingNewSession]);

  const tLevel = (key: string, fallback: string) => {
    const v = t(key);
    return v !== key ? v : fallback;
  };

  const isOff = activeLevel === 'off';
  const options: SelectOption[] = normalizedAvailableLevels.map(lv => {
    const copy = THINKING_LEVEL_COPY[lv];
    return {
      value: lv,
      label: tLevel(`input.thinkingLevel.${lv}`, copy.label),
      description: tLevel(`input.thinkingDesc.${lv}`, copy.description),
    };
  });

  return (
    <SelectWidget
      className={styles['thinking-selector']}
      options={options}
      value={activeLevel}
      onChange={(v) => selectLevel(v as ThinkingLevel)}
      align="end"
      placement="top"
      offset={4}
      popupMinWidth={180}
      triggerBare
      triggerClassName={`${styles['thinking-pill']}${isOff ? '' : ` ${styles.active}`}`}
      renderTrigger={() => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5" />
          {isOff && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="1.5" />}
        </svg>
      )}
    />
  );
}
