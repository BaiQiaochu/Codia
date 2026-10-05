import React, { useState } from 'react';
import { useSettingsStore } from '../../store';
import { t, autoSaveConfig, savePins } from '../../helpers';
import { gsapFetch } from '../../api';
import { PinItem } from './AgentPins';
import { SettingsSection } from '../../components/SettingsSection';
import { Toggle } from '../../widgets/Toggle';
import styles from '../../Settings.module.css';

type TranslationParams = Record<string, string | number>;
type MemoryHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'disabled' | 'unavailable';

type MemoryStepHealth = {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  failCount: number;
};

type MemoryHealthPayload = {
  agentId: string;
  status: MemoryHealthStatus;
  reason: string | null;
  enabled: boolean;
  steps: Record<string, MemoryStepHealth>;
  failedSteps: string[];
  maxFailCount: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
};

const memoryFallbacks: Record<string, string> = {
  'settings.memory.health.healthy': '记忆整理正常',
  'settings.memory.health.degraded': '记忆整理有延迟',
  'settings.memory.health.unhealthy': '记忆整理异常',
  'settings.memory.health.disabled': '记忆已关闭',
  'settings.memory.health.unavailable': '记忆健康状态不可用',
  'settings.memory.health.failedSteps': '异常步骤：{steps}',
  'settings.memory.health.lastError': '最近错误：{time}',
  'settings.memory.health.errorMessage': '错误：{message}',
  'settings.memory.health.stepSeparator': '、',
  'settings.memory.health.steps.rollingSummary': '滚动摘要',
  'settings.memory.health.steps.compileToday': '今日记忆',
  'settings.memory.health.steps.compileWeek': '本周记忆',
  'settings.memory.health.steps.compileLongterm': '长期记忆',
  'settings.memory.health.steps.compileFacts': '事实整理',
  'settings.memory.health.steps.deepMemory': '深层记忆',
};

const healthToneByStatus: Record<MemoryHealthStatus, string> = {
  healthy: 'ok',
  degraded: 'attention',
  unhealthy: 'error',
  disabled: 'muted',
  unavailable: 'muted',
};

function interpolate(value: string, params?: TranslationParams): string {
  if (!params) return value;
  return value.replace(/\{([^}]+)\}/g, (match, key) => String(params[key] ?? match));
}

function tx(key: string, fallback?: string, params?: TranslationParams): string {
  const value = t(key, params);
  const resolved = value === key ? (fallback ?? memoryFallbacks[key] ?? key) : value;
  return interpolate(resolved, params);
}

function formatHealthTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function memoryStepLabel(step: string): string {
  return tx(`settings.memory.health.steps.${step}`, step);
}

function formatFailedStepLabels(steps: string[]): string {
  const labels = steps.map(memoryStepLabel);
  if (labels.length <= 1) return labels[0] || '';
  return labels.join(tx('settings.memory.health.stepSeparator', '、'));
}

function pickLastErrorMessage(health: MemoryHealthPayload): string | null {
  for (const step of health.failedSteps) {
    const message = health.steps[step]?.lastErrorMsg;
    if (message) return message;
  }
  return null;
}

function compactMemoryHealthMessage(value: string | null): string | null {
  if (!value) return null;
  const compacted = value
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, '[local session]')
    .replace(/\/[^\s"'<>]+\/[^\s"'<>]+/g, '[local session]')
    .replace(/\s+/g, ' ')
    .trim();
  return compacted.length > 180 ? `${compacted.slice(0, 177)}...` : compacted;
}

function MemoryHealthNotice({ health, error }: {
  health: MemoryHealthPayload | null;
  error: string | null;
}) {
  if (!error && (!health || health.status === 'healthy')) return null;

  const status: MemoryHealthStatus = error ? 'unavailable' : (health?.status || 'unavailable');
  const tone = healthToneByStatus[status];
  const failedStepLabels = health ? formatFailedStepLabels(health.failedSteps) : '';
  const lastErrorAt = formatHealthTime(health?.lastErrorAt || null);
  const lastErrorMessage = compactMemoryHealthMessage(health ? pickLastErrorMessage(health) : error);

  return (
    <div className={`${styles['memory-health-strip']} ${styles[`memory-health-${tone}`]}`} role="status">
      <div className={styles['memory-health-main']}>
        <span className={styles['memory-health-dot']} />
        <span className={styles['memory-health-title']}>{tx(`settings.memory.health.${status}`)}</span>
      </div>
      <div className={styles['memory-health-detail']}>
        {failedStepLabels && (
          <span>{tx('settings.memory.health.failedSteps', undefined, { steps: failedStepLabels })}</span>
        )}
        {lastErrorAt && (
          <span>{tx('settings.memory.health.lastError', undefined, { time: lastErrorAt })}</span>
        )}
        {lastErrorMessage && (
          <span>{tx('settings.memory.health.errorMessage', undefined, { message: lastErrorMessage })}</span>
        )}
      </div>
    </div>
  );
}

export function MemorySection({ agentId, hasUtilityModel, memoryEnabled, currentPins }: {
  agentId: string | null;
  hasUtilityModel: boolean;
  memoryEnabled: boolean;
  currentPins: string[];
}) {
  const [pinInput, setPinInput] = useState('');
  const [health, setHealth] = useState<MemoryHealthPayload | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  React.useEffect(() => {
    if (!agentId || !hasUtilityModel || !memoryEnabled) {
      setHealth(null);
      setHealthError(null);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setHealthError(null);

    gsapFetch(`/api/memories/health?agentId=${encodeURIComponent(agentId)}`, {
      signal: controller.signal,
      timeout: 10_000,
    })
      .then((res) => res.json())
      .then((data: MemoryHealthPayload) => {
        if (!active) return;
        setHealth(data);
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setHealth(null);
        setHealthError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [agentId, hasUtilityModel, memoryEnabled]);

  const addPin = () => {
    const val = pinInput.trim();
    if (!val) return;
    const newPins = [...currentPins, val];
    useSettingsStore.setState({ currentPins: newPins });
    setPinInput('');
    savePins();
  };

  const deletePin = (index: number) => {
    const newPins = [...currentPins];
    newPins.splice(index, 1);
    useSettingsStore.setState({ currentPins: newPins });
    savePins();
  };

  const memoryToggle = (
    <Toggle
      on={hasUtilityModel ? memoryEnabled : false}
      onChange={(enabled) => {
        if (hasUtilityModel) autoSaveConfig({ memory: { enabled } });
      }}
      disabled={!hasUtilityModel}
      title={!hasUtilityModel ? t('settings.memory.needsUtilityModel') : undefined}
    />
  );

  return (
    <SettingsSection
      title={t('settings.memory.sectionTitle')}
      context={memoryToggle}
      className={styles['memory-settings-section']}
    >
      {!hasUtilityModel && (
        <p className={styles['settings-inline-note']} style={{ opacity: 0.6, marginTop: 0, marginBottom: 'var(--space-md)' }}>
          {t('settings.memory.needsUtilityModel')}
        </p>
      )}

      <div className={`${styles['memory-settings-content']} ${!hasUtilityModel || !memoryEnabled ? 'settings-disabled' : ''}`}>
        <MemoryHealthNotice health={health} error={healthError} />

      <div className={styles['settings-subsection']}>
        <div className={styles['settings-subsection-header']}>
          <h3 className={styles['settings-subsection-title']}>{t('settings.pins.title')}</h3>
          <span className={styles['settings-subsection-hint']}>{t('settings.pins.hint')}</span>
        </div>
        <div className={styles['pin-list']}>
          {currentPins.length === 0 ? (
            <div className={styles['pin-empty']}>{t('settings.pins.empty')}</div>
          ) : (
            currentPins.map((pin, i) => (
              <PinItem key={pin} text={pin} index={i} onDelete={deletePin} />
            ))
          )}
        </div>
        <div className={styles['pin-add-row']}>
          <input
            className={`${styles['settings-input']} ${styles['pin-add-input']}`}
            type="text"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPin(); } }}
            placeholder={t('settings.pins.addPlaceholder')}
          />
          <button type="button" className={styles['pin-add-btn']} onClick={addPin}>+</button>
        </div>
      </div>

      <div className={styles['settings-subsection']}>
        <div className={styles['settings-subsection-header']}>
          <h3 className={styles['settings-subsection-title']}>{t('settings.memory.compiled')}</h3>
          <span className={styles['settings-subsection-hint']}>{t('settings.memory.compiledHint')}</span>
        </div>
        <button type="button"
          className={`${styles['memory-action-btn']} ${styles['compiled-view-btn']}`}
          onClick={() => window.dispatchEvent(new Event('gsap-view-compiled-memory'))}
        >
          {t('settings.memory.compiledView')}
        </button>
      </div>

      <div className={styles['settings-subsection']}>
        <h3 className={styles['settings-subsection-title']}>{t('settings.memory.allMemories')}</h3>
        <div className={`${styles['memory-actions-row']} ${styles['memory-actions-spaced']}`}>
          <button type="button"
            className={styles['memory-action-btn']}
            onClick={() => window.dispatchEvent(new Event('gsap-view-memories'))}
          >
            {t('settings.memory.actions.view')}
          </button>
          <button type="button"
            className={`${styles['memory-action-btn']} ${styles['danger']}`}
            onClick={() => window.dispatchEvent(new Event('gsap-show-clear-confirm'))}
          >
            {t('settings.memory.actions.clear')}
          </button>
        </div>
      </div>

      </div>{/* settings-disabled wrapper */}
    </SettingsSection>
  );
}
